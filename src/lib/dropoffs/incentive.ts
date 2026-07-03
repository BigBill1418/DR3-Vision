// ADR-0037 D3 — consumer drop-off incentive: a PURE, named cap function.
//
// `incentive_cents = units × collector_incentive_rate`, capped at
// `daily_cap_units` PER person_name PER site PER dropoff_date. The cap applies
// to UNITS paid, not dollars: a person who drops 3 units in the morning and 4 in
// the afternoon (7 total) under a 5-unit cap is paid for 5 units total; the
// remaining 2 are recorded but earn no incentive.
//
// This module is pure — no DB, no clock. The DB aggregation (sum of prior
// same-day paid units for this person at this site) lives in the dropoffs
// service, which passes `priorPaidUnitsToday` in. Keeping the cap math pure is
// the point: it is the one tested source of truth for the incentive number,
// mirroring the bonus calculator's cents discipline.
//
// Money is integer CENTS. Units are whole mattresses (Int); a non-integer or
// non-finite input THROWS rather than silently yielding a wrong payout — the
// same hardening the bonus calculator applies (2026-06 $0-lock lesson).

/** Inputs to the cap computation. All counts are whole units; rate is cents/unit. */
export interface IncentiveInput {
  /** Units in THIS drop-off. */
  units: number;
  /** `collector_incentive` rate in integer cents per unit (from the D1 resolver). */
  rateCents: number;
  /** `params.daily_cap_units` for the active rule (e.g. 5). */
  dailyCapUnits: number;
  /**
   * Sum of units ALREADY PAID (under the cap) to this person at this site earlier
   * on this same drop-off date. The dropoffs service computes this by aggregating
   * prior same-day rows; a first drop-off of the day passes 0.
   */
  priorPaidUnitsToday: number;
}

/** Result of the cap computation. `paidUnits + cappedUnits === input.units`. */
export interface IncentiveResult {
  /** Units in THIS drop-off that fall under the remaining daily cap (earn incentive). */
  paidUnits: number;
  /** Units in THIS drop-off above the cap (recorded, but earn no incentive). */
  cappedUnits: number;
  /** `paidUnits × rateCents`. Never negative; 0 when the cap is exhausted. */
  incentiveCents: number;
}

function assertWholeNonNegative(name: string, n: number): void {
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new TypeError(`${name} must be a whole, non-negative, finite number (got ${String(n)})`);
  }
}

/**
 * Compute the incentive for a single drop-off under the per-person-per-day cap.
 *
 * Edge behavior (see tests):
 *   - exactly at cap → the whole drop-off is paid, remaining cap becomes 0
 *   - over cap across two drop-offs same day → only the remainder up to the cap
 *     is paid on the second drop-off
 *   - different people same day → each starts at `priorPaidUnitsToday = 0`
 *   - same person different days → `priorPaidUnitsToday = 0` again
 */
export function computeDropoffIncentive(input: IncentiveInput): IncentiveResult {
  assertWholeNonNegative('units', input.units);
  assertWholeNonNegative('rateCents', input.rateCents);
  assertWholeNonNegative('dailyCapUnits', input.dailyCapUnits);
  assertWholeNonNegative('priorPaidUnitsToday', input.priorPaidUnitsToday);

  const remainingCap = Math.max(input.dailyCapUnits - input.priorPaidUnitsToday, 0);
  const paidUnits = Math.min(input.units, remainingCap);
  const cappedUnits = input.units - paidUnits;
  const incentiveCents = paidUnits * input.rateCents;
  return { paidUnits, cappedUnits, incentiveCents };
}

/**
 * Recover the paid-unit count from a previously stored `incentive_cents`.
 *
 * The cap aggregation needs "prior paid units," but only `incentive_cents` is
 * persisted. Because the incentive rate is effective-dated and therefore constant
 * within a single calendar day, `paidUnits = incentive_cents / rateCents` is
 * exact. Returns 0 for a null/absent prior incentive. THROWS on a non-divisible
 * value (a rate change mid-day, or corrupt data) rather than guessing.
 */
export function paidUnitsFromIncentiveCents(
  incentiveCents: number | null | undefined,
  rateCents: number,
): number {
  if (incentiveCents == null || incentiveCents === 0) return 0;
  assertWholeNonNegative('incentiveCents', incentiveCents);
  if (!Number.isInteger(rateCents) || rateCents <= 0) {
    throw new TypeError(`rateCents must be a positive integer (got ${String(rateCents)})`);
  }
  if (incentiveCents % rateCents !== 0) {
    throw new RangeError(
      `incentive_cents ${incentiveCents} is not divisible by rateCents ${rateCents} — cannot recover paid units`,
    );
  }
  return incentiveCents / rateCents;
}
