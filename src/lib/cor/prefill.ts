// ADR-0042 D2 — the three pre-filled COR numbers, each with provenance.
//
// Vision pre-fills and renders; a human always reviews and signs. This module
// computes what Vision can PROVE for a (site, cover_month):
//
//   1. Unprocessed inventory at month close (D2.1) = the ONE pool-aware running
//      balance (ADR-0037 D6, `onHand`) as of the month's last day, cross-
//      referenced to the nearest physical snapshot. `inventory_source` records the
//      anchor snapshot id, the computed figure, and the reconcile delta in between.
//   2. FT/PT headcount pre-fill (D2.2) = the month's DISTINCT-PROCESSOR count from
//      the payroll source (ADR-0076), WITH the month's full daily-close series
//      retained in the provenance. The daily close captures TOTALS, not an FT/PT
//      split — the preparer enters the split at review; here we only pre-fill what
//      we can prove (the split stays null until finalize). See the ADR-0076
//      follow-up note on `HeadcountSource` for why the processor figure no longer
//      comes from the daily close.
//   3. Signer (D2.3) = standardized from `cor_site_config` (see signer.ts).
//
// Pure-ish: reads the DB via the shared `prisma` + the ONE balance function; no
// clock (the cover month is the input). No PII (a COR has none by design, D5).

import { onHand, snapshotTotalUnits } from '@/lib/inventory/running-balance';
import { NOT_VOIDED } from '@/lib/inventory/snapshot-void';
import { assertCorInboundFresh, assertCorInventoryNotNegative } from './inbound-gate';
import { countDistinctProcessors } from '@/lib/bonus/processor-count';
import { log } from '@/lib/observability/logger';
import { dayKeyUTCFromISO } from '@/lib/time';
import { resolveCorSigner } from './signer';
import { prisma } from '@/lib/prisma';
import type { CorPeriod } from './view';

/** Provenance for the inventory figure (D2.1). Serialized into `inventory_source`. */
export interface InventorySource {
  method: 'running_balance_adr0037_d6';
  /** The last-instant-of-month asOf the balance was computed at (ISO). */
  asOf: string;
  /** Nearest physical snapshot ≤ asOf that anchored the balance (null if none). */
  anchorSnapshotId: string | null;
  anchorAt: string | null;
  /** The anchor snapshot's own physical total (units), for the drill-down. */
  anchorPhysicalUnits: number | null;
  /** The anchor's recorded reconcile delta (physical − computed at reconcile). */
  anchorReconciledDelta: number | null;
  /** Full-precision computed running balance (string, no float drift). */
  computedProgram: string;
  computedNonProgram: string;
  computedTotal: string;
  /** The rounded integer stored on the certificate (`inventory_units`). */
  storedUnits: number;
}

/** One month-end close row summary (D2.2 series entry). */
export interface HeadcountSeriesEntry {
  id: string;
  productionDate: string;
  employeesCount: number | null;
  processorsCount: number | null;
}

/**
 * Provenance for the headcount pre-fill (D2.2). Serialized into `headcount_source`.
 *
 * ADR-0076 follow-up (OPEN-ITEMS 0.AG F-1) — `processorsCount` NO LONGER comes from
 * the daily close. `processed_units_daily.employees_count` / `.processors_count` were
 * added as workbook close metadata (ADR-0037 Addendum B4) and have never been written
 * by any of their four write paths: measured in production, 989 rows, 0 non-null in
 * EITHER column. Every COR headcount cell rendered `—`. The real figure lives in the
 * payroll source, exactly as ADR-0076 established for the daily report.
 *
 * `method` names the derivation honestly. It is NOT still
 * `'daily_close_month_end_adr0042_d2'`, because a figure that no longer comes from the
 * daily close must not keep claiming it does — the whole point of a provenance blob is
 * that a reader can trust the label. The close-row record is retained regardless
 * (`consultedCloseRowIds` + `series`), so the provenance still shows what the close
 * rows actually said and therefore why the old path yielded nothing.
 */
export interface HeadcountSource {
  method: 'bonus_distinct_processors_adr0076';
  /** The month-end close row consulted (null if no closes). Retained for the audit. */
  monthEndCloseId: string | null;
  monthEndDate: string | null;
  /**
   * FT/PT employee TOTAL — still the month-end close's `employees_count`, and still
   * null in production because that column has never been written.
   *
   * This is DELIBERATELY not backfilled from the processor count. Bonus entries cover
   * PROCESSORS only; the FT/PT total is a different population (it includes everyone
   * on site, not just people who stripped a mattress). Substituting one for the other
   * would put a fabricated compliance figure on a filed regulatory document. Not
   * recorded stays not recorded.
   */
  employeesCount: number | null;
  /**
   * Distinct processors with ≥1 payroll entry in the cover month (ADR-0076).
   *
   * A genuine `0` means the payroll source was read and the month contains no
   * entries — nobody processed. `null` means the count could NOT be computed at all
   * (see `processorsCountUnavailableReason`). These are different facts and the UI
   * must keep rendering them differently: never `0` for an absent value, never `—`
   * for a real zero.
   */
  processorsCount: number | null;
  /**
   * Non-null ONLY when `processorsCount` is null — the reason the derivation could not
   * run. Keeps "not recorded" self-explaining in the stored provenance instead of
   * indistinguishable from a real zero after the fact.
   */
  processorsCountUnavailableReason: string | null;
  /** Inclusive UTC day-key window the distinct-processor count was taken over. */
  processorsWindowStart: string;
  processorsWindowEnd: string;
  /** Every daily-close row consulted for this month (the full series). */
  consultedCloseRowIds: string[];
  series: HeadcountSeriesEntry[];
}

/**
 * ADR-0042 amendment — provenance marker for a mid-month filing. A mid-month COR
 * files inventory + FT/PT BLANK; there is nothing to prove, so `inventory_source`
 * and `headcount_source` carry an honest marker (never a fabricated figure).
 */
export interface BlankFilingSource {
  method: 'mid_month_blank_adr0042_amendment';
  note: string;
}

export interface CorPrefill {
  coverMonthISO: string;
  /** ADR-0042 amendment — the filing period this pre-fill was computed for. */
  period: CorPeriod;
  /** Null on a `mid_month` filing (inventory left blank). */
  inventoryUnits: number | null;
  inventorySource: InventorySource | BlankFilingSource;
  headcountSource: HeadcountSource | BlankFilingSource;
  signerName: string;
  signerTitle: string;
}

/** Month boundaries for a first-of-month cover-month ISO (UTC, @db.Date-aligned). */
export function coverMonthBounds(coverMonthISO: string): {
  monthStart: Date;
  monthEndDate: Date;
  monthEndAsOf: Date;
} {
  const monthStart = dayKeyUTCFromISO(coverMonthISO);
  const y = monthStart.getUTCFullYear();
  const m = monthStart.getUTCMonth();
  // Day 0 of the next month = the last calendar day of this month.
  const monthEndDate = new Date(Date.UTC(y, m + 1, 0));
  // Last instant of that day — the running-balance asOf (inclusive of the whole
  // last day's flow, since the balance windows on `lte: asOf`).
  const monthEndAsOf = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return { monthStart, monthEndDate, monthEndAsOf };
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the COR pre-fill for a (site, cover_month). Does NOT enforce the CA-only
 * jurisdiction guard — that is the service's job at generation; a pure pre-fill is
 * jurisdiction-agnostic. Returns the inventory figure + both provenance blobs +
 * the resolved signer.
 */
export async function computeCorPrefill(
  siteId: string,
  coverMonthISO: string,
  period: CorPeriod = 'end_of_month',
): Promise<CorPrefill> {
  // ADR-0042 amendment — a mid-month filing files inventory + FT/PT BLANK. There is
  // no inventory figure and no headcount to pre-fill; only the signer resolves. We
  // short-circuit BEFORE any balance/close query (nothing to compute or reconcile).
  if (period === 'mid_month') {
    const signer = await resolveCorSigner(siteId);
    return {
      coverMonthISO,
      period,
      inventoryUnits: null,
      inventorySource: {
        method: 'mid_month_blank_adr0042_amendment',
        note: 'Mid-month COR — inventory is filed blank; the reconciled figure is reported at month end.',
      },
      headcountSource: {
        method: 'mid_month_blank_adr0042_amendment',
        note: 'Mid-month COR — FT/PT headcount is filed blank; the split is reported at month end.',
      },
      signerName: signer.name,
      signerTitle: signer.title,
    };
  }

  // PR #196 §2.3 — an end-of-month COR derives its filed figure from `onHand`,
  // whose inbound leg is bridged from delivered hauls. Refuse BEFORE computing
  // anything when that feed is frozen — a regulatory filing must never be
  // derivable from a feed known to be stale.
  await assertCorInboundFresh();

  const { monthStart, monthEndDate, monthEndAsOf } = coverMonthBounds(coverMonthISO);

  // ── Inventory (D2.1): the ONE balance function + the anchor it used ──────
  // ── Headcount (D2.2): the payroll-derived distinct-processor count ───────
  //
  // The distinct-processor query is folded into the same round-trip. It resolves to a
  // RESULT OBJECT rather than rejecting, because a payroll-source failure must not
  // take down the inventory figure with it and must NOT be reported as `0` — see the
  // `count: null` branch below. The mirror of this is `daily-report.ts`, which omits
  // its EOD-inventory section on the same principle rather than printing a zero.
  //
  // Scoping note: this runs strictly AFTER `assertCorInboundFresh()` above and leaves
  // `assertCorInventoryNotNegative()` below untouched — the settle-to-object wrapper
  // is scoped to this ONE call and therefore cannot swallow either gate.
  const [balance, anchor, closes, signer, processors] = await Promise.all([
    onHand(siteId, monthEndAsOf),
    prisma.siteInventorySnapshot.findFirst({
      // ADR-0084 — the COR names the anchor it filed against, and that name goes
      // to MRC. Reporting a count the site voided would put a withdrawn number
      // on a compliance filing.
      where: {
        ...NOT_VOIDED,
        site_id: siteId,
        snapshot_kind: 'physical',
        snapshot_at: { lte: monthEndAsOf },
      },
      // PRE-EXISTING: no ADR-0078 D1 `created_at DESC` tiebreak here (unlike
      // `onHand`, whose figure this row is supposed to describe). Reported in
      // ADR-0084, deliberately not changed by it.
      orderBy: { snapshot_at: 'desc' },
      select: {
        id: true,
        snapshot_at: true,
        units_indoor: true,
        units_total: true,
        units_in_processing: true,
        reconciled_delta: true,
      },
    }),
    prisma.processedUnitsDaily.findMany({
      where: { site_id: siteId, production_date: { gte: monthStart, lte: monthEndDate } },
      orderBy: { production_date: 'asc' },
      select: { id: true, production_date: true, employees_count: true, processors_count: true },
    }),
    resolveCorSigner(siteId),
    countDistinctProcessors(siteId, monthStart, monthEndDate).then(
      (count): { count: number | null; reason: string | null } => ({ count, reason: null }),
      (err: unknown): { count: number | null; reason: string | null } => {
        log.error(
          { err, siteId, coverMonthISO },
          '[cor] distinct-processor count unavailable — headcount pre-filled as not-recorded, NOT zero',
        );
        return { count: null, reason: 'payroll_source_unavailable' };
      },
    ),
  ]);

  const storedUnits = balance.total.toNearest(1).toNumber();
  // PR #196 §2.3 — a negative balance is a drifted one-sided ledger, never a
  // fileable inventory figure (throws CorLedgerNegativeError, 422).
  assertCorInventoryNotNegative(storedUnits);
  const inventorySource: InventorySource = {
    method: 'running_balance_adr0037_d6',
    asOf: monthEndAsOf.toISOString(),
    anchorSnapshotId: anchor?.id ?? null,
    anchorAt: anchor ? anchor.snapshot_at.toISOString() : null,
    anchorPhysicalUnits: anchor ? snapshotTotalUnits(anchor) : null,
    anchorReconciledDelta: anchor?.reconciled_delta ?? null,
    computedProgram: balance.program.toString(),
    computedNonProgram: balance.nonProgram.toString(),
    computedTotal: balance.total.toString(),
    storedUnits,
  };

  // ── Headcount pre-fill (D2.2): payroll processors + the close series ─────
  // The close series is still recorded verbatim. In production every cell in it is
  // null; keeping it is what lets an auditor see WHY the pre-fill used to be blank
  // rather than having to take this comment's word for it.
  const series: HeadcountSeriesEntry[] = closes.map((c) => ({
    id: c.id,
    productionDate: isoDay(c.production_date),
    employeesCount: c.employees_count,
    processorsCount: c.processors_count,
  }));
  const monthEnd = closes.length > 0 ? closes[closes.length - 1]! : null;
  const headcountSource: HeadcountSource = {
    method: 'bonus_distinct_processors_adr0076',
    monthEndCloseId: monthEnd?.id ?? null,
    monthEndDate: monthEnd ? isoDay(monthEnd.production_date) : null,
    // Close-derived, and left alone. NOT the processor count — see the interface doc:
    // the FT/PT total is a different population and faking it would be a fabricated
    // compliance figure.
    employeesCount: monthEnd?.employees_count ?? null,
    // Payroll-derived. `0` = read and empty; `null` = could not read. Never conflated.
    processorsCount: processors.count,
    processorsCountUnavailableReason: processors.reason,
    processorsWindowStart: isoDay(monthStart),
    processorsWindowEnd: isoDay(monthEndDate),
    consultedCloseRowIds: closes.map((c) => c.id),
    series,
  };

  return {
    coverMonthISO,
    period,
    inventoryUnits: storedUnits,
    inventorySource,
    headcountSource,
    signerName: signer.name,
    signerTitle: signer.title,
  };
}
