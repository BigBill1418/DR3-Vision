// ADR-0040 amendment (2026-07-18, rollup §3.6, closes open item C-10) — the container /
// trailer rental NEVER-PRORATE policy, encoded explicitly.
//
// POLICY: a container rental bills its FULL monthly rate for ANY overlap with a billing
// month — it is NEVER prorated by day. A rental that starts on the 28th and spans into
// the next month bills the full monthly rate in BOTH months. There is no partial-month
// charge anywhere in the rental path.
//
// This module makes that policy a pure, tested unit instead of an implicit property of a
// Prisma `where` clause. `resolveRentals` (invoices/generation-inputs.ts) uses
// `monthWindowUTC` for the month bounds and mirrors `rentalOverlapsMonth` in its query;
// `billedRentalCents` is the (deliberately trivial) charge function — it returns the full
// monthly rate unchanged, so any future "let's prorate" change has to delete an explicit
// policy function and its tests, not just tweak an arithmetic expression.

/** A container_rental_sites row's fields relevant to month selection + charging. */
export interface RentalPeriod {
  effective_from: Date;
  effective_to: Date | null;
  monthly_rate_cents: number;
}

export interface MonthWindow {
  /** UTC midnight of the 1st of the month. */
  monthStart: Date;
  /** UTC midnight of the LAST day of the month. */
  monthEnd: Date;
}

/**
 * The [firstDay, lastDay] UTC window of the calendar month containing `anyDayInMonth`.
 * `monthEnd` is the month's last day (via day-0 of the next month), matching the
 * inclusive `effective_to >= monthStart` overlap test.
 */
export function monthWindowUTC(anyDayInMonth: Date): MonthWindow {
  const y = anyDayInMonth.getUTCFullYear();
  const m = anyDayInMonth.getUTCMonth();
  return {
    monthStart: new Date(Date.UTC(y, m, 1)),
    monthEnd: new Date(Date.UTC(y, m + 1, 0)),
  };
}

/**
 * True iff a rental is in force at any point during the month — i.e. it began on or
 * before the month's last day AND (is open-ended OR ended on or after the month's first
 * day). This is the never-prorate selection: overlap by even one day selects the whole
 * month. Mirrors the Prisma `where` in `resolveRentals`.
 */
export function rentalOverlapsMonth(rental: RentalPeriod, window: MonthWindow): boolean {
  const startsByMonthEnd = rental.effective_from.getTime() <= window.monthEnd.getTime();
  const notEndedBeforeMonth =
    rental.effective_to === null ||
    rental.effective_to.getTime() >= window.monthStart.getTime();
  return startsByMonthEnd && notEndedBeforeMonth;
}

/**
 * The amount a selected rental bills for a month: the FULL monthly rate, never prorated
 * (§3.6). Intentionally trivial — it exists so the never-prorate policy is a named,
 * tested function rather than an inline pass-through that could quietly grow proration.
 */
export function billedRentalCents(rental: Pick<RentalPeriod, 'monthly_rate_cents'>): number {
  return rental.monthly_rate_cents;
}
