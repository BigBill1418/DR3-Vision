// ADR-0046 Amendment 9 (§2.5) — how old is an open equipment request?
//
// PACIFIC CALENDAR DAYS, not elapsed hours ÷ 24. The container clock is UTC and
// runs 7–8 hours ahead of Bill and the site managers, so a request filed at 5 pm
// Pacific is already "tomorrow" in UTC: a naive `Date` diff reports a request
// filed this afternoon as one day old, and the whole point of an aging queue is
// that the number matches what the person reading it believes. ADR-0065 put the
// Pacific day helpers in `@/lib/time` for exactly this class of bug; this module
// is a thin, testable application of them.

import { dayKeyUTCFromISO, pacificDayISO } from '@/lib/time';

/**
 * Whole Pacific calendar days between two instants. 0 = filed today (Pacific),
 * 1 = yesterday, and so on. Never negative — a clock skew that puts the request
 * marginally in the future reads as "today", not "-1 days".
 */
export function pacificAgeDays(requestedAt: Date, now: Date = new Date()): number {
  const then = dayKeyUTCFromISO(pacificDayISO(requestedAt)).getTime();
  const today = dayKeyUTCFromISO(pacificDayISO(now)).getTime();
  return Math.max(0, Math.round((today - then) / 86_400_000));
}

/** Operator-facing age label for the worklist. */
export function pacificAgeLabel(requestedAt: Date, now: Date = new Date()): string {
  const days = pacificAgeDays(requestedAt, now);
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}
