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
import { type BonusRuleParams } from '@/lib/bonus/calculator';
import { dailyBonusCentsFor } from '@/lib/bonus/paid-units';
import { resolveRuleForHistorical } from '@/lib/bonus/daily-entry';
import { periodLabel, periodShortLabel } from '@/lib/bonus/period-label';
import { appCurrentYear } from '@/lib/time';

export interface PreviousNameEntry {
  name: string;
  changed_at: string;
}

/** Per-period rollup for a single employee. */
export interface EmployeeMonthTotal {
  monthId: string;
  /** UTC YYYY-MM of the period start; a stable sort key only (NOT unique — two
   * bi-weekly periods can share a month, so never use it as a display label). */
  ym: string;
  /** Canonical bi-weekly label, e.g. "Period 13 · Jun 9–22, 2026" (ADR-0031). */
  label: string;
  /** Compact label for tight columns, e.g. "Period 13". */
  shortLabel: string;
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
 * Resolve the rule for a period, caching by `ym` so a multi-period or
 * multi-employee rollup never re-queries the same period's rule. The rule
 * effective on the period's first day governs that period.
 *
 * Uses {@link resolveRuleForHistorical} (NOT strict `resolveActiveRule`): the
 * ADR-0023 historical import seeded entries back to Jan 2025, but the
 * `processor_bonus_rules` table only goes back to 2026-01-01. For a pre-rule
 * period the strict resolver throws `NoActiveRuleError`, which 500'd the entire
 * per-employee history page. The historical fallback resolves the period's rule
 * when one exists and otherwise the site's earliest rule — the same graceful
 * read-path behavior ADR-0023 gave the historical PDF render. Live periods are
 * unaffected (the inner strict resolve still succeeds for them).
 */
function ruleResolver(siteId: string): (periodStart: Date) => Promise<BonusRuleParams> {
  const cache = new Map<string, Promise<BonusRuleParams>>();
  return (periodStart: Date) => {
    const key = ym(periodStart);
    const hit = cache.get(key);
    if (hit) return hit;
    const p = resolveRuleForHistorical(siteId, periodStart).then((r) => ({
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
  /** PROCESSED mattresses only (ADR-0083) — saves are tracked separately below. */
  mattresses: number;
  /** ADR-0083 — mattresses saved for resale. Paid, but never "processed". */
  saves: number;
  daysQualified: number;
  bonusCents: number;
}

function emptyRollup(): Rollup {
  return { mattresses: 0, saves: 0, daysQualified: 0, bonusCents: 0 };
}

/** Accumulate one day's entry into a rollup using the supplied rule. */
/**
 * ADR-0083 — `mattressCount` is the PROCESSED count and `saves` the saved count.
 * The bonus is tiered ONCE over their sum (`dailyBonusCentsFor`), while
 * `acc.mattresses` keeps accumulating PROCESSED units only: that rollup field
 * feeds "mattresses processed" displays, and a saved mattress was never torn
 * down. Two disjoint quantities, one paid total — see `paid-units.ts`.
 */
function accumulate(
  acc: Rollup,
  mattressCount: number,
  saves: number,
  rule: BonusRuleParams,
): void {
  const bonus = dailyBonusCentsFor({ mattress_count: mattressCount, saves }, rule);
  acc.mattresses += mattressCount;
  acc.saves += saves;
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
    select: {
      id: true,
      period_number: true,
      period_start: true,
      period_end: true,
      state: true,
    },
  });

  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_employee_id: employeeId, bonus_pay_period: { site_id: siteId } },
    select: {
      bonus_pay_period_id: true,
      entry_date: true,
      mattress_count: true,
      saves: true,
    },
  });

  const entriesByMonth = new Map<
    string,
    { entry_date: Date; mattress_count: number; saves: number }[]
  >();
  for (const e of entries) {
    const list = entriesByMonth.get(e.bonus_pay_period_id) ?? [];
    list.push({
      entry_date: e.entry_date,
      mattress_count: e.mattress_count.toNumber(),
      saves: e.saves.toNumber(),
    });
    entriesByMonth.set(e.bonus_pay_period_id, list);
  }

  const resolveRule = ruleResolver(siteId);
  const allMonthTotals: EmployeeMonthTotal[] = [];
  for (const m of months) {
    const monthEntries = entriesByMonth.get(m.id) ?? [];
    if (monthEntries.length === 0) continue; // month with no entries for this employee
    const rule = await resolveRule(m.period_start);
    const acc = emptyRollup();
    for (const e of monthEntries) accumulate(acc, e.mattress_count, e.saves, rule);
    allMonthTotals.push({
      monthId: m.id,
      ym: ym(m.period_start),
      label: periodLabel(m),
      shortLabel: periodShortLabel(m),
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
    select: {
      bonus_employee_id: true,
      bonus_pay_period_id: true,
      mattress_count: true,
      saves: true,
    },
  });

  const resolveRule = ruleResolver(siteId);
  const byEmployee = new Map<string, Rollup>();
  for (const e of entries) {
    const monthStart = monthStartById.get(e.bonus_pay_period_id);
    if (!monthStart) continue;
    const rule = await resolveRule(monthStart);
    const acc = byEmployee.get(e.bonus_employee_id) ?? emptyRollup();
    accumulate(acc, e.mattress_count.toNumber(), e.saves.toNumber(), rule);
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
// annualAdjustmentUnits — reporting-only production adjustments, one year
// ────────────────────────────────────────────────────────────────────

/**
 * Sum of reporting-only production adjustments (ADR-0032) whose `entry_date`
 * falls in calendar `year` (UTC), site-scoped. This is a PRODUCTION-QUANTITY
 * figure only: it is added to the annual mattress (units) total so the
 * year-over-year production comparison reflects the operator's true paper
 * figures. It is NEVER added to any bonus-dollar total — these adjustments live
 * in `bonus_reporting_adjustments`, which no bonus-dollar path queries, so the
 * frozen closed-period payout can never move.
 *
 * Returns a signed integer (may be negative); 0 when no adjustments exist for
 * the year.
 */
export async function annualAdjustmentUnits(siteId: string, year: number): Promise<number> {
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const yearEnd = new Date(Date.UTC(year + 1, 0, 1)); // exclusive
  const rows = await prisma.bonusReportingAdjustment.findMany({
    where: { site_id: siteId, entry_date: { gte: yearStart, lt: yearEnd } },
    select: { units: true },
  });
  let sum = 0;
  for (const r of rows) sum += r.units;
  return sum;
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
 *
 * `adjustmentUnits` (ADR-0032) is the net reporting-only production adjustment for
 * the year. When non-zero, a single provenance row is appended whose mattress
 * column carries the unit delta and whose bonus column is 0.00 — so the CSV's
 * production (mattress) total matches the on-screen production total while the
 * bonus-dollar column stays untouched by adjustments (the frozen payout is
 * unaffected). When zero, no extra row is emitted.
 */
export function csvForAnnual(rows: AnnualEmployeeRow[], adjustmentUnits = 0): string {
  const records = rows.map((r) => ({
    employee: r.name,
    previously_known_as: r.previousNames.map((p) => p.name).join('; '),
    active: r.isActive ? 'yes' : 'no',
    total_mattresses: r.mattresses,
    days_qualified: r.daysQualified,
    total_bonus_usd: (r.bonusCents / 100).toFixed(2),
  }));

  if (adjustmentUnits !== 0) {
    records.push({
      employee: 'Reporting adjustment (ADR-0032, production-only)',
      previously_known_as: '',
      active: '—',
      total_mattresses: adjustmentUnits,
      days_qualified: 0,
      total_bonus_usd: (0).toFixed(2),
    });
  }

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
