// ADR-0019 §8 — Per-employee + annual aggregate views (T-118).
//
// Read-only data layer behind the cross-month employee detail page, the annual
// aggregate page, and the annual CSV export. Like every other bonus data module:
//   - assumes the caller already passed the Woodland gate (`checkBonusAccess` /
//     `requireBonusAccess` at the page / route layer); EVERY query is scoped by
//     the Woodland `siteId` the caller hands in (CLAUDE.md hard rule #2 — bonus
//     is Woodland-only in V2). A forged employee id from another site resolves
//     to nothing.
//   - routes EVERY cent through the single `@/lib/bonus/calculator` so the number
//     on the daily grid, the signed PDF, and these aggregate views can never
//     diverge. Bonus math is NEVER hardcoded (CLAUDE.md hard rule #3); each
//     month's totals use the `processor_bonus_rules` row effective on that
//     month, so a mid-history rate change is reflected per month.
//
// ADR-0019 §9b (rename): the CURRENT `full_name` is displayed everywhere; the
// `previous_names` array is surfaced so the UI can show a "previously known as"
// badge. We never relabel historical months with the old name — display always
// follows the current name, history is a footnote.

import Papa from 'papaparse';
import { prisma } from '@/lib/prisma';
import { calculateDailyBonusCents, type BonusRuleParams } from '@/lib/bonus/calculator';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { appCurrentYear } from '@/lib/time';

export interface PreviousNameEntry {
  name: string;
  changed_at: string;
}

/** Per-month rollup for a single employee. */
export interface EmployeeMonthTotal {
  monthId: string;
  /** UTC YYYY-MM, stable sort/display key. */
  ym: string;
  /** Human label, e.g. "May 2026". */
  label: string;
  monthStart: Date;
  state: string;
  /** Sum of mattress counts across the employee's keyed days this month. */
  mattresses: number;
  /** Count of distinct days the employee earned a positive bonus. */
  daysQualified: number;
  /** Sum of daily bonuses this month, integer CENTS, this month's rule. */
  bonusCents: number;
}

export interface EmployeeHistory {
  employeeId: string;
  siteId: string;
  /** Current display name (ADR-0019 §9b). */
  name: string;
  /** Prior names so the UI can render a "previously known as" badge. */
  previousNames: PreviousNameEntry[];
  isActive: boolean;
  /** Every requested month, newest first. */
  months: EmployeeMonthTotal[];
  /** Year-to-date totals for the CURRENT calendar year (UTC). */
  ytd: { mattresses: number; daysQualified: number; bonusCents: number };
  /** Last-12-months series, OLDEST → newest, for the bar list. */
  last12: EmployeeMonthTotal[];
}

/** One employee's annual rollup row (annual aggregate page + CSV). */
export interface AnnualEmployeeRow {
  employeeId: string;
  name: string;
  previousNames: PreviousNameEntry[];
  isActive: boolean;
  mattresses: number;
  daysQualified: number;
  bonusCents: number;
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** UTC YYYY-MM for a period_start, matching the @db.Date column. */
function ym(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Human month label, en-US, in UTC so it matches the stored calendar month. */
function monthLabel(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(d);
}

function parsePreviousNames(raw: unknown): PreviousNameEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviousNameEntry[] = [];
  for (const item of raw) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const name = rec['name'];
      const changedAt = rec['changed_at'];
      if (typeof name === 'string' && typeof changedAt === 'string') {
        out.push({ name, changed_at: changedAt });
      }
    }
  }
  return out;
}

/**
 * Resolve the rule for a month, caching by `ym` so a multi-month or multi-employee
 * rollup never re-queries the same month's rule. The rule effective on the
 * month's first day governs that whole month (mid-month rate changes are out of
 * scope for V2 — the daily grid would have used the day's rule; aggregates use
 * the month-start rule, which is identical when a month has one rule).
 */
function ruleResolver(siteId: string): (monthStart: Date) => Promise<BonusRuleParams> {
  const cache = new Map<string, Promise<BonusRuleParams>>();
  return (monthStart: Date) => {
    const key = ym(monthStart);
    const hit = cache.get(key);
    if (hit) return hit;
    const p = resolveActiveRule(siteId, monthStart).then((r) => ({
      threshold_low: r.threshold_low,
      rate_low: r.rate_low,
      threshold_high: r.threshold_high,
      rate_high: r.rate_high,
    }));
    cache.set(key, p);
    return p;
  };
}

interface Rollup {
  mattresses: number;
  daysQualified: number;
  bonusCents: number;
}

function emptyRollup(): Rollup {
  return { mattresses: 0, daysQualified: 0, bonusCents: 0 };
}

/** Accumulate one day's entry into a rollup using the supplied rule. */
function accumulate(acc: Rollup, mattressCount: number, rule: BonusRuleParams): void {
  const bonus = calculateDailyBonusCents(mattressCount, rule);
  acc.mattresses += mattressCount;
  acc.bonusCents += bonus;
  if (bonus > 0) acc.daysQualified += 1;
}

// ────────────────────────────────────────────────────────────────────
// employeeHistory — one employee, cross-month
// ────────────────────────────────────────────────────────────────────

/**
 * Cross-month history for a single Woodland employee: per-month totals (newest
 * first), year-to-date totals (current UTC calendar year), and a last-12-months
 * series (oldest → newest) for the bar list.
 *
 * Site-scoped: the employee is looked up under `siteId`, so a manager can never
 * pull a non-Woodland processor's history. Returns null if the employee is not a
 * Woodland row. `opts.months` caps how many recent months the detailed list
 * returns (default 24); the last-12 series and YTD are always computed from the
 * months in range regardless of that cap's display use.
 */
export async function employeeHistory(
  siteId: string,
  employeeId: string,
  opts: { months?: number } = {},
): Promise<EmployeeHistory | null> {
  const monthsBack = Math.max(1, Math.floor(opts.months ?? 24));

  const employee = await prisma.bonusEmployee.findFirst({
    where: { id: employeeId, site_id: siteId },
    select: { id: true, full_name: true, previous_names: true, is_active: true },
  });
  if (!employee) return null;

  // Pull this employee's months (those with at least one of their entries) plus
  // their entries, scoped to the site via the month relation. We fetch all the
  // employee's months, then trim to the requested window after sorting.
  const months = await prisma.bonusPayPeriod.findMany({
    where: { site_id: siteId },
    orderBy: { period_start: 'desc' },
    select: { id: true, period_start: true, state: true },
  });

  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_employee_id: employeeId, bonus_pay_period: { site_id: siteId } },
    select: { bonus_pay_period_id: true, entry_date: true, mattress_count: true },
  });

  const entriesByMonth = new Map<string, { entry_date: Date; mattress_count: number }[]>();
  for (const e of entries) {
    const list = entriesByMonth.get(e.bonus_pay_period_id) ?? [];
    list.push({ entry_date: e.entry_date, mattress_count: e.mattress_count.toNumber() });
    entriesByMonth.set(e.bonus_pay_period_id, list);
  }

  const resolveRule = ruleResolver(siteId);
  const allMonthTotals: EmployeeMonthTotal[] = [];
  for (const m of months) {
    const monthEntries = entriesByMonth.get(m.id) ?? [];
    if (monthEntries.length === 0) continue; // month with no entries for this employee
    const rule = await resolveRule(m.period_start);
    const acc = emptyRollup();
    for (const e of monthEntries) accumulate(acc, e.mattress_count, rule);
    allMonthTotals.push({
      monthId: m.id,
      ym: ym(m.period_start),
      label: monthLabel(m.period_start),
      monthStart: m.period_start,
      state: m.state,
      mattresses: acc.mattresses,
      daysQualified: acc.daysQualified,
      bonusCents: acc.bonusCents,
    });
  }
  // allMonthTotals is newest-first (months query was desc).

  const displayMonths = allMonthTotals.slice(0, monthsBack);

  // YTD: current Pacific calendar year (not the server's UTC year — they differ
  // for the first hours of Jan 1 Pacific, which are still Dec 31 in UTC's eyes
  // inverted; using Pacific keeps YTD aligned with how the facilities count).
  const thisYear = appCurrentYear();
  const ytd = emptyRollup();
  for (const mt of allMonthTotals) {
    if (mt.monthStart.getUTCFullYear() === thisYear) {
      ytd.mattresses += mt.mattresses;
      ytd.daysQualified += mt.daysQualified;
      ytd.bonusCents += mt.bonusCents;
    }
  }

  // last-12: newest 12, re-ordered oldest → newest for a left-to-right bar list.
  const last12 = allMonthTotals.slice(0, 12).slice().reverse();

  return {
    employeeId: employee.id,
    siteId,
    name: employee.full_name,
    previousNames: parsePreviousNames(employee.previous_names),
    isActive: employee.is_active,
    months: displayMonths,
    ytd,
    last12,
  };
}

// ────────────────────────────────────────────────────────────────────
// annualTotals — all employees, one year
// ────────────────────────────────────────────────────────────────────

/**
 * Per-employee year-to-date totals for `year` (UTC calendar year), Woodland-
 * scoped. Includes any employee with at least one keyed entry in the year — even
 * a since-deactivated processor, whose bonus still belongs on that year's report.
 * Rows are sorted by current display name. Each month's bonus uses that month's
 * effective rule (CLAUDE.md hard rule #3).
 */
export async function annualTotals(siteId: string, year: number): Promise<AnnualEmployeeRow[]> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1)); // exclusive

  const months = await prisma.bonusPayPeriod.findMany({
    where: { site_id: siteId, period_start: { gte: yearStart, lt: yearEnd } },
    select: { id: true, period_start: true },
  });
  const monthStartById = new Map(months.map((m) => [m.id, m.period_start]));
  if (months.length === 0) return [];

  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: { in: [...monthStartById.keys()] } },
    select: { bonus_employee_id: true, bonus_pay_period_id: true, mattress_count: true },
  });

  const resolveRule = ruleResolver(siteId);
  const byEmployee = new Map<string, Rollup>();
  for (const e of entries) {
    const monthStart = monthStartById.get(e.bonus_pay_period_id);
    if (!monthStart) continue;
    const rule = await resolveRule(monthStart);
    const acc = byEmployee.get(e.bonus_employee_id) ?? emptyRollup();
    accumulate(acc, e.mattress_count.toNumber(), rule);
    byEmployee.set(e.bonus_employee_id, acc);
  }
  if (byEmployee.size === 0) return [];

  // Resolve current names for the employees that appear (site-scoped).
  const employees = await prisma.bonusEmployee.findMany({
    where: { id: { in: [...byEmployee.keys()] }, site_id: siteId },
    select: { id: true, full_name: true, previous_names: true, is_active: true },
  });
  const empById = new Map(employees.map((e) => [e.id, e]));

  const rows: AnnualEmployeeRow[] = [];
  for (const [employeeId, acc] of byEmployee) {
    const emp = empById.get(employeeId);
    if (!emp) continue; // entry for an employee outside this site — skip (scope guard)
    rows.push({
      employeeId,
      name: emp.full_name,
      previousNames: parsePreviousNames(emp.previous_names),
      isActive: emp.is_active,
      mattresses: acc.mattresses,
      daysQualified: acc.daysQualified,
      bonusCents: acc.bonusCents,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

// ────────────────────────────────────────────────────────────────────
// csvForAnnual — CSV text for the export
// ────────────────────────────────────────────────────────────────────

/**
 * Serialize annual rows to CSV text via papaparse. Money is rendered as a plain
 * decimal-dollar string ("12.75") — not the "$"-prefixed display form — so the
 * column imports cleanly into a spreadsheet as a number. `previous_names` is a
 * semicolon-joined list of prior names (empty when none) for the "previously
 * known as" provenance.
 */
export function csvForAnnual(rows: AnnualEmployeeRow[]): string {
  const records = rows.map((r) => ({
    employee: r.name,
    previously_known_as: r.previousNames.map((p) => p.name).join('; '),
    active: r.isActive ? 'yes' : 'no',
    total_mattresses: r.mattresses,
    days_qualified: r.daysQualified,
    total_bonus_usd: (r.bonusCents / 100).toFixed(2),
  }));

  // Stable, explicit column order regardless of object key iteration / empty set.
  const columns = [
    'employee',
    'previously_known_as',
    'active',
    'total_mattresses',
    'days_qualified',
    'total_bonus_usd',
  ] as const;

  return Papa.unparse(
    { fields: [...columns], data: records.map((rec) => columns.map((c) => rec[c])) },
    { newline: '\n' },
  );
}
