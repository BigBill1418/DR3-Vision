// Single source of truth for application time (TZ-bug fix, 2026-06-06).
//
// ── Why this module exists ───────────────────────────────────────────
// The fleet hosts (incl. CHAD-HQ, where DR3-Vision runs) keep their system
// clocks in UTC. Bill and BOTH facilities (Woodland CA + Eugene OR) operate
// on America/Los_Angeles. For ~7 months of the year Pacific is UTC-7, so a
// late-evening Pacific instant (e.g. 10:50 PM PDT on Jun 5) is already past
// UTC midnight (05:50 UTC on Jun 6). Any "today"/"this month" computed from
// the UTC components of `new Date()` is therefore off by one calendar day.
// That is exactly the bug Bill hit: the daily-entry page said "6/6/26" at
// 10:50 PM Pacific on Jun 5.
//
// The fix: derive the business calendar day from the PACIFIC zone via
// `Intl.DateTimeFormat`, never from the server clock / `TZ` env. This module
// is the only place that knows the zone; everything else calls these helpers.
//
// ── @db.Date representation invariant (READ THIS) ────────────────────
// The bonus date columns (`bonus_daily_entries.entry_date`, `bonus_pay_periods.*`,
// `site_holidays.holiday_date`, `processor_bonus_rules.*`) are Postgres
// `@db.Date` — a zone-less calendar day. Prisma materializes such a value as
// a JS `Date` at UTC midnight of that calendar day. So the canonical in-app
// representation of a business day is: a `Date` whose UTC Y/M/D ARE the
// Pacific calendar Y/M/D, pinned to 00:00:00.000Z.
//
// Consequence:
//   - To COMPUTE "today", read the Pacific Y/M/D and build UTC midnight from
//     them (`appToday()` / `pacificDayKeyUTC()`). This is the one shift.
//   - To DISPLAY a value already stored in a @db.Date column, render it with
//     `timeZone: 'UTC'`, because its UTC components already ARE the intended
//     Pacific calendar day. `pacificDateLabel()` does exactly this. Do NOT
//     re-shift a stored @db.Date through the Pacific zone or you move it back
//     a day.
//   - A true INSTANT (e.g. an audit `timestamp`, a signature `signed_at`,
//     `pdf_generated_at`) is a real point in time; render it in the Pacific
//     zone with `formatPacificDateTime()` so Bill sees his wall clock.

import type { Locale } from '@/i18n/config';
import { DEFAULT_LOCALE } from '@/i18n/config';

export const PACIFIC_TZ = 'America/Los_Angeles';

const INTL_LOCALE: Record<Locale, string> = {
  en: 'en-US',
  es: 'es-MX',
  ur: 'ur-PK',
};

// en-CA yields ISO-ordered `YYYY-MM-DD` parts — the cleanest way to read a
// zoned calendar date out of Intl without manual part-stitching ambiguity.
const PACIFIC_ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const PACIFIC_WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
});

// ────────────────────────────────────────────────────────────────────
// Pacific calendar-day computation (the bug fix)
// ────────────────────────────────────────────────────────────────────

/** The Pacific calendar day of `instant` as `YYYY-MM-DD`. */
export function pacificDayISO(instant: Date = new Date()): string {
  return PACIFIC_ISO_FMT.format(instant);
}

/**
 * Convert a `YYYY-MM-DD` calendar day to its canonical @db.Date Date:
 * UTC midnight of that day. Throws on a malformed string so a bad caller
 * can never silently write the wrong day.
 */
export function dayKeyUTCFromISO(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new RangeError(`invalid calendar day: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * The UTC-midnight @db.Date key for the Pacific calendar day of `instant`.
 * This is the value to compare against / write into @db.Date columns.
 */
export function pacificDayKeyUTC(instant: Date = new Date()): Date {
  return dayKeyUTCFromISO(pacificDayISO(instant));
}

/**
 * The current business "today" as a @db.Date-shaped Date (UTC midnight of
 * the Pacific calendar day). THE canonical replacement for `new Date()` in
 * every "today" computation. Optional `instant` for deterministic tests.
 */
export function appToday(instant: Date = new Date()): Date {
  return pacificDayKeyUTC(instant);
}

/** The current Pacific calendar day as `YYYY-MM-DD` (for client default values). */
export function appTodayISO(instant: Date = new Date()): string {
  return pacificDayISO(instant);
}

/**
 * The @db.Date-shaped day one calendar day before `day`. Safe across DST: a
 * @db.Date is a pure UTC-midnight date with no wall-clock, so subtracting 24h
 * always lands on the previous calendar day. Used by the period-close cron
 * (ADR-0019.1 amendment): the close fires at 07:00 PT the day AFTER period_end,
 * so it targets `previousDayKey(appToday())`.
 */
export function previousDayKey(day: Date): Date {
  return new Date(day.getTime() - 86_400_000);
}

/** First-of-month (UTC midnight) for the Pacific calendar month of `instant`. */
export function appCurrentMonthStart(instant: Date = new Date()): Date {
  const d = appToday(instant);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** The current Pacific calendar year (e.g. 2026). */
export function appCurrentYear(instant: Date = new Date()): number {
  return appToday(instant).getUTCFullYear();
}

/** True iff the Pacific calendar day of `instant` is Saturday or Sunday. */
export function isPacificWeekend(instant: Date = new Date()): boolean {
  const wd = PACIFIC_WEEKDAY_FMT.format(instant);
  return wd === 'Sat' || wd === 'Sun';
}

// ────────────────────────────────────────────────────────────────────
// Pacific local-midnight as a true UTC instant (for instant-column filters)
// ────────────────────────────────────────────────────────────────────

// Parts formatter to recover the wall-clock a UTC instant shows in Pacific.
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The signed offset (ms) such that `utc = pacificWallClockAsUTC - offset`. */
function pacificOffsetMs(at: Date): number {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  // The wall-clock Pacific shows, reinterpreted as if it were UTC.
  const asUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUTC - at.getTime();
}

/**
 * The true UTC instant of Pacific local midnight (00:00:00) for the Pacific
 * calendar day of `instant`. DST-correct. Use this to bound queries against
 * INSTANT columns (e.g. loads `created_at`) by a Pacific business day — distinct
 * from `appToday()`, which is the @db.Date-shaped key for date-only columns.
 */
export function pacificDayStartInstant(instant: Date = new Date()): Date {
  const iso = pacificDayISO(instant);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)!;
  // First approximation: treat Pacific midnight's wall-clock as UTC, then correct
  // by the offset measured at that approximate instant (stable away from the
  // ~1hr DST seam, which never lands on local midnight in US Pacific).
  const approx = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
  return new Date(approx.getTime() - pacificOffsetMs(approx));
}

/**
 * The true UTC instant of Pacific local midnight for a `YYYY-MM-DD` day KEY.
 * The day-key twin of `pacificDayStartInstant`: use it when a @db.Date-shaped
 * day (workbook rows, window bounds) must become a value for an INSTANT column
 * or an instant-column query bound. Writing `dayKeyUTCFromISO(day)` into an
 * instant column instead puts the row at 4/5 PM Pacific on the PREVIOUS day —
 * the 2026-07-10 promotion defect that leaked window-edge loads across months.
 */
export function pacificMidnightInstantOfDayISO(dayISO: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dayISO);
  if (!m) throw new Error(`pacificMidnightInstantOfDayISO: not a YYYY-MM-DD day key: ${dayISO}`);
  const approx = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0));
  return new Date(approx.getTime() - pacificOffsetMs(approx));
}

/**
 * The half-open [start, endExclusive) INSTANT window covering the current
 * Pacific business day. The canonical way to bound a query on an instant column
 * to "today" (ADR-0065).
 *
 * WHY THIS EXISTS RATHER THAN `new Date(); d.setHours(0,0,0,0)`: `setHours`
 * computes SERVER-LOCAL midnight, and the app container runs with no TZ set
 * (UTC). Between 5:00 PM and midnight Pacific, UTC has already rolled to the
 * next day — so a server-local "today" silently becomes TOMORROW mid-shift for
 * an evening-shift operator, hiding the loads they are actually working and
 * showing the next day's. Both sites are Pacific (Woodland CA / Eugene OR).
 *
 * This is deliberately built from the same `pacificDayStartInstant` helper that
 * `floor-inbound`, `bulk-inbound`, `onHand`'s inbound window and the MyMRC
 * bridge already key on, so the iPad's notion of "today" is byte-identical to
 * the one billing uses. Do NOT introduce a second day-key definition.
 */
export function currentPacificDayWindow(instant: Date = new Date()): {
  start: Date;
  endExclusive: Date;
} {
  return {
    start: pacificDayStartInstant(instant),
    endExclusive: pacificDayStartInstantPlus(1, instant),
  };
}

/**
 * Pacific local midnight instant `days` after the Pacific day of `instant`.
 * Negative `days` steps backwards. DST-correct in BOTH directions.
 *
 * Steps on the Pacific CALENDAR, not by 24h arithmetic. The previous
 * implementation added `days * 86_400_000` and re-snapped, which silently
 * broke on the DST FALL-BACK day (a 25-hour Pacific day): base + 24h lands at
 * 23:00 PST — still inside the SAME Pacific day — so the re-snap returned the
 * base instant unchanged and `pacificDayStartInstantPlus(1)` produced a
 * ZERO-WIDTH window. Measured on 2026-11-01: 0h instead of 25h. (Spring-forward
 * happened to be correct at 23h, which is why it went unnoticed.)
 *
 * That is a money-path defect, not a cosmetic one — this helper bounds the
 * invoice generation window (`lib/invoices/generation-inputs.ts`), the manager
 * loads date filters, and the operator queue's current-day window. A zero-width
 * `lt` bound on a fall-back day drops every row in the range.
 */
export function pacificDayStartInstantPlus(days: number, instant: Date = new Date()): Date {
  const iso = pacificDayISO(instant);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`pacificDayStartInstantPlus: bad Pacific day key: ${iso}`);
  // UTC arithmetic on the date-only components is a pure calendar step — it
  // cannot be perturbed by any DST offset because no wall-clock time is involved.
  const cal = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  cal.setUTCDate(cal.getUTCDate() + days);
  return pacificMidnightInstantOfDayISO(dayISO(cal));
}

// ────────────────────────────────────────────────────────────────────
// Display
// ────────────────────────────────────────────────────────────────────

/**
 * Render a @db.Date business day. The stored value's UTC components ARE the
 * Pacific calendar day, so we format in UTC — this is correct precisely
 * because of the storage invariant above (do NOT switch this to Pacific).
 * `opts` overrides default `weekday/year/month/day` parts.
 */
export function pacificDateLabel(
  day: Date,
  locale: Locale = DEFAULT_LOCALE,
  opts?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
    ...opts,
  }).format(day);
}

/** "September 2026" for a @db.Date month value (UTC components = Pacific month). */
export function pacificMonthLabel(day: Date, locale: Locale = DEFAULT_LOCALE): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(day);
}

/** `YYYY-MM-DD` for a @db.Date business day (UTC components). */
export function dayISO(day: Date): string {
  const y = day.getUTCFullYear();
  const m = String(day.getUTCMonth() + 1).padStart(2, '0');
  const d = String(day.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Render a true INSTANT (audit timestamp, signature time, pdf_generated_at)
 * in Bill's Pacific wall clock. Use this only for real points in time, never
 * for @db.Date business days.
 */
export function formatPacificDateTime(
  instant: Date,
  locale: Locale = DEFAULT_LOCALE,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], {
    timeZone: PACIFIC_TZ,
    ...opts,
  }).format(instant);
}
