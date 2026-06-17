// T-113 — EOD ntfy enforcement core (ADR-0019 §2).
//
// Pure decision logic for the end-of-day "no bonus entries for the site"
// check. The `scripts/bonus-eod-check.mjs` cron wires this to Prisma (active
// employees, today's entries, site holidays) and the ntfy publisher; this
// module owns the date math and the alert/skip decision so it is testable
// without a DB or network.
//
// ── What fires the alert (ADR-0019 §2, revised 2026-06-17) ───────────
// Bill is paged ONLY when a site has *zero* bonus entries for the Pacific
// day — i.e. nobody on the site logged anything. A partial day (some
// processors entered, others didn't because they worked a different
// position or were off) is normal and never pages. Earlier this check
// fired whenever *any* active employee lacked an entry; that was too
// noisy and is the behaviour this revision replaces.
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

// The Pacific calendar-day math lives in the shared `@/lib/time` source of
// truth; this module just composes it with the EOD alert decision.
import { pacificDayISO, pacificDayKeyUTC, isPacificWeekend, pacificDateLabel } from '@/lib/time';

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
  /**
   * Site code the decision covers (`woodland` | `eugene`). Threaded through so
   * the alert fingerprint is site-scoped (ADR-0028 bi-site EOD check) — the
   * check is no longer Woodland-only.
   */
  siteCode: string;
  /** Active (`is_active = true`, not soft-deleted) employees at the site. */
  activeEmployees: readonly ActiveEmployee[];
  /** Employee ids that already have a daily entry for the Pacific day. */
  enteredEmployeeIds: ReadonlySet<string>;
  /** `YYYY-MM-DD` strings of the site's holidays. */
  holidayIsoDates: ReadonlySet<string>;
}

export type EodSkipReason = 'weekend' | 'holiday' | 'no_active_employees' | 'has_entries';

export interface EodDecision {
  shouldAlert: boolean;
  /** Count of distinct employees with an entry for the site on the Pacific day. */
  enteredCount: number;
  /** `YYYY-MM-DD` of the Pacific day this decision covers. */
  dateIso: string;
  /** Human label for the alert body, e.g. `Sep 14, 2026`. */
  dateLabel: string;
  /** ntfy dedup fingerprint for this day's alert. */
  fingerprint: string;
  /** Why no alert fires (undefined when `shouldAlert` is true). */
  skipReason?: EodSkipReason;
}

/**
 * ntfy fingerprint for the missing-entries alert on a given Pacific day, scoped
 * to the site (ADR-0028 — the check is bi-site; the cron passes the site code
 * per-iteration so Woodland and Eugene alerts never collide).
 */
export function missingFingerprint(siteCode: string, dateIso: string): string {
  return `bonus-entry-missing:${siteCode}:${dateIso}`;
}

/**
 * Resolve the Pacific calendar-day facts for an instant. Pure: depends only
 * on `now` and the fixed Pacific zone (via `@/lib/time`).
 */
export function pacificDateParts(now: Date): PacificDateParts {
  const iso = pacificDayISO(now); // 'YYYY-MM-DD'
  const dayKeyUTC = pacificDayKeyUTC(now); // UTC midnight of the Pacific day
  // 'Sep 14, 2026' — render the @db.Date-shaped key in UTC (its UTC parts ARE
  // the Pacific day) to match how the rest of the app labels stored days.
  const label = pacificDateLabel(dayKeyUTC, 'en', {
    weekday: undefined,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return { iso, label, dayKeyUTC, isWeekend: isPacificWeekend(now) };
}

/**
 * Decide whether an EOD "no entries" alert should fire for the Pacific day of
 * `now`. Weekends and site holidays are skipped; a day with no active employees
 * has nobody expected to enter; otherwise we alert iff the site has *zero*
 * entries for the day. A partial day (at least one entry) never pages — see the
 * module header for why (ADR-0019 §2, revised 2026-06-17).
 */
export function evaluateEod(args: EvaluateEodArgs): EodDecision {
  const parts = pacificDateParts(args.now);
  const base = {
    dateIso: parts.iso,
    dateLabel: parts.label,
    fingerprint: missingFingerprint(args.siteCode, parts.iso),
  };

  if (parts.isWeekend) {
    return { ...base, shouldAlert: false, enteredCount: 0, skipReason: 'weekend' };
  }
  if (args.holidayIsoDates.has(parts.iso)) {
    return { ...base, shouldAlert: false, enteredCount: 0, skipReason: 'holiday' };
  }
  if (args.activeEmployees.length === 0) {
    return {
      ...base,
      shouldAlert: false,
      enteredCount: 0,
      skipReason: 'no_active_employees',
    };
  }

  const enteredCount = args.enteredEmployeeIds.size;

  // Any entry at all means the site logged something today — no page.
  if (enteredCount > 0) {
    return { ...base, shouldAlert: false, enteredCount, skipReason: 'has_entries' };
  }
  return { ...base, shouldAlert: true, enteredCount: 0 };
}
