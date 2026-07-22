// ADR-0046 Amendment 5 (D-M5-4) — vendor-baseline variance detection.
//
// Server-authoritative variance evaluation for the structured Approve path. The
// approver types a freeform vendor + confirms an amount; if that vendor has an
// ESTABLISHED baseline (>= 3 historical invoices over the trailing 12 months) and
// the confirmed amount trips the $50-flat OR 15%-percent thresholds (either trips,
// per-vendor overrides tighten/loosen), the RED banner fires and Approve is BLOCKED
// until the approver explicitly acknowledges. The banner UI is advisory; THIS module
// is the trust boundary — the decide route re-evaluates here and refuses an
// unacknowledged trip, never trusting the client's `varianceAcknowledged` flag.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import type { ApVarianceFlagState } from './extraction/types';

/// Global default thresholds (D-M5-4). Either-trips: whichever fires first flags.
export const VARIANCE_FLAT_THRESHOLD_CENTS = 5000; // $50.00 flat
export const VARIANCE_PERCENT_THRESHOLD = 0.15; // 15%
/// A baseline is ESTABLISHED (used for flagging) only at/above this invoice count.
export const BASELINE_MIN_INVOICES = 3;

/// Normalize a vendor name for baseline lookup + aggregation: trim, lowercase,
/// collapse internal whitespace. MUST match the key the baseline importer writes to
/// `ap_vendor_baseline_history.vendor_name_normalized` / `ap_vendor_baselines`.
export function normalizeVendorName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/// An established baseline with its EFFECTIVE thresholds (per-vendor overrides
/// already resolved against the global defaults).
export interface EstablishedBaseline {
  vendorDisplayName: string;
  invoiceCount: number;
  meanAmountCents: number;
  flatThresholdCents: number;
  percentThreshold: number;
}

/// The pure variance verdict for a confirmed amount against an established baseline.
export interface VarianceEvaluation {
  tripped: boolean;
  meanAmountCents: number;
  invoiceCount: number;
  /// abs(confirmed - mean), cents.
  varianceAbsCents: number;
  /// abs variance as a fraction of the mean (0.0-…); 0 when mean is 0.
  variancePct: number;
  direction: 'over' | 'under';
  flatThresholdCents: number;
  percentThreshold: number;
}

/**
 * PURE either-trips evaluation. Flags when the absolute delta from the baseline
 * mean exceeds the flat threshold OR the percentage delta exceeds the percent
 * threshold — whichever is stricter fires first (D-M5-4). No I/O, exhaustively
 * unit-tested.
 */
export function evaluateVariance(
  baseline: EstablishedBaseline,
  confirmedAmountCents: number,
): VarianceEvaluation {
  const diff = confirmedAmountCents - baseline.meanAmountCents;
  const abs = Math.abs(diff);
  const pct = baseline.meanAmountCents > 0 ? abs / baseline.meanAmountCents : 0;
  const tripped = abs > baseline.flatThresholdCents || pct > baseline.percentThreshold;
  return {
    tripped,
    meanAmountCents: baseline.meanAmountCents,
    invoiceCount: baseline.invoiceCount,
    varianceAbsCents: abs,
    variancePct: pct,
    direction: diff >= 0 ? 'over' : 'under',
    flatThresholdCents: baseline.flatThresholdCents,
    percentThreshold: baseline.percentThreshold,
  };
}

/**
 * Load the ESTABLISHED baseline for a freeform vendor, resolving per-vendor
 * threshold overrides against the global defaults. Returns null when the vendor
 * has no baseline row OR fewer than {@link BASELINE_MIN_INVOICES} historical
 * invoices (insufficient data → never flagged).
 */
export async function loadEstablishedBaseline(
  prisma: PrismaClient,
  vendorFreeform: string,
): Promise<EstablishedBaseline | null> {
  const norm = normalizeVendorName(vendorFreeform);
  if (!norm) return null;
  const b = await prisma.apVendorBaseline.findUnique({
    where: { vendor_name_normalized: norm },
  });
  if (!b || b.invoice_count < BASELINE_MIN_INVOICES) return null;
  const flat = b.variance_flat_override_cents ?? VARIANCE_FLAT_THRESHOLD_CENTS;
  // Decimal | number | null — Number() coerces the Prisma Decimal safely.
  const percent =
    b.variance_percent_override != null ? Number(b.variance_percent_override) : VARIANCE_PERCENT_THRESHOLD;
  return {
    vendorDisplayName: b.vendor_display_name,
    invoiceCount: b.invoice_count,
    meanAmountCents: b.mean_amount_cents,
    flatThresholdCents: flat,
    // Honor a per-vendor override of EXACTLY 0 (a legitimate tightening control:
    // "any variance at all trips") — matching the flat override's `??` semantics
    // where 0 is already honored. Treat "override is set" as not-null, not truthy;
    // only a negative/NaN value (bad data) falls back to the 15% default. `percent`
    // above already null-checks the source column, so this guard only rejects
    // malformed magnitudes, never a deliberate 0.
    percentThreshold: Number.isFinite(percent) && percent >= 0 ? percent : VARIANCE_PERCENT_THRESHOLD,
  };
}

/**
 * The variance FLAG STATE the decide service persists. `not_applicable` when no
 * established baseline; otherwise `below_threshold` or `above_threshold`. The route
 * promotes `above_threshold` → `acknowledged` only after the approver's explicit
 * acknowledgment (which the route enforces before commit).
 */
export async function evaluateVarianceForDecision(
  prisma: PrismaClient,
  vendorFreeform: string,
  confirmedAmountCents: number,
): Promise<{ state: ApVarianceFlagState; evaluation: VarianceEvaluation | null }> {
  const baseline = await loadEstablishedBaseline(prisma, vendorFreeform);
  if (!baseline) return { state: 'not_applicable', evaluation: null };
  const evaluation = evaluateVariance(baseline, confirmedAmountCents);
  return { state: evaluation.tripped ? 'above_threshold' : 'below_threshold', evaluation };
}

/// One recent historical invoice for the banner's "recent history" line.
export interface RecentInvoice {
  invoiceDate: string; // YYYY-MM-DD
  amountCents: number;
}

/// The full context the approver panel renders: whether an established baseline
/// exists, the evaluation, and the last 3 historical invoices.
export interface VarianceContext {
  established: boolean;
  vendorDisplayName?: string;
  evaluation?: VarianceEvaluation;
  recent?: RecentInvoice[];
}

/**
 * Assemble the approver-panel variance context for a typed vendor + confirmed
 * amount: the established baseline (if any), the evaluation, and the trailing 3
 * historical invoices. Backs the `/api/ops/ap/variance-check` endpoint — the same
 * evaluation the decide route enforces, so the banner never disagrees with the gate.
 */
export async function loadVarianceContext(
  prisma: PrismaClient = defaultPrisma,
  vendorFreeform: string,
  confirmedAmountCents: number,
): Promise<VarianceContext> {
  const baseline = await loadEstablishedBaseline(prisma, vendorFreeform);
  if (!baseline) return { established: false };
  const evaluation = evaluateVariance(baseline, confirmedAmountCents);
  const norm = normalizeVendorName(vendorFreeform);
  const recentRows = await prisma.apVendorBaselineHistory.findMany({
    where: { vendor_name_normalized: norm },
    orderBy: { invoice_date: 'desc' },
    take: 3,
    select: { invoice_date: true, invoice_amount_cents: true },
  });
  return {
    established: true,
    vendorDisplayName: baseline.vendorDisplayName,
    evaluation,
    recent: recentRows.map((r) => ({
      invoiceDate: r.invoice_date.toISOString().slice(0, 10),
      amountCents: r.invoice_amount_cents,
    })),
  };
}
