// ADR-0042 D1/D3 — COR lifecycle transitions (finalize, supersede, void) + the
// finalizer rule. Mirrors ADR-0041 invoice lifecycle semantics (this ADR reuses
// the pattern, it does NOT import it).
//
// Immutability is enforced at the SERVICE layer: a finalized certificate never
// mutates — a correction is a NEW version in a `supersedes_id` chain, both rows
// retained. `finalizeCor` is the freeze point (D3): it authorizes the caller,
// REQUIRES the FT/PT split to have been entered at review (D2.2), re-asserts the
// inventory reconcile tripwire (D2.1/D3), then flips the row to `finalized` and
// fires PDF generation in the background (never blocking the request).
//
// FINALIZER RULE (D3): manager-of-site OR admin — identical to the ADR-0041
// approver rule. `can_manage_rates` is NEVER an input (hard rule #2).

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { generateCorDraft, loadCorRow, assertCorInventoryReconciles } from './service';
import { assertCorInboundFresh, assertCorInventoryNotNegative } from './inbound-gate';
import { generateCorPdf } from './pdf';
import {
  CorNotFoundError,
  CorImmutableError,
  CorTransitionError,
  CorHeadcountRequiredError,
  CorFinalizeForbiddenError,
  toCorView,
  type CorView,
} from './view';

const TABLE = 'cor_certificates';

/** Caller identity for a finalize/supersede decision (route-resolved). */
export interface FinalizerContext {
  userId: string;
  role: 'operator' | 'manager' | 'admin';
  /** True iff this manager manages the certificate's site (primary_site_id match). */
  managesSite: boolean;
}

/** D3 finalizer rule: admin, or a manager who manages this site. */
export function canFinalize(ctx: FinalizerContext): boolean {
  return ctx.role === 'admin' || (ctx.role === 'manager' && ctx.managesSite);
}

export interface FinalizeArgs {
  siteId: string;
  certId: string;
  finalizer: FinalizerContext;
}

/**
 * Finalize a draft COR (the freeze). Enforces authorization, requires the FT/PT
 * split (D2.2), re-asserts the inventory reconcile tripwire (D2.1/D3), then flips
 * the row to `finalized`. Finalized rows are immutable thereafter; a background
 * PDF render is fired (never awaited — a render failure never blocks the freeze,
 * the operator re-triggers). The signature block on the PDF renders EMPTY: a
 * human always signs the printed copy (D3).
 */
export async function finalizeCor(args: FinalizeArgs): Promise<CorView> {
  const row = await loadCorRow(args.siteId, args.certId);
  if (!row) throw new CorNotFoundError(args.certId);
  if (row.status === 'finalized') throw new CorImmutableError(row.id);
  if (row.status !== 'draft') {
    throw new CorTransitionError(
      'not_draft',
      `cor certificate ${row.id} is ${row.status}; only a draft can be finalized`,
    );
  }
  if (!canFinalize(args.finalizer)) throw new CorFinalizeForbiddenError();
  // ADR-0042 amendment — the FT/PT split is REQUIRED at finalize for an
  // end-of-month close, but a mid-month filing files FT/PT blank by design, so the
  // requirement is skipped for `mid_month`. The end-of-month gate is unchanged.
  if (row.period === 'end_of_month' && (row.ft_headcount == null || row.pt_headcount == null)) {
    throw new CorHeadcountRequiredError(row.id);
  }

  // PR #196 §2.3 — the freeze must also refuse a frozen inbound feed and a
  // negative stored figure. Prefill already refuses both, but a draft generated
  // BEFORE the feed froze (or before this gate shipped) could otherwise still be
  // finalized against a ledger that has since gone one-sided. Mid-month files
  // inventory blank and is untouched.
  if (row.period === 'end_of_month') {
    await assertCorInboundFresh();
    if (row.inventory_units != null) assertCorInventoryNotNegative(row.inventory_units);
  }

  // D2.1/D3 tripwire: the stored inventory figure MUST still reconcile to the
  // ledger at the freeze — throws CorReconcileMismatchError with both numbers.
  // A mid-month filing has no inventory figure, so this short-circuits (skipped).
  await assertCorInventoryReconciles(row.id);

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.corCertificate.update({
      where: { id: row.id },
      data: { status: 'finalized', finalized_by: args.finalizer.userId, finalized_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.finalizer.userId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { status: 'draft' },
        after: {
          status: 'finalized',
          inventory_units: u.inventory_units,
          ft_headcount: u.ft_headcount,
          pt_headcount: u.pt_headcount,
        },
      },
    });
    return u;
  });

  log.info(
    {
      op: 'cor.finalize',
      cert_id: row.id,
      site_id: args.siteId,
      cover_month: row.cover_month.toISOString().slice(0, 10),
      inventory_units: updated.inventory_units,
      ft_headcount: updated.ft_headcount,
      pt_headcount: updated.pt_headcount,
      actor_user_id: args.finalizer.userId,
    },
    '[cor] finalized',
  );

  // Fire-and-forget PDF render (background-safe): never blocks the freeze.
  void generateCorPdf(row.id).catch((err: unknown) => {
    log.error(
      {
        op: 'cor.finalize.pdf',
        cert_id: row.id,
        err: err instanceof Error ? err.message : String(err),
      },
      '[cor] background PDF render failed after finalize (operator may re-trigger)',
    );
  });

  return toCorView(updated);
}

export interface SupersedeArgs {
  siteId: string;
  certId: string;
  actorUserId: string;
  notes?: string;
}

/**
 * Supersede a FINALIZED certificate: regenerate a fresh draft in the same (site,
 * cover_month) chain at the next version, `supersedes_id` pointing at the
 * finalized row. The finalized row STAYS finalized (both retained); the new draft
 * is then re-reviewed (FT/PT re-entered) and finalized. Only a finalized
 * certificate can be superseded.
 */
export async function supersedeCor(args: SupersedeArgs): Promise<CorView> {
  const row = await loadCorRow(args.siteId, args.certId);
  if (!row) throw new CorNotFoundError(args.certId);
  if (row.status !== 'finalized') {
    throw new CorTransitionError(
      'not_finalized',
      `cor certificate ${row.id} is ${row.status}; only a finalized certificate can be superseded`,
    );
  }

  const draft = await generateCorDraft({
    siteId: args.siteId,
    coverMonthISO: row.cover_month.toISOString().slice(0, 10),
    actorUserId: args.actorUserId,
    // A correction stays in the SAME period chain as the certificate it supersedes.
    period: row.period,
    supersedesId: row.id,
    ...(args.notes ? { notes: args.notes } : {}),
  });

  log.info(
    {
      op: 'cor.supersede',
      cert_id: row.id,
      site_id: args.siteId,
      new_cert_id: draft.id,
      new_version: draft.version,
      actor_user_id: args.actorUserId,
    },
    '[cor] superseded — new draft version created',
  );
  return draft;
}

export interface VoidArgs {
  siteId: string;
  certId: string;
  actorUserId: string;
  reason?: string;
}

/**
 * Void a certificate (discard a draft, or cancel a finalized one). Immutability
 * protects the NUMBERS; the status lifecycle is an append-only transition with an
 * audit row.
 */
export async function voidCor(args: VoidArgs): Promise<CorView> {
  const row = await loadCorRow(args.siteId, args.certId);
  if (!row) throw new CorNotFoundError(args.certId);
  if (row.status === 'void') {
    throw new CorTransitionError('already_void', `cor certificate ${row.id} is already void`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.corCertificate.update({
      where: { id: row.id },
      data: { status: 'void', ...(args.reason ? { notes: args.reason } : {}) },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { status: row.status },
        after: { status: 'void', ...(args.reason ? { reason: args.reason } : {}) },
      },
    });
    return u;
  });

  log.info(
    {
      op: 'cor.void',
      cert_id: row.id,
      site_id: args.siteId,
      prior_status: row.status,
      actor_user_id: args.actorUserId,
    },
    '[cor] voided',
  );
  return toCorView(updated);
}
