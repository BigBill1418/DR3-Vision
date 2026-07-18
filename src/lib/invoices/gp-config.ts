// ADR-0041 amendment §4.2 — DB reads for the GP export context + the mode flip.
//
// Assembles the `GpExportContext` (site name + resolved GP identifiers) the v2
// export consumes, from the singleton `gp_billing_config` (company statics) and
// the per-site `gp_site_billing_config` (Customer ID + PO suffix; nulls are
// honest pending-Mary unknowns). Also the admin mode-flip write.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { buildGpContext } from './gp-identifiers';
import type { GpExportContext } from './export-json';
import type { InvoiceKind, InvoiceMode } from './types';
import type { InvoiceView } from './view';

/** A GP export was requested but the company-wide statics were never seeded. */
export class GpBillingConfigMissingError extends Error {
  readonly status = 409 as const;
  constructor() {
    super(
      'gp_billing_config singleton is not seeded — the v2 GP export needs the ' +
        'Bill-To / Sales ID / Payment Terms row (run the seed or set it in admin)',
    );
    this.name = 'GpBillingConfigMissingError';
  }
}

/**
 * Build the v2 GP export context for a stored invoice. Throws
 * {@link GpBillingConfigMissingError} when the company statics are absent (a GP
 * export with no Bill-To is a defect, not a blank field). Per-site identifiers
 * default to honest nulls (pending Mary) when no site row exists.
 */
export async function resolveGpExportContext(invoice: InvoiceView): Promise<GpExportContext> {
  const [statics, site, siteRow] = await Promise.all([
    prisma.gpBillingConfig.findUnique({ where: { id: 'singleton' } }),
    prisma.gpSiteBillingConfig.findUnique({ where: { site_id: invoice.siteId } }),
    prisma.site.findUnique({ where: { id: invoice.siteId }, select: { name: true } }),
  ]);
  if (!statics) throw new GpBillingConfigMissingError();

  const gp = buildGpContext({
    statics: {
      billTo: {
        name: statics.bill_to_name,
        attn: statics.bill_to_attn,
        street: statics.bill_to_street,
        locality: statics.bill_to_locality,
      },
      salesId: statics.sales_id,
      paymentTerms: statics.payment_terms,
    },
    site: {
      customerId: site?.customer_id ?? null,
      poSiteSuffix: site?.po_site_suffix ?? null,
      pendingNote: site?.pending_note ?? null,
    },
    // §4.2 — the invoice date used for the PO + header line is the window end
    // (EOM, or the 15th for mid-month). Flagged for Mary to confirm.
    invoiceDate: invoice.windowEnd,
  });

  return { siteName: siteRow?.name ?? invoice.siteId, gp };
}

export interface SetInvoiceModeArgs {
  siteId: string;
  kind: InvoiceKind;
  mode: InvoiceMode;
  actorUserId: string;
}

/**
 * Admin toggle (§3.4) — flip a (site, kind) between pilot and production. Upserts
 * the `invoice_mode_config` row and writes an audit trail. Graduating to
 * production is the deliberate, audited act that lets that (site, kind)'s FUTURE
 * invoices reach MRC; already-generated drafts keep the mode they were stamped
 * with until regenerated (immutability — a stamped invoice is never mutated).
 */
export async function setInvoiceMode(args: SetInvoiceModeArgs): Promise<InvoiceMode> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.invoiceModeConfig.findUnique({
      where: { site_id_kind: { site_id: args.siteId, kind: args.kind } },
      select: { mode: true },
    });
    await tx.invoiceModeConfig.upsert({
      where: { site_id_kind: { site_id: args.siteId, kind: args.kind } },
      create: {
        site_id: args.siteId,
        kind: args.kind,
        mode: args.mode,
        updated_by: args.actorUserId,
      },
      update: { mode: args.mode, updated_by: args.actorUserId },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: before ? 'update' : 'insert',
        table_name: 'invoice_mode_config',
        row_id: `${args.siteId}:${args.kind}`,
        ...(before ? { before: { mode: before.mode } } : {}),
        after: { site_id: args.siteId, kind: args.kind, mode: args.mode },
      },
    });
  });
  log.info(
    { op: 'invoice.set_mode', site_id: args.siteId, kind: args.kind, mode: args.mode },
    '[invoices] mode flipped',
  );
  return args.mode;
}
