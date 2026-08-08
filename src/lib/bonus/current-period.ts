// ADR-0031 — Current pay-period standings (live, in-progress view).
//
// Read-only data layer behind the new `/bonus/standings` report and the
// "Current pay period" banner on the per-employee detail page. Answers the
// operator question "where is each processor RIGHT NOW in the open pay period?"
// — the piece the cross-period history (`aggregates.ts`) and the closed-period
// reports never surfaced.
//
// Like every other bonus data module:
//   - assumes the caller already passed the site gate (`tryBonusAccess` at the
//     page layer); EVERY query is scoped by the `siteId` the caller hands in
//     (CLAUDE.md hard rule #2). Bonus is Eugene + Woodland (ADR-0019.2).
//   - routes EVERY cent through the single `@/lib/bonus/calculator` so the
//     number here can never diverge from the daily grid or the signed PDF.
//     Bonus math is NEVER hardcoded (CLAUDE.md hard rule #3); the open period's
//     totals use the `processor_bonus_rules` row effective on the period start.
//
// "Days short" is the complement of "days qualified": a keyed day whose bonus is
// $0 because the processor's units did not exceed the rule's `threshold_low`
// minimum. Days with NO entry are not counted on either side, so for any
// processor: daysQualified + daysShort = days they were keyed this period.

import { prisma } from '@/lib/prisma';
import { type BonusRuleParams } from '@/lib/bonus/calculator';
import { dailyBonusCentsFor } from '@/lib/bonus/paid-units';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';
import { listEmployees } from '@/lib/bonus/employees';
import type { PreviousName } from '@/lib/bonus/employees';
import { periodLabel } from '@/lib/bonus/period-label';
import { appToday } from '@/lib/time';

/** Shape of the open-period row this module reads (a superset of BonusMonthRow). */
interface OpenPeriodRow {
  id: string;
  period_number: number;
  period_year: number;
  period_start: Date;
  period_end: Date;
  pay_date: Date;
  state: string;
}

/**
 * The seeded period covering `day` at `siteId`, or null. Same date-range
 * contract as {@link import('./state-machine').resolveOpenPayPeriod} (periods
 * never overlap, so at most one matches) — queried directly here so the full
 * canonical period fields (number / year / pay_date) come back, which that
 * helper's narrow `BonusMonthRow` return omits. `day` is the @db.Date-shaped
 * Pacific "today" key (callers pass `appToday()`).
 */
async function resolveOpenPeriodRow(siteId: string, day: Date): Promise<OpenPeriodRow | null> {
  return prisma.bonusPayPeriod.findFirst({
    where: { site_id: siteId, period_start: { lte: day }, period_end: { gte: day } },
    select: {
      id: true,
      period_number: true,
      period_year: true,
      period_start: true,
      period_end: true,
      pay_date: true,
      state: true,
    },
  });
}

/** Metadata for the open pay period the standings are computed against. */
export interface OpenPeriodMeta {
  id: string;
  periodNumber: number;
  periodYear: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  state: string;
  /** "Period 13 · Jun 9–22, 2026" — canonical bi-weekly label (ADR-0019.1). */
  label: string;
}

/** One processor's live standing in the open pay period. */
export interface CurrentPeriodStanding {
  employeeId: string;
  name: string;
  employeeNumber: string | null;
  previousNames: PreviousName[];
  isActive: boolean;
  /** Period-to-date mattress sum across the processor's keyed days. */
  units: number;
  /** Keyed days with a positive bonus (units above the minimum). */
  daysQualified: number;
  /** Keyed days with an entry but $0 bonus (did not hit the minimum). */
  daysShort: number;
  /** Bonus accrued so far this period, integer CENTS, the period's rule. */
  bonusCents: number;
}

export interface CurrentPeriodStandings {
  /** The open period, or null when today falls outside every seeded period. */
  period: OpenPeriodMeta | null;
  /**
   * Minimum units a processor must EXCEED to qualify (the rule's
   * `threshold_low`); surfaced so the UI can show "min N units" without
   * hardcoding. Null when there is no open period to resolve a rule for.
   */
  thresholdLow: number | null;
  /** All active processors, name-sorted, each with their live standing. */
  rows: CurrentPeriodStanding[];
}

interface Tally {
  /**
   * ADR-0083 — PAID units: processed + saves. This drives the standings display
   * and the "units to threshold" figure an operator reads to know whether the
   * next mattress earns them anything, so it must be the same total the bonus is
   * tiered over. A saved mattress that counted for pay but not toward the
   * displayed progress would make the threshold arithmetic on screen wrong.
   */
  units: number;
  /** PROCESSED mattresses only, for displays that mean "torn down". */
  mattresses: number;
  /** ADR-0083 — mattresses saved for resale. */
  saves: number;
  daysQualified: number;
  daysShort: number;
  bonusCents: number;
}

function emptyTally(): Tally {
  return { units: 0, mattresses: 0, saves: 0, daysQualified: 0, daysShort: 0, bonusCents: 0 };
}

/** Fold one keyed day into a tally, classifying it qualified vs short. */
function accumulate(acc: Tally, mattressCount: number, saves: number, rule: BonusRuleParams): void {
  const bonus = dailyBonusCentsFor({ mattress_count: mattressCount, saves }, rule);
  acc.units += mattressCount + saves;
  acc.mattresses += mattressCount;
  acc.saves += saves;
  acc.bonusCents += bonus;
  if (bonus > 0) acc.daysQualified += 1;
  else acc.daysShort += 1;
}

/**
 * Live standings for the currently-open pay period at `siteId`.
 *
 * Resolves the period covering "today" (Pacific) via the same
 * `resolveOpenPayPeriod` the daily grid uses, then tallies every keyed entry in
 * that period per processor. ALL active processors are returned — one with no
 * keyed days yet shows 0 units / 0 qualified / 0 short / $0, so the operator
 * still sees the full roster, now with live position. When today falls outside
 * every seeded period, `period` is null and `rows` carries the active roster at
 * zero (no rule to score against).
 *
 * `now` is injectable for deterministic tests; production passes `appToday()`.
 */
export async function currentPeriodStandings(
  siteId: string,
  now: Date = appToday(),
): Promise<CurrentPeriodStandings> {
  // Active roster first — this is the row set, with or without an open period.
  const employees = await listEmployees(siteId, { status: 'active', sort: 'name' });

  const period = await resolveOpenPeriodRow(siteId, now);
  if (!period) {
    return {
      period: null,
      thresholdLow: null,
      rows: employees.map((e) => ({
        employeeId: e.id,
        name: e.full_name,
        employeeNumber: e.employee_number,
        previousNames: e.previous_names,
        isActive: e.is_active,
        ...emptyTally(),
      })),
    };
  }

  const rule = await resolveActiveRule(siteId, period.period_start);

  // Every keyed entry in the open period. Scoped to the period (which is itself
  // site-scoped via resolveOpenPayPeriod), so no cross-site leakage is possible.
  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: period.id },
    select: { bonus_employee_id: true, mattress_count: true, saves: true },
  });

  const tallyByEmployee = new Map<string, Tally>();
  for (const e of entries) {
    const acc = tallyByEmployee.get(e.bonus_employee_id) ?? emptyTally();
    accumulate(acc, e.mattress_count.toNumber(), e.saves.toNumber(), rule);
    tallyByEmployee.set(e.bonus_employee_id, acc);
  }

  const rows: CurrentPeriodStanding[] = employees.map((e) => {
    const t = tallyByEmployee.get(e.id) ?? emptyTally();
    return {
      employeeId: e.id,
      name: e.full_name,
      employeeNumber: e.employee_number,
      previousNames: e.previous_names,
      isActive: e.is_active,
      units: t.units,
      daysQualified: t.daysQualified,
      daysShort: t.daysShort,
      bonusCents: t.bonusCents,
    };
  });

  return {
    period: {
      id: period.id,
      periodNumber: period.period_number,
      periodYear: period.period_year,
      periodStart: period.period_start,
      periodEnd: period.period_end,
      payDate: period.pay_date,
      state: period.state,
      label: periodLabel(period),
    },
    thresholdLow: rule.threshold_low,
    rows,
  };
}

/** One processor's standing in the open period, for the detail-page banner. */
export interface CurrentPeriodForEmployee {
  period: OpenPeriodMeta | null;
  thresholdLow: number | null;
  /** The processor's standing, or null if they have no keyed days this period. */
  standing: {
    units: number;
    daysQualified: number;
    daysShort: number;
    bonusCents: number;
  } | null;
}

/**
 * The open-period standing for ONE processor — the per-employee detail-page
 * banner. A focused query (the period's entries for this employee only), so it
 * works for active OR since-deactivated processors and never loads the whole
 * roster. Uses the same period + rule + calculator as
 * {@link currentPeriodStandings}, so the banner and the standings table can
 * never disagree. `standing` is null when there is no open period or the
 * processor has no keyed day this period; the banner shows a "no activity" state.
 *
 * `now` is injectable for deterministic tests; production passes `appToday()`.
 */
export async function currentPeriodForEmployee(
  siteId: string,
  employeeId: string,
  now: Date = appToday(),
): Promise<CurrentPeriodForEmployee> {
  const period = await resolveOpenPeriodRow(siteId, now);
  if (!period) return { period: null, thresholdLow: null, standing: null };

  const rule = await resolveActiveRule(siteId, period.period_start);
  const meta: OpenPeriodMeta = {
    id: period.id,
    periodNumber: period.period_number,
    periodYear: period.period_year,
    periodStart: period.period_start,
    periodEnd: period.period_end,
    payDate: period.pay_date,
    state: period.state,
    label: periodLabel(period),
  };

  const entries = await prisma.bonusDailyEntry.findMany({
    where: { bonus_pay_period_id: period.id, bonus_employee_id: employeeId },
    select: { mattress_count: true, saves: true },
  });
  if (entries.length === 0) {
    return { period: meta, thresholdLow: rule.threshold_low, standing: null };
  }

  const t = emptyTally();
  for (const e of entries) accumulate(t, e.mattress_count.toNumber(), e.saves.toNumber(), rule);
  return {
    period: meta,
    thresholdLow: rule.threshold_low,
    standing: {
      units: t.units,
      daysQualified: t.daysQualified,
      daysShort: t.daysShort,
      bonusCents: t.bonusCents,
    },
  };
}
