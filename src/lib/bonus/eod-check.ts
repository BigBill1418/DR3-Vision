// T-113 — EOD ntfy enforcement core (ADR-0019 §2).
//
// Pure decision logic for the end-of-day "bonus entries missing" check.
// The `scripts/bonus-eod-check.mjs` cron wires this to Prisma (active
// employees, today's entries, site holidays) and the ntfy publisher; this
// module owns the date math and the alert/skip decision so it is testable
// without a DB or network.
//
// ── Timezone discipline (CLAUDE.md global rule) ──────────────────────
// The fleet hosts run their system clocks in UTC; Bill operates on
// America/Los_Angeles. "Today" for this check is the Pacific calendar day
// of the run instant — the cron fires at 5:00 PM Pacific, which is already
// past UTC midnight for ~7 months of the year, so a naive UTC read of the
// date would be off by one. We resolve the Pacific Y/M/D via Intl and then
// build a UTC-midnight `Date` to match how `@db.Date` columns
// (`bonus_daily_entries.entry_date`, `site_holidays.holiday_date`) are
// stored — see `daily-entry.ts#entryDateUTC` and `state-machine.ts`.
//
// ── Fire-once / no-un-send (ADR-0019 §2) ─────────────────────────────
// The alert fingerprint is `bonus-entry-missing:woodland:<YYYY-MM-DD>`,
// keyed on the Pacific day. The cron runs once per day, so the alert fires
// at most once. A late entry the next morning falls under a *different*
// day's fingerprint and therefore can never retroactively suppress (un-send)
// the prior day's alert — the check is strict by construction.

/** Minimal shape the core needs from a `bonus_employees` row. */
export interface ActiveEmployee {
  id: string;
  full_name: string;
}

/** Resolved Pacific calendar-day facts for a given instant. */
export interface PacificDateParts {
  /** `YYYY-MM-DD` of the Pacific calendar day. */
  iso: string;
  /** Human label, e.g. `Sep 14, 2026` (en-US; admin UI is English-only). */
  label: string;
  /** UTC-midnight Date for the Pacific day — matches `@db.Date` storage. */
  dayKeyUTC: Date;
  /** True when the Pacific day is a Saturday or Sunday. */
  isWeekend: boolean;
}

export interface EvaluateEodArgs {
  /** The run instant (e.g. `new Date()` in the cron). */
  now: Date;
  /** Active (`is_active = true`, not soft-deleted) Woodland employees. */
  activeEmployees: readonly ActiveEmployee[];
  /** Employee ids that already have a daily entry for the Pacific day. */
  enteredEmployeeIds: ReadonlySet<string>;
  /** `YYYY-MM-DD` strings of Woodland site holidays. */
  holidayIsoDates: ReadonlySet<string>;
}

export type EodSkipReason = 'weekend' | 'holiday' | 'no_active_employees' | 'all_entered';

export interface EodDecision {
  shouldAlert: boolean;
  /** Count of active employees with no entry for the Pacific day. */
  missingCount: number;
  /** `YYYY-MM-DD` of the Pacific day this decision covers. */
  dateIso: string;
  /** Human label for the alert body, e.g. `Sep 14, 2026`. */
  dateLabel: string;
  /** ntfy dedup fingerprint for this day's alert. */
  fingerprint: string;
  /** Why no alert fires (undefined when `shouldAlert` is true). */
  skipReason?: EodSkipReason;
}

// The only site this check covers (ADR-0019 §2 is Woodland-scoped). Kept as
// a constant so the fingerprint shape stays consistent with the cron.
const SITE_CODE = 'woodland';

const PACIFIC_TZ = 'America/Los_Angeles';

// en-US formatter for the human label (`Sep 14, 2026`). Constructed once.
const LABEL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

// en-CA yields ISO-ordered `YYYY-MM-DD` parts, the cleanest way to read a
// zoned calendar date out of Intl without manual part-stitching ambiguity.
const ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Weekday formatter (`Sat`/`Sun` detection) in the Pacific zone.
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  weekday: 'short',
});

/** ntfy fingerprint for the missing-entries alert on a given Pacific day. */
export function missingFingerprint(dateIso: string): string {
  return `bonus-entry-missing:${SITE_CODE}:${dateIso}`;
}

/**
 * Resolve the Pacific calendar-day facts for an instant. Pure: depends only
 * on `now` and the fixed Pacific zone.
 */
export function pacificDateParts(now: Date): PacificDateParts {
  const iso = ISO_FMT.format(now); // 'YYYY-MM-DD'
  const label = LABEL_FMT.format(now); // 'Sep 14, 2026'
  const weekday = WEEKDAY_FMT.format(now); // 'Mon' .. 'Sun'
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';

  // Build the UTC-midnight key from the *Pacific* Y/M/D so it lines up with
  // the `@db.Date` values the cron compares against.
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  const dayKeyUTC = new Date(Date.UTC(y as number, (m as number) - 1, d as number));

  return { iso, label, dayKeyUTC, isWeekend };
}

/**
 * Decide whether an EOD missing-entries alert should fire for the Pacific
 * day of `now`. Weekends and site holidays are skipped; a day with no active
 * employees has nothing to miss; otherwise we alert iff any active employee
 * lacks a daily entry for the day.
 */
export function evaluateEod(args: EvaluateEodArgs): EodDecision {
  const parts = pacificDateParts(args.now);
  const base = {
    dateIso: parts.iso,
    dateLabel: parts.label,
    fingerprint: missingFingerprint(parts.iso),
  };

  if (parts.isWeekend) {
    return { ...base, shouldAlert: false, missingCount: 0, skipReason: 'weekend' };
  }
  if (args.holidayIsoDates.has(parts.iso)) {
    return { ...base, shouldAlert: false, missingCount: 0, skipReason: 'holiday' };
  }
  if (args.activeEmployees.length === 0) {
    return {
      ...base,
      shouldAlert: false,
      missingCount: 0,
      skipReason: 'no_active_employees',
    };
  }

  const missingCount = args.activeEmployees.reduce(
    (n, e) => (args.enteredEmployeeIds.has(e.id) ? n : n + 1),
    0,
  );

  if (missingCount === 0) {
    return { ...base, shouldAlert: false, missingCount: 0, skipReason: 'all_entered' };
  }
  return { ...base, shouldAlert: true, missingCount };
}
