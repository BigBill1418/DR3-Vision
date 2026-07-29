// ADR-0066 §1.5 — the WEEKDAY business clock shared by the escalation scanner
// and the morning digest.
//
// Bill's decision, verbatim: *"weekdays only. The clock pauses Friday evening and
// resumes Monday."* A request first-approved at 4pm Friday must NOT escalate at
// 4pm Saturday — it escalates at 4pm Monday.
//
// WHY A SHARED MODULE: §1.5 says to reuse the existing weekend/holiday skip logic
// from `scripts/bonus-eod-check.mjs` rather than writing a second calendar. That
// script is an .mjs daemon and its skip is a single `dateParts.isWeekend` guard —
// a *same-day* question ("is today a business day?"), not the *elapsed-business-
// hours* question escalation needs. So the honest move is to factor the calendar
// concept into one place both can express, rather than pretend the existing
// one-liner already answers this. The Pacific-day primitives come from
// `@/lib/time` (ADR-0065) — no new date arithmetic, per §B.6.
//
// HOLIDAYS: `site_holidays` is per-SITE, but escalation is per-PERSON under
// ADR-0066 routing and no longer carries a site. A holiday therefore only pauses
// the clock when EVERY active site observes it — the conservative reading, since
// pausing on one site's holiday would delay an escalation the other site's staff
// were working through.

import type { PrismaClient } from '@prisma/client';
import { pacificDayISO, pacificDayStartInstant, pacificDayStartInstantPlus } from '@/lib/time';

/** Saturday/Sunday in Pacific terms. */
export function isPacificWeekend(instant: Date): boolean {
  // The Pacific day key's UTC components ARE the Pacific calendar day, so reading
  // the weekday in UTC off that key is correct (same invariant `formatDay` relies on).
  const iso = pacificDayISO(instant);
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

/**
 * Pacific day keys (`YYYY-MM-DD`) that are holidays at EVERY active site — the
 * only ones that pause a person-scoped clock (see the HOLIDAYS note above).
 */
export async function fleetWideHolidays(
  prisma: PrismaClient,
  fromISO: string,
  toISO: string,
): Promise<Set<string>> {
  const siteCount = await prisma.site.count();
  if (siteCount === 0) return new Set();
  const rows = await prisma.siteHoliday.findMany({
    where: {
      holiday_date: {
        gte: new Date(`${fromISO}T00:00:00Z`),
        lte: new Date(`${toISO}T00:00:00Z`),
      },
    },
    select: { holiday_date: true, site_id: true },
  });
  const bySite = new Map<string, Set<string>>();
  for (const r of rows) {
    const key = r.holiday_date.toISOString().slice(0, 10);
    if (!bySite.has(key)) bySite.set(key, new Set());
    bySite.get(key)!.add(r.site_id);
  }
  const out = new Set<string>();
  for (const [day, sites] of bySite) if (sites.size >= siteCount) out.add(day);
  return out;
}

/** A Pacific day that accrues business time: not a weekend, not a fleet holiday. */
export function isBusinessDay(instant: Date, holidays: ReadonlySet<string>): boolean {
  if (isPacificWeekend(instant)) return false;
  return !holidays.has(pacificDayISO(instant));
}

/**
 * Business hours elapsed between `from` and `to`, counting ONLY the portions that
 * fall on business days.
 *
 * Deliberately whole-day granularity rather than 9-to-5 windows: §1.5 asks for a
 * weekday clock that pauses over weekends, not an office-hours clock. A request
 * first-approved at 20:00 Thursday is 24 business hours old at 20:00 Friday.
 * Adding shift boundaries would be inventing policy Bill did not state.
 *
 * Guards against a pathological range with a hard iteration cap — a corrupt
 * `first_approved_at` far in the past must not spin the scanner.
 */
export function businessHoursBetween(
  from: Date,
  to: Date,
  holidays: ReadonlySet<string>,
  maxDays = 400,
): number {
  if (to <= from) return 0;
  let ms = 0;
  let cursor = from;
  let guard = 0;
  while (cursor < to && guard++ < maxDays) {
    const dayEnd = pacificDayStartInstantPlus(1, cursor);
    const segmentEnd = dayEnd < to ? dayEnd : to;
    if (isBusinessDay(cursor, holidays)) ms += segmentEnd.getTime() - cursor.getTime();
    // Defensive: a zero-width segment would loop forever. `pacificDayStartInstantPlus`
    // returned the base instant on the DST fall-back day before ADR-0065 fixed it, so
    // this guard is not hypothetical. Compare BEFORE advancing — an earlier revision
    // assigned `cursor = segmentEnd` first, which made the equality trivially true and
    // silently skipped an hour on every iteration (24h read as 23h).
    if (segmentEnd.getTime() <= cursor.getTime()) {
      cursor = new Date(cursor.getTime() + 3_600_000);
      continue;
    }
    cursor = segmentEnd;
  }
  return ms / 3_600_000;
}

/**
 * Has `firstApprovedAt` aged past `thresholdHours` of BUSINESS time as of `now`?
 * The question the escalation scanner asks of every un-escalated request.
 */
export async function businessHoursElapsedExceeds(
  prisma: PrismaClient,
  firstApprovedAt: Date,
  thresholdHours: number,
  now: Date = new Date(),
): Promise<boolean> {
  const holidays = await fleetWideHolidays(
    prisma,
    pacificDayISO(firstApprovedAt),
    pacificDayISO(now),
  );
  return businessHoursBetween(firstApprovedAt, now, holidays) >= thresholdHours;
}

/** Is `now` inside a business day? Gates the digest send (§1.7 weekdays only). */
export async function isBusinessDayNow(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<boolean> {
  const iso = pacificDayISO(now);
  const holidays = await fleetWideHolidays(prisma, iso, iso);
  return isBusinessDay(now, holidays);
}

/** Re-exported so consumers never reach for their own day arithmetic. */
export { pacificDayISO, pacificDayStartInstant, pacificDayStartInstantPlus };
