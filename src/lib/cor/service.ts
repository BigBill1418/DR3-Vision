// ADR-0042 — COR service: generation, the review headcount entry, the pre-render
// reconcile tripwire, and the site-scoped reads.
//
// Generation composes a DRAFT from the pre-fill (`prefill.ts`) and persists it
// with an audit row in one transaction. Drafts regenerate freely: a new draft
// VOIDS the prior draft and takes the next version (D1, identical to ADR-0041). The
// finalize freeze + supersede/void live in `lifecycle.ts`. Every generation writes
// one structured D5 log line (cover month, inventory units, actor). No PII (D5).
//
// CA-ONLY (D1): a COR is Exhibit 5, which exists only in California. `assertSiteIsCalifornia`
// throws `CorJurisdictionError` for an Oregon site before anything is generated.

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import { onHand } from '@/lib/inventory/running-balance';
import { dayKeyUTCFromISO } from '@/lib/time';
import { computeCorPrefill, coverMonthBounds } from './prefill';
import {
  CorJurisdictionError,
  CorNotFoundError,
  CorImmutableError,
  CorReconcileMismatchError,
  toCorView,
  type CorListItem,
  type CorPeriod,
  type CorView,
} from './view';

const TABLE = 'cor_certificates';

/** Normalize a `YYYY-MM` or `YYYY-MM-DD` string to the first-of-month `YYYY-MM-01`. */
export function coverMonthStartISO(input: string): string {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(input);
  if (!m) throw new RangeError(`invalid cover month: ${input}`);
  return `${m[1]}-${m[2]}-01`;
}

/** Throw {@link CorJurisdictionError} unless the site is a California facility (D1). */
export async function assertSiteIsCalifornia(siteId: string): Promise<void> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { jurisdiction: true },
  });
  if (!site) throw new CorJurisdictionError(siteId, 'unknown');
  if (site.jurisdiction !== 'california') throw new CorJurisdictionError(siteId, site.jurisdiction);
}

export interface GenerateCorDraftArgs {
  siteId: string;
  /** Any day in the target month; normalized to first-of-month. */
  coverMonthISO: string;
  actorUserId: string;
  /**
   * ADR-0042 amendment — end-of-month (default) vs mid-month filing. The chain is
   * scoped by period: a mid-month and an end-of-month certificate for the same
   * cover_month are independent version chains and never void one another.
   */
  period?: CorPeriod;
  /** Set when this draft supersedes a finalized certificate (new version chain). */
  supersedesId?: string;
  notes?: string;
}

/**
 * Generate (or regenerate) a DRAFT COR. Pre-fills the three numbers, voids any
 * prior draft in the (site, cover_month) chain, and persists at the next version
 * with an audit row — all in one transaction. FT/PT stay null (entered at review).
 */
export async function generateCorDraft(args: GenerateCorDraftArgs): Promise<CorView> {
  await assertSiteIsCalifornia(args.siteId);
  const period: CorPeriod = args.period ?? 'end_of_month';
  const coverMonthISO = coverMonthStartISO(args.coverMonthISO);
  const prefill = await computeCorPrefill(args.siteId, coverMonthISO, period);
  const coverMonth = dayKeyUTCFromISO(coverMonthISO);

  const created = await prisma.$transaction(async (tx) => {
    // Void any prior draft(s) in THIS (site, cover_month, period) chain — a
    // regenerate replaces, never edits. Scoped by period so a mid-month regenerate
    // never touches the end-of-month chain (or vice versa) for the same month.
    await tx.corCertificate.updateMany({
      where: { site_id: args.siteId, cover_month: coverMonth, period, status: 'draft' },
      data: { status: 'void' },
    });

    const max = await tx.corCertificate.aggregate({
      _max: { version: true },
      where: { site_id: args.siteId, cover_month: coverMonth, period },
    });
    const nextVersion = (max._max.version ?? 0) + 1;

    const cert = await tx.corCertificate.create({
      data: {
        site_id: args.siteId,
        cover_month: coverMonth,
        version: nextVersion,
        period,
        supersedes_id: args.supersedesId ?? null,
        status: 'draft',
        inventory_units: prefill.inventoryUnits,
        inventory_source: prefill.inventorySource as unknown as Prisma.InputJsonValue,
        ft_headcount: null,
        pt_headcount: null,
        headcount_source: prefill.headcountSource as unknown as Prisma.InputJsonValue,
        signer_name: prefill.signerName,
        signer_title: prefill.signerTitle,
        prepared_by: args.actorUserId,
        notes: args.notes ?? null,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: TABLE,
        row_id: cert.id,
        after: {
          cover_month: coverMonthISO,
          version: nextVersion,
          period,
          status: 'draft',
          inventory_units: prefill.inventoryUnits,
          ...(args.supersedesId ? { supersedes_id: args.supersedesId } : {}),
        },
      },
    });
    return cert;
  });

  log.info(
    {
      op: 'cor.generate',
      cert_id: created.id,
      site_id: args.siteId,
      cover_month: coverMonthISO,
      version: created.version,
      period,
      inventory_units: prefill.inventoryUnits,
      actor_user_id: args.actorUserId,
      status: 'draft',
    },
    '[cor] draft generated',
  );
  return toCorView(created);
}

export interface SetHeadcountSplitArgs {
  siteId: string;
  certId: string;
  ftHeadcount: number;
  ptHeadcount: number;
  actorUserId: string;
}

/**
 * D2.2 — record the preparer's FT/PT split at review. Only a DRAFT can be edited
 * (a finalized certificate is immutable); the daily-close pre-fill stays in
 * `headcount_source`, so the entry is auditable against what Vision pre-filled.
 */
export async function setCorHeadcountSplit(args: SetHeadcountSplitArgs): Promise<CorView> {
  const row = await loadCorRow(args.siteId, args.certId);
  if (!row) throw new CorNotFoundError(args.certId);
  if (row.status === 'finalized') throw new CorImmutableError(row.id);
  if (row.status === 'void') {
    throw new CorNotFoundError(args.certId); // a void draft is not an editable target
  }

  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.corCertificate.update({
      where: { id: row.id },
      data: { ft_headcount: args.ftHeadcount, pt_headcount: args.ptHeadcount },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'update',
        table_name: TABLE,
        row_id: row.id,
        before: { ft_headcount: row.ft_headcount, pt_headcount: row.pt_headcount },
        after: {
          ft_headcount: args.ftHeadcount,
          pt_headcount: args.ptHeadcount,
          prefill_retained: true,
        },
      },
    });
    return u;
  });

  log.info(
    {
      op: 'cor.headcount',
      cert_id: row.id,
      site_id: args.siteId,
      ft_headcount: args.ftHeadcount,
      pt_headcount: args.ptHeadcount,
      actor_user_id: args.actorUserId,
    },
    '[cor] FT/PT split entered at review',
  );
  return toCorView(updated);
}

export interface CorReconcileResult {
  pass: boolean;
  /** Null on a `mid_month` certificate (no inventory figure to reconcile). */
  storedUnits: number | null;
  recomputedUnits: number | null;
  /** ADR-0042 amendment — true when the reconcile was skipped (mid-month filing). */
  skipped?: boolean;
}

/**
 * Pre-render reconciliation tripwire (D2.1/D3, ADR-0033 style). Recompute the
 * inventory figure via the ONE balance function as of the cover month's last day
 * and compare it to the stored `inventory_units`. On mismatch, log and throw
 * {@link CorReconcileMismatchError} carrying both numbers — nothing renders or
 * finalizes on a stored figure that no longer matches the ledger.
 *
 * ADR-0042 amendment — a `mid_month` certificate has NO inventory figure (filed
 * blank), so there is nothing to reconcile: it short-circuits to a passing,
 * `skipped` result and never queries the balance or throws. The end-of-month path
 * is hard-enforced exactly as before.
 */
export async function assertCorInventoryReconciles(certId: string): Promise<CorReconcileResult> {
  const row = await prisma.corCertificate.findUnique({
    where: { id: certId },
    select: { id: true, site_id: true, cover_month: true, period: true, inventory_units: true },
  });
  if (!row) throw new CorNotFoundError(certId);

  if (row.period === 'mid_month') {
    return { pass: true, storedUnits: null, recomputedUnits: null, skipped: true };
  }

  const { monthEndAsOf } = coverMonthBounds(row.cover_month.toISOString().slice(0, 10));
  const balance = await onHand(row.site_id, monthEndAsOf);
  const recomputedUnits = balance.total.toNearest(1).toNumber();

  if (recomputedUnits !== row.inventory_units) {
    log.warn(
      {
        op: 'cor.reconcile.refused',
        cert_id: row.id,
        site_id: row.site_id,
        cover_month: row.cover_month.toISOString().slice(0, 10),
        stored_units: row.inventory_units,
        recomputed_units: recomputedUnits,
      },
      '[cor] inventory reconcile FAILED — refusing (stored figure moved vs the ledger)',
    );
    throw new CorReconcileMismatchError({
      certId: row.id,
      storedUnits: row.inventory_units,
      recomputedUnits,
    });
  }
  return { pass: true, storedUnits: row.inventory_units, recomputedUnits };
}

// ────────────────────────────────────────────────────────────────────────
// Reads (site-scoped — CLAUDE.md hard rule #2)
// ────────────────────────────────────────────────────────────────────────

export async function listCor(siteId: string, limit = 100): Promise<CorListItem[]> {
  const rows = await prisma.corCertificate.findMany({
    where: { site_id: siteId },
    orderBy: [{ cover_month: 'desc' }, { version: 'desc' }],
    take: limit,
    select: {
      id: true,
      cover_month: true,
      version: true,
      status: true,
      period: true,
      inventory_units: true,
      ft_headcount: true,
      pt_headcount: true,
      supersedes_id: true,
      prepared_at: true,
      finalized_at: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    coverMonth: r.cover_month,
    version: r.version,
    status: r.status as CorListItem['status'],
    period: r.period as CorListItem['period'],
    inventoryUnits: r.inventory_units,
    ftHeadcount: r.ft_headcount,
    ptHeadcount: r.pt_headcount,
    supersedesId: r.supersedes_id,
    preparedAt: r.prepared_at,
    finalizedAt: r.finalized_at,
  }));
}

export interface CorDetail {
  cert: CorView;
  /** The prior version in the chain (for the diff), if any. */
  priorVersion: CorView | null;
  /** Live reconcile verdict for the cover month (inline, so review sees drift). */
  reconcile: CorReconcileResult;
}

export async function getCorDetail(siteId: string, id: string): Promise<CorDetail | null> {
  const row = await prisma.corCertificate.findFirst({ where: { id, site_id: siteId } });
  if (!row) return null;
  const cert = toCorView(row);

  // Prior version is scoped to the SAME period chain (mid-month and end-of-month
  // are independent chains for the same cover_month).
  const priorRow =
    cert.version > 1
      ? await prisma.corCertificate.findFirst({
          where: {
            site_id: siteId,
            cover_month: row.cover_month,
            period: row.period,
            version: cert.version - 1,
          },
        })
      : null;

  // Live reconcile verdict (non-throwing) so the surface can show drift inline
  // without a 409; the throwing assertion gates finalize + render. A mid-month
  // filing has no inventory figure — the verdict is `skipped` (no balance query).
  let reconcile: CorReconcileResult;
  if (row.period === 'mid_month') {
    reconcile = { pass: true, storedUnits: null, recomputedUnits: null, skipped: true };
  } else {
    const { monthEndAsOf } = coverMonthBounds(row.cover_month.toISOString().slice(0, 10));
    const balance = await onHand(siteId, monthEndAsOf);
    const recomputedUnits = balance.total.toNearest(1).toNumber();
    reconcile = {
      pass: recomputedUnits === row.inventory_units,
      storedUnits: row.inventory_units,
      recomputedUnits,
    };
  }

  return { cert, priorVersion: priorRow ? toCorView(priorRow) : null, reconcile };
}

/** Load a certificate row, site-scoped, for a transition (lifecycle). */
export async function loadCorRow(siteId: string, id: string) {
  return prisma.corCertificate.findFirst({ where: { id, site_id: siteId } });
}
