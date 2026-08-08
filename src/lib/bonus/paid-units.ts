// ADR-0083 — what counts as a PAID unit on a bonus daily entry.
//
// This module exists so that the answer to "how many units did this processor
// get paid for that day?" is written down EXACTLY ONCE. Before saves there was
// one column and the question was trivial; with two columns it is a policy, and
// a policy duplicated across ~9 read paths is a policy that will drift. The
// on-screen grid, the signed PDF, the sign-time lock, the CSV export, the
// month list, the aggregates and the ADR-0033 reconcile tripwire all call
// `dailyPaidUnits` — so the number on the screen, the number on the signed PDF
// and the number the reconciler independently recomputes cannot diverge.
//
// ─────────────────────────────────────────────────────────────────────────
// THE POLICY: paid units = mattress_count + saves, tiered ONCE
// ─────────────────────────────────────────────────────────────────────────
//
// JT: "they also get paid for every mattress saved to sell." Bill: saves pay at
// the processing rate, through the same bonus entry, under the same amendment
// rules. So a save is a paid unit indistinguishable from a processed one, and
// the day's bonus is `calculateDailyBonusCents(mattress_count + saves, rule)` —
// ONE call, on the summed total.
//
// The alternative — bonus(mattress_count) + bonus(saves) — is WRONG, and not
// subtly. The Woodland rule is tiered, not flat:
//
//     daily_bonus = MAX(units - 50, 0) * $0.50 + MAX(units - 74, 0) * $0.25
//
// Computing the two columns separately applies the 50-unit threshold TWICE,
// granting each processor a second unpaid allowance. A day of 40 processed + 20
// saved is 60 units of work: summed it pays (60-50) * $0.50 = $5.00; separately
// it pays $0.00 + $0.00 = nothing at all. The separate model would have meant
// "we added a saves column and nobody was ever paid for a save" for any
// processor whose two columns each sat under the threshold — which is most of
// them. Summing is what "pays at the processing rate" means.
//
// Pinned by `__tests__/paid-units.test.ts` (the sub-threshold-crossing case is
// the one that would silently pay $0 under the wrong model).
//
// ─────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT: saves are paid units, NOT processed units
// ─────────────────────────────────────────────────────────────────────────
//
// A saved mattress is diverted to resale; a processed mattress is torn down for
// commodity. They are DISJOINT quantities keyed in two separate columns, and no
// mattress is ever in both. That is what makes the double-count structurally
// impossible rather than merely avoided:
//
//   • PAY paths (this module)      → mattress_count + saves
//   • PRODUCTION-QUANTITY paths    → mattress_count ALONE
//
// Production-quantity paths are deliberately NOT changed by ADR-0083:
// `daily-report.ts` (the MTD/annual production figures and the 8 PM report) and
// `processor-quota.ts` (the ADR-0071 throughput quota) both measure mattresses
// PROCESSED. Adding saves there would inflate a production number with units
// that were never torn down, and those numbers sit adjacent to MRC billing.
// Each of those call sites carries a comment pointing here so the omission
// reads as a decision rather than an oversight.
//
// The resale-inventory leg lives in `saves-inventory.ts`, not here: a save
// records an `on_floor → saved` movement and deliberately does NOT decrement
// the live floor balance (Rick's model — saved units stay on the floor until a
// store transfer). See ADR-0083 §"Inventory leg" and ADR-0037's amendment.

import { calculateDailyBonusCents, type BonusRuleParams } from '@/lib/bonus/calculator';

/**
 * `mattress_count` and `saves` are Prisma `Decimal`s at runtime (both
 * `Decimal(5,1)`). The DB row carries Decimal objects, NOT JS numbers — passing
 * one raw to the cents calculator makes `Number.isFinite(Decimal)` false and, in
 * the pre-hardening calculator, silently zeroed the payout (the 2026-06 Woodland
 * $0-lock incident). We accept "a Decimal or a plain number" structurally and
 * coerce at the boundary.
 *
 * Structural rather than a Prisma import so the pure/testable layers and the
 * `SignatureDb` structural client can both use it without dragging in the
 * generated client.
 */
export type DecimalLike = number | { toNumber(): number };

/**
 * Coerce one `Decimal(5,1)` unit column to a JS number.
 *
 * THROWS on an unexpected shape rather than letting a bad value silently become
 * 0 — a payout must never be silently dropped. `field` names the column in the
 * error so a failure says WHICH of the two columns was wrong; a message reading
 * only "did not coerce" would leave you bisecting a payroll path.
 */
export function toUnitCount(value: DecimalLike, field: string): number {
  const n = typeof value === 'number' ? value : value.toNumber();
  if (!Number.isFinite(n)) {
    throw new TypeError(`${field} did not coerce to a finite number (got ${String(value)})`);
  }
  return n;
}

/** The two unit columns of a bonus daily entry, as they arrive from Prisma. */
export interface PaidUnitsRow {
  mattress_count: DecimalLike;
  saves: DecimalLike;
}

/**
 * The day's PAID unit total for one entry: processed + saved.
 *
 * This is the ONLY place the two columns are combined. Every bonus-dollar read
 * path calls it (or `dailyBonusCentsFor`, which wraps it) so the tier thresholds
 * are applied exactly once to the day's total work.
 *
 * `saves` is tolerated as `null`/`undefined` ONLY to keep hand-built test
 * fixtures and legacy in-memory rows honest — the column is NOT NULL DEFAULT 0
 * in the database, so a real row always carries a value and this branch is
 * never taken in production. It is a real zero, not a not-recorded (see the
 * migration's reasoning): every historical row predates the column on a floor
 * that was not capturing saves for bonus at all.
 */
export function dailyPaidUnits(row: {
  mattress_count: DecimalLike;
  saves?: DecimalLike | null;
}): number {
  const processed = toUnitCount(row.mattress_count, 'mattress_count');
  const saved = row.saves == null ? 0 : toUnitCount(row.saves, 'saves');
  return processed + saved;
}

/**
 * The day's bonus in integer cents for one entry, tiered once over the summed
 * paid units. The single funnel from "a DB row" to "money".
 */
export function dailyBonusCentsFor(
  row: { mattress_count: DecimalLike; saves?: DecimalLike | null },
  rule: BonusRuleParams,
): number {
  return calculateDailyBonusCents(dailyPaidUnits(row), rule);
}

/**
 * Sum of daily bonuses across a list of entries, in integer cents. The
 * period-level equivalent used by the sign-time lock and the ADR-0033
 * reconcile recompute — the two computations of a payout that must agree.
 */
export function periodBonusCentsFor(
  rows: Array<{ mattress_count: DecimalLike; saves?: DecimalLike | null }>,
  rule: BonusRuleParams,
): number {
  return rows.reduce((sum, row) => sum + dailyBonusCentsFor(row, rule), 0);
}
