// ADR-0040 amendment (2026-07-18, rollup §3.7) — the CA "Event Mile Rate" tier lookup.
//
// RECONCILIATION (read this before adding a new table): the Event Mile Rate tier
// (rollup §3.7, workbook Variables!D6:F13) IS the existing `transport_rate_tiers` CA
// set — same seven mileage bands, same flat cents, same effective date (2026-01-01),
// already seeded (`prisma/seed.mjs` `seedTransportRateTiers`) and already validated on
// every write by `tier-validation.ts` (contiguous-from-0, non-overlapping). Standing up
// a second `event_mile_tier` table would fork ONE set of rates into TWO independently-
// editable sources of truth for the SAME numbers — a billing-correctness hazard (they
// drift, and an invoice silently prices off the stale one). So this module does NOT add
// a table: it is the named, fail-loud MILEAGE→FLAT-RATE resolver over the CA
// `transport_rate_tiers` rows, for the Woodland freight fallback (§3.5) and any §7/0041
// caller that already holds the tier set in memory.
//
// It reuses `tierForMiles` (the same inclusive `min <= miles <= max` band math the
// DB-filtered `resolveFreightCents` uses), so the pure and DB paths agree by
// construction. Out-of-range is a TYPED error, never a silent $0 (ADR-0040 D7).

import { tierForMiles, type ProposedTier } from './tier-validation';

/** A mileage fell outside every seeded Event Mile Rate band (e.g. > 500 mi, or < 0). */
export class EventMileRateOutOfRangeError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly miles: number,
    readonly context: { min_miles: number | null; max_miles: number | null },
  ) {
    super(
      `mileage ${miles} is outside the Event Mile Rate tier table ` +
        `[covered ${context.min_miles ?? 'n/a'}–${context.max_miles ?? 'n/a'} mi]`,
    );
    this.name = 'EventMileRateOutOfRangeError';
  }
}

/**
 * Flat freight cents for `miles` from a CA Event Mile Rate tier set (= the source's
 * in-force `transport_rate_tiers` CA rows). Assumes a VALIDATED set (the writer enforces
 * contiguity/non-overlap via `assertValidTierSet`), so at most one band matches.
 *
 * Throws {@link EventMileRateOutOfRangeError} when no band covers `miles` — a freight
 * fallback MUST NOT silently bill $0. `miles` must be a finite integer ≥ 0.
 */
export function resolveEventMileRateCents(
  tiers: readonly ProposedTier[],
  miles: number,
): number {
  if (!Number.isInteger(miles) || miles < 0) {
    throw new EventMileRateOutOfRangeError(miles, bounds(tiers));
  }
  const band = tierForMiles(tiers, miles);
  if (!band) throw new EventMileRateOutOfRangeError(miles, bounds(tiers));
  return band.rate_cents;
}

/** The covered [min, max] mileage span of a set — for the out-of-range error message. */
function bounds(tiers: readonly ProposedTier[]): { min_miles: number | null; max_miles: number | null } {
  if (tiers.length === 0) return { min_miles: null, max_miles: null };
  return {
    min_miles: Math.min(...tiers.map((t) => t.min_miles)),
    max_miles: Math.max(...tiers.map((t) => t.max_miles)),
  };
}
