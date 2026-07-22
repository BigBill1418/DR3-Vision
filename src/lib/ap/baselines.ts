// ADR-0046 Amendment 5 (D-M5-4) — vendor-baseline aggregation + rebuild.
//
// The COMPUTED side of variance detection. `ap_vendor_baseline_history` holds the
// raw per-invoice rows (Bill-uploaded AP reports, source='bill_upload', plus
// Vision's own approved invoices, source='vision_approval'); this module rolls them
// up per normalized vendor over the trailing 12 months into `ap_vendor_baselines`
// (mean/median/min/max/stddev/count), which `variance.ts` reads at Approve time.
//
// The aggregation is PURE and exhaustively unit-tested; the only I/O is
// `rebuildVendorBaselines` (nightly cron + the on-demand admin button) and
// `recordVisionApproval` (called in-tx on every terminal `approved` transition so
// baselines stay fresh between Bill's re-uploads). A REBUILD PRESERVES the admin's
// per-vendor threshold overrides (`variance_flat_override_cents`,
// `variance_percent_override`) — those are hand-set on `/admin/ap/baselines` and
// must survive every recompute (upsert writes only the aggregate columns).

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { normalizeVendorName } from './variance';

export { normalizeVendorName };

/// One raw history row feeding aggregation (a subset of ap_vendor_baseline_history).
export interface BaselineHistoryRow {
  vendorName: string;
  vendorNameNormalized: string;
  invoiceDate: Date;
  invoiceAmountCents: number;
}

/// The computed per-vendor aggregate over the trailing-12-month window — the exact
/// shape written to one `ap_vendor_baselines` row (minus overrides + computed_at).
export interface BaselineAggregate {
  vendorNameNormalized: string;
  vendorDisplayName: string;
  invoiceCount: number;
  meanAmountCents: number;
  medianAmountCents: number;
  minAmountCents: number;
  maxAmountCents: number;
  /// Population stddev, rounded to whole cents; null for a single-invoice window
  /// (stddev is undefined for n < 2).
  stddevAmountCents: number | null;
}

/// The trailing window (D-M5-4): 12 calendar months back from a vendor's MOST
/// RECENT invoice date, inclusive. Anchoring to the vendor's own latest invoice
/// (not "now") means a rebuild is deterministic and a dormant vendor's baseline
/// doesn't silently empty out just because a year of wall-clock passed.
export function trailingWindowStart(mostRecent: Date): Date {
  return new Date(
    Date.UTC(
      mostRecent.getUTCFullYear() - 1,
      mostRecent.getUTCMonth(),
      mostRecent.getUTCDate(),
      mostRecent.getUTCHours(),
      mostRecent.getUTCMinutes(),
      mostRecent.getUTCSeconds(),
    ),
  );
}

function median(sortedAsc: readonly number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedAsc[mid]!;
  return Math.round((sortedAsc[mid - 1]! + sortedAsc[mid]!) / 2);
}

/// Population standard deviation over the exact (unrounded) mean, rounded to whole
/// cents. Null for n < 2.
function populationStddev(values: readonly number[], exactMean: number): number | null {
  const n = values.length;
  if (n < 2) return null;
  const variance = values.reduce((acc, v) => acc + (v - exactMean) ** 2, 0) / n;
  return Math.round(Math.sqrt(variance));
}

/**
 * Aggregate the trailing-12-month baseline for ONE normalized vendor from its raw
 * history rows (any order; rows for other vendors must be pre-filtered out).
 * Returns null when the vendor has no rows. The display name is taken from the
 * most-recent-in-window row's raw `vendorName` (freshest spelling wins).
 */
export function computeBaselineForVendor(rows: readonly BaselineHistoryRow[]): BaselineAggregate | null {
  if (rows.length === 0) return null;
  const norm = rows[0]!.vendorNameNormalized;
  const mostRecent = rows.reduce(
    (max, r) => (r.invoiceDate.getTime() > max.getTime() ? r.invoiceDate : max),
    rows[0]!.invoiceDate,
  );
  const cutoff = trailingWindowStart(mostRecent).getTime();
  const inWindow = rows.filter((r) => r.invoiceDate.getTime() >= cutoff);
  if (inWindow.length === 0) return null;

  const amounts = inWindow.map((r) => r.invoiceAmountCents);
  const sorted = [...amounts].sort((a, b) => a - b);
  const sum = amounts.reduce((a, b) => a + b, 0);
  const exactMean = sum / amounts.length;
  // Freshest spelling in-window as the display name.
  const display = inWindow.reduce((best, r) =>
    r.invoiceDate.getTime() >= best.invoiceDate.getTime() ? r : best,
  ).vendorName;

  return {
    vendorNameNormalized: norm,
    vendorDisplayName: display.trim() || norm,
    invoiceCount: inWindow.length,
    meanAmountCents: Math.round(exactMean),
    medianAmountCents: median(sorted),
    minAmountCents: sorted[0]!,
    maxAmountCents: sorted[sorted.length - 1]!,
    stddevAmountCents: populationStddev(amounts, exactMean),
  };
}

/**
 * Group ALL raw history rows by normalized vendor and aggregate each. Returns one
 * {@link BaselineAggregate} per vendor that has at least one in-window invoice,
 * sorted by display name for stable output. A vendor with rows only OUTSIDE its own
 * trailing window (impossible when the window anchors on its most-recent row, but
 * guarded) is dropped.
 */
export function aggregateBaselines(rows: readonly BaselineHistoryRow[]): BaselineAggregate[] {
  const byVendor = new Map<string, BaselineHistoryRow[]>();
  for (const r of rows) {
    const bucket = byVendor.get(r.vendorNameNormalized);
    if (bucket) bucket.push(r);
    else byVendor.set(r.vendorNameNormalized, [r]);
  }
  const out: BaselineAggregate[] = [];
  for (const bucket of byVendor.values()) {
    const agg = computeBaselineForVendor(bucket);
    if (agg) out.push(agg);
  }
  return out.sort((a, b) => a.vendorDisplayName.localeCompare(b.vendorDisplayName));
}

/// Result of a rebuild — surfaced to the admin refresh button + the cron log.
export interface RebuildResult {
  vendorsComputed: number;
  historyRows: number;
  staleRemoved: number;
}

/**
 * Recompute EVERY vendor baseline from the full history table, preserving each
 * vendor's admin threshold overrides. Reads all history, aggregates, upserts one
 * `ap_vendor_baselines` row per vendor (aggregate columns only — override columns
 * are never touched, so a hand-set override survives), and removes baselines whose
 * vendor no longer has any history. Runs nightly (cron) + on demand.
 */
export async function rebuildVendorBaselines(
  prisma: PrismaClient = defaultPrisma,
): Promise<RebuildResult> {
  const history = await prisma.apVendorBaselineHistory.findMany({
    select: {
      vendor_name: true,
      vendor_name_normalized: true,
      invoice_date: true,
      invoice_amount_cents: true,
    },
  });
  const rows: BaselineHistoryRow[] = history.map((h) => ({
    vendorName: h.vendor_name,
    vendorNameNormalized: h.vendor_name_normalized,
    invoiceDate: h.invoice_date,
    invoiceAmountCents: h.invoice_amount_cents,
  }));
  const aggregates = aggregateBaselines(rows);
  const computedAt = new Date();

  const existing = await prisma.apVendorBaseline.findMany({
    select: { vendor_name_normalized: true },
  });
  const keep = new Set(aggregates.map((a) => a.vendorNameNormalized));
  const stale = existing
    .map((e) => e.vendor_name_normalized)
    .filter((k) => !keep.has(k));

  await prisma.$transaction(async (tx) => {
    for (const a of aggregates) {
      // NOTE: neither `create` nor `update` writes the override columns — a rebuild
      // must never clobber the admin's per-vendor threshold overrides (D-M5-4).
      const cols = {
        vendor_display_name: a.vendorDisplayName,
        invoice_count: a.invoiceCount,
        mean_amount_cents: a.meanAmountCents,
        median_amount_cents: a.medianAmountCents,
        min_amount_cents: a.minAmountCents,
        max_amount_cents: a.maxAmountCents,
        stddev_amount_cents: a.stddevAmountCents,
        computed_at: computedAt,
      };
      await tx.apVendorBaseline.upsert({
        where: { vendor_name_normalized: a.vendorNameNormalized },
        create: { vendor_name_normalized: a.vendorNameNormalized, ...cols },
        update: cols,
      });
    }
    if (stale.length > 0) {
      await tx.apVendorBaseline.deleteMany({
        where: { vendor_name_normalized: { in: stale } },
      });
    }
  });

  return { vendorsComputed: aggregates.length, historyRows: rows.length, staleRemoved: stale.length };
}

/// The minimal writer surface `recordVisionApproval` needs — satisfied by both a
/// PrismaClient and a `$transaction` client, so it can be called inside the decide
/// transaction.
type BaselineHistoryWriter = Pick<Prisma.TransactionClient, 'apVendorBaselineHistory'>;

export interface VisionApprovalArgs {
  vendorFreeform: string;
  confirmedAmountCents: number;
  siteId: string | null;
  /// The invoice's representative date — the request's `received_at` (arrival), the
  /// best invoice-date proxy Vision has in Phase 1.
  invoiceDate: Date;
  actorUserId: string;
}

/**
 * Append a `vision_approval` row to `ap_vendor_baseline_history` for a terminal
 * `approved` decision, so the vendor's baseline stays fresh between Bill's
 * re-uploads (D-M5-4 lifecycle). Called INSIDE the decide transaction — the
 * approval and its baseline row commit together. No-op (never throws) when the
 * vendor is blank or the amount isn't a finite number, so a malformed structured
 * write can never wedge the approval.
 */
export async function recordVisionApproval(
  tx: BaselineHistoryWriter,
  args: VisionApprovalArgs,
): Promise<void> {
  const norm = normalizeVendorName(args.vendorFreeform);
  if (!norm || !Number.isFinite(args.confirmedAmountCents)) return;
  await tx.apVendorBaselineHistory.create({
    data: {
      vendor_name: args.vendorFreeform.trim(),
      vendor_name_normalized: norm,
      invoice_date: args.invoiceDate,
      invoice_amount_cents: Math.round(args.confirmedAmountCents),
      site_id: args.siteId,
      source: 'vision_approval',
      imported_by: args.actorUserId,
    },
  });
}
