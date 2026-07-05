// ADR-0045 D2 — pure calendar functions for the digest tick.
//
// All functions operate on a `@db.Date`-shaped Date (UTC midnight whose UTC
// Y/M/D ARE the Pacific calendar day — the app's canonical business-day
// representation, see src/lib/time.ts). They read UTC components only, so they
// are deterministic and DST-free. No imports — trivially unit-testable.
//
// Weekly Updates digest: generated every MONDAY, covering the PRIOR week
// (Mon–Sun). Board pack (Bethany's cadence, survey §E): generated on the 2nd
// WEDNESDAY of the month AND the MONDAY immediately preceding it.

const DAY_MS = 86_400_000;

/** UTC weekday of a day-key Date: 0=Sun … 1=Mon … 3=Wed … 6=Sat. */
function weekday(dayKey: Date): number {
  return dayKey.getUTCDay();
}

function makeDayKey(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d));
}

/** True iff the day-key is a Monday (Pacific). */
export function isWeeklyGenerationDay(dayKey: Date): boolean {
  return weekday(dayKey) === 1;
}

/**
 * The prior full week for a Monday generation day: the Monday 7 days back
 * through the Sunday 1 day back. Both are day-key Dates. Defined for any input
 * day, but the tick only calls it on a Monday.
 */
export function previousWeekRange(dayKey: Date): { start: Date; end: Date } {
  const start = new Date(dayKey.getTime() - 7 * DAY_MS);
  const end = new Date(dayKey.getTime() - 1 * DAY_MS);
  return { start, end };
}

/** Day-of-month (1..7 with a possible 8..14 second) of the 2nd Wednesday. */
export function secondWednesdayOfMonth(year: number, month0: number): number {
  const firstDow = makeDayKey(year, month0, 1).getUTCDay(); // 0=Sun..6=Sat
  // First Wednesday date: shift from the 1st to the next Wed (3).
  const firstWed = 1 + ((3 - firstDow + 7) % 7);
  return firstWed + 7;
}

/**
 * True iff the day-key is a board-pack generation day: the 2nd Wednesday of its
 * month, OR the Monday immediately preceding that 2nd Wednesday (2 days earlier,
 * always in the same month since the 2nd Wed lands on the 8th–14th).
 */
export function isBoardPackDay(dayKey: Date): boolean {
  const y = dayKey.getUTCFullYear();
  const m0 = dayKey.getUTCMonth();
  const d = dayKey.getUTCDate();
  const secondWed = secondWednesdayOfMonth(y, m0);
  if (weekday(dayKey) === 3 && d === secondWed) return true; // the 2nd Wednesday
  if (weekday(dayKey) === 1 && d === secondWed - 2) return true; // preceding Monday
  return false;
}

/** First-of-month day-key for the month BEFORE the given day-key's month. */
export function previousMonthStart(dayKey: Date): Date {
  const y = dayKey.getUTCFullYear();
  const m0 = dayKey.getUTCMonth();
  return makeDayKey(y, m0 - 1, 1); // Date.UTC normalizes m0 = -1 → prior Dec
}

/** Last-of-month day-key for the month BEFORE the given day-key's month. */
export function previousMonthEnd(dayKey: Date): Date {
  const y = dayKey.getUTCFullYear();
  const m0 = dayKey.getUTCMonth();
  return makeDayKey(y, m0, 0); // day 0 of this month = last day of prior month
}
