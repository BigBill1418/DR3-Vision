// ADR-0071 — processor production quota: the miss/flag computation.
//
// ── What this is ────────────────────────────────────────────────────────────
// An EXCEPTION alert, not a monitored board. Nobody watches these numbers; the
// system watches and speaks up only when a processor misses the daily quota
// twice or more in a Monday–Sunday week. Silence means everyone met quota.
//
// ── Read-only, structurally ─────────────────────────────────────────────────
// Every function here takes a db handle and only ever calls `findMany`. The
// per-processor daily counts already exist as `bonus_daily_entries` — the same
// data the bonus system captures — so this feature is a READER of production,
// never a writer. `processed_units_daily` has a designated sole writer
// (workbook-sync, ADR-0049/0058) and the bonus tables are owned by the bonus
// entry flow; a second writer in either place is the defect this module must
// never become. If a change here seems to need a write, the design is wrong.
//
// ── "No recorded production" is NOT a miss ──────────────────────────────────
// The single most important rule, and the one that decides whether managers
// trust the alert. A day off, PTO, or a non-worked day must never be able to
// flag someone. `bonus_daily_entries` is unique on (employee, date), so the
// absence of a row IS the absence of production — there is nothing to
// interpret. Verified against live data 2026-07-31: of 5,733 entries exactly
// ONE carries a zero count, so keying a 0 is not how a day off is recorded.
// Days are evaluated only where a row exists.
//
// Comparison is strictly-less-than: exactly 75 is MET, not missed.

import type { Prisma, PrismaClient } from '@prisma/client';
import { PACIFIC_TZ } from '@/lib/time';

type Db = PrismaClient | Prisma.TransactionClient;

/** Fallback only — the real value comes from `processor_quota_config`. */
export const DEFAULT_QUOTA_UNITS = 75;
/** Fallback only — misses needed in one week before a processor is flagged. */
export const DEFAULT_MIN_MISSES = 3;

export interface QuotaDay {
  dayISO: string;
  units: number;
}

export interface ProcessorWeek {
  employeeId: string;
  name: string;
  /**
   * Active on the roster RIGHT NOW (not just during the week). Someone who has
   * since left still appears in the report — their production that week was
   * real — but is never named in the email, because the email is a list of
   * conversations to have and you cannot have one with a former employee.
   */
  onRoster: boolean;
  /** Days with RECORDED production only. A missing day is absent here. */
  days: QuotaDay[];
  misses: QuotaDay[];
  flagged: boolean;
}

export interface QuotaWeek {
  weekStartISO: string;
  weekEndISO: string;
  quota: number;
  minMisses: number;
  /** Everyone with recorded production in the week — the full floor picture. */
  rows: ProcessorWeek[];
  /** The subset the email names: flagged AND still on the roster. */
  flagged: ProcessorWeek[];
}

const PT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 'YYYY-MM-DD' for `at` in Pacific. */
function pacificISO(at: Date): string {
  const p = PT_PARTS.formatToParts(at);
  const get = (t: string): string => p.find((x) => x.type === t)?.value ?? '01';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Shift an ISO calendar day by `n` days. Pure calendar arithmetic, no zone. */
export function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The Monday–Sunday week CONTAINING the Pacific day of `at`.
 *
 * `entry_date` is a `@db.Date` — a calendar date with no time zone — so once the
 * Pacific day is established the week is pure calendar arithmetic. Deriving the
 * day in UTC instead would put every entry made after 5pm PT into the following
 * day, and on a Sunday evening into the following WEEK.
 */
export function pacificWeekBounds(at: Date): { weekStartISO: string; weekEndISO: string } {
  const todayISO = pacificISO(at);
  // getUTCDay on a UTC-midnight probe is the calendar weekday: 0=Sun … 6=Sat.
  const dow = new Date(`${todayISO}T00:00:00.000Z`).getUTCDay();
  // Monday-based offset: Monday→0, Sunday→6.
  const back = (dow + 6) % 7;
  const weekStartISO = addDaysISO(todayISO, -back);
  return { weekStartISO, weekEndISO: addDaysISO(weekStartISO, 6) };
}

/**
 * The most recent COMPLETE Monday–Sunday week as of `at`.
 *
 * The digest reports on a finished week. Running it against the week in progress
 * would flag someone on Wednesday for two slow days and then have no way to
 * un-flag them on Friday.
 */
const PT_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  hour: '2-digit',
  minute: '2-digit',
});

/** Pacific wall-clock hour (0-23) at `at`. DST-correct via Intl. */
export function pacificHour(at: Date): number {
  const h = PT_CLOCK.formatToParts(at).find((x) => x.type === 'hour')?.value ?? '00';
  // Intl emits '24' for midnight under some ICU versions; normalize.
  return Number(h) % 24;
}

/** The digest's send moment: Friday 20:00 Pacific (ADR-0071 Amendment 2). */
export const SEND_DOW_FRIDAY_OFFSET = 4; // Monday + 4 = Friday
export const SEND_HOUR_PT = 20;

/**
 * The most recent Monday–**Friday** week whose Friday 20:00 PT send moment has
 * PASSED as of `at` (ADR-0071 Amendment 2).
 *
 * - Fri 20:00 PT or later, Sat, Sun → the CURRENT week (Mon–Fri just ended).
 * - Mon 00:00 → Fri 19:59 PT → the PREVIOUS week — which is exactly what makes
 *   a missed Friday send self-heal: Saturday/Sunday/Monday ticks still target
 *   that Friday's week, and the (site, week) idempotency claim turns the
 *   already-sent case into a no-op.
 */
export function latestDueMonFriWeek(at: Date): { weekStartISO: string; weekEndISO: string } {
  const { weekStartISO } = pacificWeekBounds(at);
  const fridayISO = addDaysISO(weekStartISO, SEND_DOW_FRIDAY_OFFSET);
  const todayISO = pacificISO(at);
  const due =
    todayISO > fridayISO || (todayISO === fridayISO && pacificHour(at) >= SEND_HOUR_PT);
  const start = due ? weekStartISO : addDaysISO(weekStartISO, -7);
  return { weekStartISO: start, weekEndISO: addDaysISO(start, SEND_DOW_FRIDAY_OFFSET) };
}

export function previousCompleteWeek(at: Date): { weekStartISO: string; weekEndISO: string } {
  const { weekStartISO } = pacificWeekBounds(at);
  const start = addDaysISO(weekStartISO, -7);
  return { weekStartISO: start, weekEndISO: addDaysISO(start, 6) };
}

export interface ComputeArgs {
  siteId: string;
  weekStartISO: string;
  /** Defaults to weekStart+6 (Mon–Sun). The Friday digest passes weekStart+4. */
  weekEndISO?: string;
  quota?: number;
  minMisses?: number;
}

/**
 * Compute the week's per-processor misses for ONE site.
 *
 * `siteId` is required and applied to `bonus_employees.site_id` — the scoping
 * lives in the query, not in a post-filter, so an Eugene processor can never
 * reach a Woodland digest even if a caller forgets to filter.
 */
export async function computeProcessorQuotaWeek(db: Db, args: ComputeArgs): Promise<QuotaWeek> {
  const quota = args.quota ?? DEFAULT_QUOTA_UNITS;
  const minMisses = args.minMisses ?? DEFAULT_MIN_MISSES;
  const weekStartISO = args.weekStartISO;
  const weekEndISO = args.weekEndISO ?? addDaysISO(args.weekStartISO, 6);

  const entries = await db.bonusDailyEntry.findMany({
    where: {
      bonus_employee: { site_id: args.siteId },
      entry_date: {
        gte: new Date(`${weekStartISO}T00:00:00.000Z`),
        lte: new Date(`${weekEndISO}T00:00:00.000Z`),
      },
    },
    select: {
      entry_date: true,
      mattress_count: true,
      bonus_employee: {
        select: { id: true, full_name: true, is_active: true, deleted_at: true },
      },
    },
    orderBy: { entry_date: 'asc' },
  });

  const byEmployee = new Map<string, ProcessorWeek>();

  for (const e of entries) {
    const emp = e.bonus_employee;
    let row = byEmployee.get(emp.id);
    if (!row) {
      row = {
        employeeId: emp.id,
        name: emp.full_name,
        onRoster: emp.is_active && emp.deleted_at === null,
        days: [],
        misses: [],
        flagged: false,
      };
      byEmployee.set(emp.id, row);
    }
    // ADR-0083 — the ADR-0071 quota measures PROCESSING THROUGHPUT, so `saves`
    // is deliberately excluded: a processor who spent the day setting units
    // aside for resale did not process them, and folding saves in here would
    // silently raise everyone above a quota that was calibrated on processed
    // units alone. If Bill later wants the quota to measure total handled work,
    // that is a deliberate re-calibration of the threshold, not a default we
    // slipped in. See `src/lib/bonus/paid-units.ts`.
    const day: QuotaDay = {
      dayISO: e.entry_date.toISOString().slice(0, 10),
      units: Number(e.mattress_count),
    };
    row.days.push(day);
    // Strictly less than: exactly the quota is MET.
    if (day.units < quota) row.misses.push(day);
  }

  const rows = [...byEmployee.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const r of rows) r.flagged = r.misses.length >= minMisses;

  return {
    weekStartISO,
    weekEndISO,
    quota,
    minMisses,
    rows,
    flagged: rows.filter((r) => r.flagged && r.onRoster),
  };
}
