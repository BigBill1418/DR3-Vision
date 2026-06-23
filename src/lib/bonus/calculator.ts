// Bonus calculation engine (ADR-0019 §1).
//
// HARD RULE (CLAUDE.md / SPRINT-2-HANDOFF hard rule #3): bonus math is NEVER
// hardcoded. Every calculation pulls its parameters from a `processor_bonus_rules`
// row (the seed CSV is the source of truth). The UI (T-105), the PDF (T-112), and
// the aggregate views (T-118) all call through this single module so the number on
// screen, the number on the signed PDF, and the number in the CSV export can never
// diverge.
//
// The corrected Woodland formula (ADR-0019 §1, replacing the spreadsheet's
// off-by-one high threshold of 75):
//
//   daily_bonus = MAX(units - threshold_low, 0) * rate_low
//               + MAX(units - threshold_high, 0) * rate_high
//
// Woodland: threshold_low=50, rate_low=$0.50, threshold_high=74, rate_high=$0.25.
//   - Mattresses 51–74 each earn $0.50.
//   - Mattresses 75+ each earn $0.75 ($0.50 base + $0.25 high tier).
//
// All money is computed and stored as integer CENTS to avoid floating-point drift;
// `formatCents` is the only place a dollar string is produced.

/**
 * The subset of a `processor_bonus_rules` row the calculator needs. Accepts the
 * Prisma `Decimal` rates as `number | string` (Prisma returns `Decimal`; both
 * `Number(decimal)` and `decimal.toString()` are accepted here).
 */
export interface BonusRuleParams {
  threshold_low: number;
  rate_low: number | string;
  threshold_high: number;
  rate_high: number | string;
}

/**
 * Convert a dollars-per-unit rate to integer cents-per-unit. Exact for the 2–4
 * decimal-place rates the rule table uses ($0.50 → 50, $0.25 → 25, $1.00 → 100).
 */
function ratePerUnitCents(rate: number | string): number {
  return Math.round(Number(rate) * 100);
}

/**
 * Daily bonus for a single processor, in integer cents. Non-positive, non-finite,
 * or below-threshold *numeric* counts return 0. Fractional counts are floored (counts
 * are whole mattresses; the schema enforces Int, this is belt-and-suspenders).
 *
 * A non-`number` `units` (e.g. a Prisma `Decimal` object or a numeric string) THROWS.
 * This is deliberate payroll hardening: a Decimal silently fails `Number.isFinite`,
 * which previously made every entry contribute 0 and locked a real Woodland period to
 * $0 (2026-06 incident). A payout calc must never silently yield 0 from a type error —
 * callers MUST coerce with `.toNumber()` (see signatures.ts `toCount`) before calling.
 */
export function calculateDailyBonusCents(units: number, rule: BonusRuleParams): number {
  if (typeof units !== 'number') {
    throw new TypeError(
      `calculateDailyBonusCents expected a number, got ${typeof units} — coerce Prisma Decimal via .toNumber() first`,
    );
  }
  if (!Number.isFinite(units) || units <= 0) return 0;
  const u = Math.floor(units);
  const lowTier = Math.max(u - rule.threshold_low, 0) * ratePerUnitCents(rule.rate_low);
  const highTier = Math.max(u - rule.threshold_high, 0) * ratePerUnitCents(rule.rate_high);
  return lowTier + highTier;
}

/**
 * Sum of daily bonuses across a list of per-day mattress counts, in integer cents.
 */
export function calculateMonthlyBonusCents(unitsPerDay: number[], rule: BonusRuleParams): number {
  return unitsPerDay.reduce((sum, units) => sum + calculateDailyBonusCents(units, rule), 0);
}

/**
 * Format integer cents as a US-dollar string, e.g. 1275 → "$12.75", 0 → "$0.00".
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

/**
 * Convenience: daily bonus as a formatted dollar string. Mirrors the ADR-0019 §1
 * walk-through table ("calculateDailyBonus(74) returns $12.00").
 */
export function calculateDailyBonus(units: number, rule: BonusRuleParams): string {
  return formatCents(calculateDailyBonusCents(units, rule));
}
