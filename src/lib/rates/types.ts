// ADR-0043 D1 — rate computation shared types.
//
// The rate functions in this directory are PURE (no DB, no clock) — they take
// pre-aggregated window inputs and return a `RateResult`. The *why* travels with
// the number (Morena Q4: show why, not just red/green): `components` carries the
// contributing terms and `estimatedInputs` flags whenever the 55-lb
// unit-weight estimate contributed, so every figure derived from it can be
// marked `estimated` downstream (the finding detail + the dashboard badge).

/**
 * The Addendum-B unit-weight estimate: 55 lb per whole unit, `estimate_only`.
 * Every rate figure that depends on this carries `estimatedInputs: true`.
 * When Kelsey's %-column semantics and the B10-5 destination mapping land,
 * precision improves without a redesign.
 */
export const UNIT_WEIGHT_ESTIMATE_LBS = 55;

/**
 * A rate over a window. `rate` is a fraction in [0, 1] — NOT a percentage.
 * A zero denominator yields a typed no-data result (`noData: true`, `rate:
 * null`) — never `NaN` and never a division blow-up (D1 test-plan invariant).
 */
export interface RateResult {
  /** Fraction in [0, 1], or `null` when there is no data to rate. */
  rate: number | null;
  numerator: number;
  denominator: number;
  /** The contributing terms — the explanation that travels with the number. */
  components: Record<string, number>;
  /** True when the 55-lb unit-weight estimate contributed to the result. */
  estimatedInputs: boolean;
  /** True when the denominator was zero (nothing to rate). */
  noData: boolean;
}

/** Build a typed no-data result (zero denominator → never NaN/throw). */
export function noDataResult(
  components: Record<string, number>,
  estimatedInputs: boolean,
): RateResult {
  return { rate: null, numerator: 0, denominator: 0, components, estimatedInputs, noData: true };
}
