// ADR-0041 — invoice service (DB orchestration for GENERATION + reads).
//
// Generation composes a DRAFT from the pure math (`generate.ts`) over resolved
// inputs (`generation-inputs.ts`) and persists it with its lines + an audit row
// in one transaction. Drafts regenerate freely: a new draft VOIDS the prior
// draft and takes the next version (D1). The gate + approval freeze live in
// `lifecycle.ts` — generation itself never blocks (a draft is a non-approvable
// preview). Every generation writes one structured D6 log line (window, line
// count, total). No PII lands in an invoice line or a log (D6).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { composeProcessing, composeTransportation, composeCollectionSiteCount } from './generate';
import {
  resolveProcessingInputs,
  resolveTransportationInputs,
  loadOrCountManualLines,
} from './generation-inputs';
import { windowForKind, billingMonthStartISO } from './periods';
import { dayKeyUTCFromISO } from '@/lib/time';
import {
  type InvoiceComposition,
  type InvoiceKind,
  type Jurisdiction,
  type ManualLine,
  PROCESSING_KINDS,
  TRANSPORTATION_KINDS,
  jurisdictionOfKind,
} from './types';
import { assertValidInvoiceCombination, compositionHasTradeDiscount } from './combinations';
import {
  assertTotalMatchesLines,
  toInvoiceView,
  type InvoiceListItem,
  type InvoiceView,
} from './view';
import { evaluateWindowGate, type WindowGateResult } from './gate';

const TABLE = 'invoices';

/** The kind's jurisdiction does not match the site (e.g. a CA invoice on Eugene). */
export class InvoiceKindSiteMismatchError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly kind: InvoiceKind,
    readonly siteJurisdiction: string,
  ) {
    super(`invoice kind ${kind} does not match site jurisdiction ${siteJurisdiction}`);
    this.name = 'InvoiceKindSiteMismatchError';
  }
}

const INVOICE_INCLUDE = { lines: true } satisfies Prisma.InvoiceInclude;

function isProcessingKind(kind: InvoiceKind): boolean {
  return PROCESSING_KINDS.includes(kind);
}
function isTransportationKind(kind: InvoiceKind): boolean {
  return TRANSPORTATION_KINDS.includes(kind);
}

/**
 * ADR-0041 amendment §3.4 — resolve the mode a new invoice is stamped with.
 * No `invoice_mode_config` row for the (site, kind) ⇒ `pilot` (the safe
 * default): a (site, kind) is on the pilot until an admin explicitly flips it
 * to `production`. This is the write-time half of the launch safety net; the
 * delivery-time half (`planInvoiceDelivery`) makes pilot structurally unable to
 * reach MRC regardless of how the row was produced.
 */
export async function resolveInvoiceMode(
  siteId: string,
  kind: InvoiceKind,
): Promise<'pilot' | 'production'> {
  const cfg = await prisma.invoiceModeConfig.findUnique({
    where: { site_id_kind: { site_id: siteId, kind } },
    select: { mode: true },
  });
  return cfg?.mode === 'production' ? 'production' : 'pilot';
}

/**
 * Assert the kind's jurisdiction matches the site and return that jurisdiction
 * (CA|OR) — the combination validator (§6) needs it. Throws
 * {@link InvoiceKindSiteMismatchError} on a jurisdiction mismatch.
 */
async function assertKindMatchesSite(siteId: string, kind: InvoiceKind): Promise<Jurisdiction> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { jurisdiction: true },
  });
  if (!site) throw new InvoiceKindSiteMismatchError(kind, 'unknown');
  const siteJur: Jurisdiction = site.jurisdiction === 'california' ? 'CA' : 'OR';
  if (jurisdictionOfKind(kind) !== siteJur) {
    throw new InvoiceKindSiteMismatchError(kind, site.jurisdiction);
  }
  return siteJur;
}

/** Compose the line set for a kind over its window (pure math + resolved inputs). */
async function composeForKind(args: {
  siteId: string;
  kind: InvoiceKind;
  billingMonthISO: string;
  windowStartISO: string;
  windowEndISO: string;
  manualLines: readonly ManualLine[];
}): Promise<InvoiceComposition> {
  const { siteId, kind, billingMonthISO, windowStartISO, windowEndISO } = args;
  if (isProcessingKind(kind)) {
    const input = await resolveProcessingInputs({
      siteId,
      kind: kind as 'ca_processing_mid_month' | 'ca_processing_eom' | 'or_processing_eom',
      billingMonthISO,
      windowStartISO,
      windowEndISO,
    });
    return composeProcessing(input);
  }
  if (isTransportationKind(kind)) {
    const input = await resolveTransportationInputs({
      siteId,
      kind: kind as 'ca_transportation_eom' | 'or_transportation_eom',
      billingMonthISO,
      windowStartISO,
      windowEndISO,
    });
    return composeTransportation(input);
  }
  // or_collection_site_count — STORED capture rows first (entered once on the
  // sibling's or-counts surface), any request-supplied manual lines appended.
  const storedLines = await loadOrCountManualLines(args.siteId, args.billingMonthISO);
  return composeCollectionSiteCount([...storedLines, ...args.manualLines]);
}

export interface GenerateDraftArgs {
  siteId: string;
  kind: InvoiceKind;
  /** Any day in the target month; normalized to first-of-month. */
  billingMonthISO: string;
  actorUserId: string;
  /** OR collection-site-count only; ignored for other kinds. */
  manualLines?: readonly ManualLine[];
  /** Set when this draft supersedes an approved invoice (new version chain). */
  supersedesId?: string;
  notes?: string;
}

/**
 * Generate (or regenerate) a DRAFT invoice. Composes the lines, voids any prior
 * draft in the (site, kind, month) chain, and persists at the next version with
 * an audit row — all in one transaction. Returns the full view.
 */
export async function generateInvoiceDraft(args: GenerateDraftArgs): Promise<InvoiceView> {
  const billingMonthISO = billingMonthStartISO(args.billingMonthISO);
  const siteJurisdiction = await assertKindMatchesSite(args.siteId, args.kind);

  const window = windowForKind(args.kind, billingMonthISO);
  const composition = await composeForKind({
    siteId: args.siteId,
    kind: args.kind,
    billingMonthISO,
    windowStartISO: window.startISO,
    windowEndISO: window.endISO,
    manualLines: args.manualLines ?? [],
  });

  // §6 — reject the structurally invalid combinations (Eugene mid-month; any
  // mid-month carrying a Trade discount) BEFORE persisting anything.
  assertValidInvoiceCombination({
    kind: args.kind,
    siteJurisdiction,
    hasTradeDiscount: compositionHasTradeDiscount(composition),
  });

  // Belt invariant: the total we are about to store MUST equal Σ lines (it does
  // by construction, but this is the write-time enforcement point).
  assertTotalMatchesLines('<new>', composition.totalCents, composition.lines);

  // Same tripwire philosophy for the denormalized trade discount (rollup §1.3):
  // when the composition carries it, it MUST mirror the stored offset line —
  // Mary's verify page derives gross from this column, so a silent disagreement
  // is wrong money on the surface built to be trusted.
  if (composition.tradeDiscountCents != null) {
    const offsetLine = composition.lines.find((l) => l.lineCode === 'B22.offset');
    if (!offsetLine || offsetLine.amountCents !== -composition.tradeDiscountCents) {
      throw new Error(
        `trade_discount_cents (${composition.tradeDiscountCents}¢) does not mirror the ` +
          `B22.offset line (${offsetLine?.amountCents ?? 'missing'}¢) — refusing to persist`,
      );
    }
  }

  const billingMonth = dayKeyUTCFromISO(billingMonthISO);
  const windowStart = dayKeyUTCFromISO(window.startISO);
  const windowEnd = dayKeyUTCFromISO(window.endISO);

  // §3.4 — stamp the mode the (site, kind) is configured for (pilot unless an
  // admin flipped it to production). A superseding reissue re-reads this, so a
  // (site, kind) graduated to production reissues in production and one still on
  // the pilot reissues in pilot — the safety net follows the config, not the
  // original draft.
  const mode = await resolveInvoiceMode(args.siteId, args.kind);

  const created = await prisma.$transaction(async (tx) => {
    // Void any prior draft(s) in this chain — a regenerate replaces, never edits.
    await tx.invoice.updateMany({
      where: {
        site_id: args.siteId,
        kind: args.kind,
        billing_month: billingMonth,
        status: 'draft',
      },
      data: { status: 'void', voided_by: args.actorUserId, voided_at: new Date() },
    });

    const max = await tx.invoice.aggregate({
      _max: { version: true },
      where: { site_id: args.siteId, kind: args.kind, billing_month: billingMonth },
    });
    const nextVersion = (max._max.version ?? 0) + 1;

    const invoice = await tx.invoice.create({
      data: {
        site_id: args.siteId,
        kind: args.kind,
        billing_month: billingMonth,
        window_start: windowStart,
        window_end: windowEnd,
        version: nextVersion,
        supersedes_id: args.supersedesId ?? null,
        status: 'draft',
        mode,
        total_cents: composition.totalCents,
        // §8.3 — the program/non-program split (processing kinds only; undefined
        // → null on transportation / collection-site-count by composition contract).
        program_units_processed:
          composition.programUnitsProcessed != null
            ? new Prisma.Decimal(composition.programUnitsProcessed)
            : null,
        non_program_units_processed:
          composition.nonProgramUnitsProcessed != null
            ? new Prisma.Decimal(composition.nonProgramUnitsProcessed)
            : null,
        // rollup §1.3 — the GP Trade discount as data (ca_processing_eom only;
        // undefined → null for every other kind by composition contract).
        trade_discount_cents: composition.tradeDiscountCents ?? null,
        trade_discount_reference_invoice_id: composition.tradeDiscountReferenceInvoiceId ?? null,
        generated_by: args.actorUserId,
        notes: args.notes ?? null,
        lines: {
          create: composition.lines.map((l) => ({
            line_code: l.lineCode,
            description: l.description,
            quantity: l.quantity != null ? new Prisma.Decimal(l.quantity) : null,
            rate_ref: (l.rateRef ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            amount_cents: l.amountCents,
            source: (l.source ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            position: l.position,
          })),
        },
      },
      include: INVOICE_INCLUDE,
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: invoice.id,
        after: {
          kind: args.kind,
          billing_month: billingMonthISO,
          version: nextVersion,
          status: 'draft',
          mode,
          total_cents: composition.totalCents,
          line_count: composition.lines.length,
          ...(args.supersedesId ? { supersedes_id: args.supersedesId } : {}),
        },
      },
    });
    return invoice;
  });

  log.info(
    {
      op: 'invoice.generate',
      site_id: args.siteId,
      kind: args.kind,
      billing_month: billingMonthISO,
      window: [window.startISO, window.endISO],
      version: created.version,
      line_count: composition.lines.length,
      total_cents: composition.totalCents,
      status: 'draft',
      mode,
    },
    '[invoices] draft generated',
  );

  return toInvoiceView(created);
}

// ────────────────────────────────────────────────────────────────────────
// Reads (site-scoped — CLAUDE.md hard rule #2)
// ────────────────────────────────────────────────────────────────────────

export interface InvoiceListFilter {
  kind?: InvoiceKind;
  billingMonthISO?: string;
}

export async function listInvoices(
  siteId: string,
  filter: InvoiceListFilter = {},
  limit = 100,
): Promise<InvoiceListItem[]> {
  const rows = await prisma.invoice.findMany({
    where: {
      site_id: siteId,
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.billingMonthISO
        ? { billing_month: dayKeyUTCFromISO(billingMonthStartISO(filter.billingMonthISO)) }
        : {}),
    },
    orderBy: [{ billing_month: 'desc' }, { kind: 'asc' }, { version: 'desc' }],
    take: limit,
    select: {
      id: true,
      kind: true,
      billing_month: true,
      version: true,
      status: true,
      total_cents: true,
      supersedes_id: true,
      generated_at: true,
      approved_at: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as InvoiceKind,
    billingMonth: r.billing_month,
    version: r.version,
    status: r.status as InvoiceView['status'],
    totalCents: r.total_cents,
    supersedesId: r.supersedes_id,
    generatedAt: r.generated_at,
    approvedAt: r.approved_at,
  }));
}

export interface InvoiceDetail {
  invoice: InvoiceView;
  /** The trust-gate verdict for this invoice's window (inline findings, D4). */
  gate: WindowGateResult;
  /** The prior version in the chain (for diff), if any. */
  priorVersion: InvoiceView | null;
}

export async function getInvoiceDetail(siteId: string, id: string): Promise<InvoiceDetail | null> {
  const row = await prisma.invoice.findFirst({
    where: { id, site_id: siteId },
    include: INVOICE_INCLUDE,
  });
  if (!row) return null;
  const invoice = toInvoiceView(row);

  const [gate, priorRow] = await Promise.all([
    evaluateWindowGate(
      prisma,
      siteId,
      invoice.windowStart.toISOString().slice(0, 10),
      invoice.windowEnd.toISOString().slice(0, 10),
    ),
    invoice.version > 1
      ? prisma.invoice.findFirst({
          where: {
            site_id: siteId,
            kind: row.kind,
            billing_month: row.billing_month,
            version: invoice.version - 1,
          },
          include: INVOICE_INCLUDE,
        })
      : Promise.resolve(null),
  ]);

  return { invoice, gate, priorVersion: priorRow ? toInvoiceView(priorRow) : null };
}

/** Load an invoice row + lines, site-scoped, for a transition (lifecycle). */
export async function loadInvoiceRow(siteId: string, id: string) {
  return prisma.invoice.findFirst({ where: { id, site_id: siteId }, include: INVOICE_INCLUDE });
}
