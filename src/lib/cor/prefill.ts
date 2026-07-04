// ADR-0042 D2 — the three pre-filled COR numbers, each with provenance.
//
// Vision pre-fills and renders; a human always reviews and signs. This module
// computes what Vision can PROVE for a (site, cover_month):
//
//   1. Unprocessed inventory at month close (D2.1) = the ONE pool-aware running
//      balance (ADR-0037 D6, `onHand`) as of the month's last day, cross-
//      referenced to the nearest physical snapshot. `inventory_source` records the
//      anchor snapshot id, the computed figure, and the reconcile delta in between.
//   2. FT/PT headcount pre-fill (D2.2) = the month-end daily close's
//      `employees_count`/`processors_count`, WITH the month's full close series in
//      the provenance. The daily close captures TOTALS, not an FT/PT split — the
//      preparer enters the split at review; here we only pre-fill the totals + the
//      consulted close-row ids (the split stays null until finalize).
//   3. Signer (D2.3) = standardized from `cor_site_config` (see signer.ts).
//
// Pure-ish: reads the DB via the shared `prisma` + the ONE balance function; no
// clock (the cover month is the input). No PII (a COR has none by design, D5).

import { onHand, snapshotTotalUnits } from '@/lib/inventory/running-balance';
import { dayKeyUTCFromISO } from '@/lib/time';
import { resolveCorSigner } from './signer';
import { prisma } from '@/lib/prisma';

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

/** Provenance for the headcount pre-fill (D2.2). Serialized into `headcount_source`. */
export interface HeadcountSource {
  method: 'daily_close_month_end_adr0042_d2';
  /** The month-end close row the pre-fill totals came from (null if no closes). */
  monthEndCloseId: string | null;
  monthEndDate: string | null;
  /** Month-end totals (NOT an FT/PT split — the split is the human judgment). */
  employeesCount: number | null;
  processorsCount: number | null;
  /** Every daily-close row consulted for this month (the full series). */
  consultedCloseRowIds: string[];
  series: HeadcountSeriesEntry[];
}

export interface CorPrefill {
  coverMonthISO: string;
  inventoryUnits: number;
  inventorySource: InventorySource;
  headcountSource: HeadcountSource;
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
export async function computeCorPrefill(siteId: string, coverMonthISO: string): Promise<CorPrefill> {
  const { monthStart, monthEndDate, monthEndAsOf } = coverMonthBounds(coverMonthISO);

  // ── Inventory (D2.1): the ONE balance function + the anchor it used ──────
  const [balance, anchor, closes, signer] = await Promise.all([
    onHand(siteId, monthEndAsOf),
    prisma.siteInventorySnapshot.findFirst({
      where: { site_id: siteId, snapshot_kind: 'physical', snapshot_at: { lte: monthEndAsOf } },
      orderBy: { snapshot_at: 'desc' },
      select: {
        id: true,
        snapshot_at: true,
        units_indoor: true,
        units_outdoor: true,
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
  ]);

  const storedUnits = balance.total.toNearest(1).toNumber();
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

  // ── Headcount pre-fill (D2.2): month-end close totals + the full series ──
  const series: HeadcountSeriesEntry[] = closes.map((c) => ({
    id: c.id,
    productionDate: isoDay(c.production_date),
    employeesCount: c.employees_count,
    processorsCount: c.processors_count,
  }));
  const monthEnd = closes.length > 0 ? closes[closes.length - 1]! : null;
  const headcountSource: HeadcountSource = {
    method: 'daily_close_month_end_adr0042_d2',
    monthEndCloseId: monthEnd?.id ?? null,
    monthEndDate: monthEnd ? isoDay(monthEnd.production_date) : null,
    employeesCount: monthEnd?.employees_count ?? null,
    processorsCount: monthEnd?.processors_count ?? null,
    consultedCloseRowIds: closes.map((c) => c.id),
    series,
  };

  return {
    coverMonthISO,
    inventoryUnits: storedUnits,
    inventorySource,
    headcountSource,
    signerName: signer.name,
    signerTitle: signer.title,
  };
}
