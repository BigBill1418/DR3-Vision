// ADR-0044 D2 — derived equipment throughput (one source of truth).
//
// Throughput is NOT captured anywhere in ADR-0044 — it is DERIVED from
// `processed_units_daily` (ADR-0037 D5, the number billing bills from). A second
// entry path would recreate the two-artifact drift class (mission §B8), so this
// module only READS. The pure builders below are unit-tested without a DB; the one
// aggregator (`computeEquipmentThroughput`) wires them to Prisma, site-scoped
// (CLAUDE.md hard rule #2).
//
// units/day        = stripped_program + stripped_non_program for the day.
// units/run-hour   = units/day ÷ (assumed_day_hours − downtime_hours), computed
//                    only on days that have downtime hours (D2). The productive
//                    hours in a day are not captured, so a single ASSUMED constant
//                    stands in — labeled `assumed_day_hours` and surfaced to the UI
//                    (a config table would be overkill for one number, D2).
// downtime hours   = Σ hours_down of `kind=downtime` events that day. Maintenance
//                    and repair hours are captured but NOT folded into the run-hour
//                    denominator or the red bands: those are planned interventions,
//                    not line-stopping downtime, and the trend view's "downtime"
//                    concept must match the red bands D3 draws (kind=downtime).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';

/**
 * The one throughput assumption (D2): a Terex working day is 8 productive hours.
 * The productive-hours figure is not captured, so this constant stands in and is
 * surfaced to the UI as `assumed_day_hours` (never silently baked in).
 */
export const ASSUMED_DAY_HOURS = 8;
export const ASSUMED_DAY_HOURS_LABEL = 'assumed_day_hours' as const;

export interface DailyThroughputPoint {
  dateISO: string;
  /** stripped_program + stripped_non_program; null on a day with no close. */
  unitsDay: number | null;
  /** Σ hours_down of kind=downtime events that day; null when there were none. */
  hoursDown: number | null;
  /** units/day ÷ (assumed_day_hours − hoursDown); null unless downtime existed. */
  unitsPerRunHour: number | null;
  pocketcoilEstimate: number | null;
  /** 7-day trailing mean of unitsDay (non-null days only); null when none. */
  mean7: number | null;
  /** 30-day trailing mean of unitsDay (non-null days only); null when none. */
  mean30: number | null;
}

export interface DowntimeBand {
  dateISO: string;
  hoursDown: number;
}

export interface MonthlyCostPoint {
  /** First-of-month ISO `YYYY-MM`. */
  monthISO: string;
  costCents: number;
}

export interface PocketcoilPoint {
  dateISO: string;
  estimate: number;
}

export interface EquipmentThroughput {
  windowStartISO: string;
  windowEndISO: string;
  assumedDayHours: number;
  assumedDayHoursLabel: typeof ASSUMED_DAY_HOURS_LABEL;
  daily: DailyThroughputPoint[];
  downtimeBands: DowntimeBand[];
  monthlyCost: MonthlyCostPoint[];
  pocketcoil: PocketcoilPoint[];
  summary: {
    last7UnitsPerDay: number | null;
    last30UnitsPerDay: number | null;
    totalDowntimeHours: number;
    totalCostCents: number;
  };
}

/** A single day's raw inputs, before rolling means are layered on. */
export interface DayInput {
  dateISO: string;
  unitsDay: number | null;
  hoursDown: number | null;
  pocketcoilEstimate: number | null;
}

/**
 * units/run-hour for one day. Pure. Returns null unless downtime hours exist
 * (D2 — the metric is only meaningful when the productive window was reduced),
 * unitsDay is known, and the remaining run window is positive. A downtime that
 * meets or exceeds the assumed day (run window ≤ 0) yields null rather than a
 * divide-by-zero or a negative rate.
 */
export function unitsPerRunHour(
  unitsDay: number | null,
  hoursDown: number | null,
  assumedDayHours: number = ASSUMED_DAY_HOURS,
): number | null {
  if (unitsDay == null || hoursDown == null || hoursDown <= 0) return null;
  const runHours = assumedDayHours - hoursDown;
  if (runHours <= 0) return null;
  return unitsDay / runHours;
}

/**
 * Trailing rolling mean over `windowDays` (inclusive of each index), counting only
 * non-null values in the window. Pure. `values` MUST be in ascending date order.
 * A window with no data yields null (never NaN).
 */
export function rollingMean(values: readonly (number | null)[], windowDays: number): (number | null)[] {
  return values.map((_, i) => {
    const from = Math.max(0, i - windowDays + 1);
    let sum = 0;
    let n = 0;
    for (let j = from; j <= i; j++) {
      const v = values[j];
      if (v != null) {
        sum += v;
        n += 1;
      }
    }
    return n === 0 ? null : sum / n;
  });
}

/** Every calendar day ISO from `startISO`..`endISO` inclusive, ascending. Pure. */
export function enumerateDaysISO(startISO: string, endISO: string): string[] {
  const start = dayKeyUTCFromISO(startISO);
  const end = dayKeyUTCFromISO(endISO);
  const out: string[] = [];
  for (let d = start; d.getTime() <= end.getTime(); d = new Date(d.getTime() + 86_400_000)) {
    out.push(dayISO(d));
  }
  return out;
}

/**
 * Layer rolling means + run-hour onto a day-ordered input series. Pure.
 * `days` MUST be ascending by date.
 */
export function buildDailySeries(
  days: readonly DayInput[],
  assumedDayHours: number = ASSUMED_DAY_HOURS,
): DailyThroughputPoint[] {
  const units = days.map((d) => d.unitsDay);
  const mean7 = rollingMean(units, 7);
  const mean30 = rollingMean(units, 30);
  return days.map((d, i) => ({
    dateISO: d.dateISO,
    unitsDay: d.unitsDay,
    hoursDown: d.hoursDown,
    unitsPerRunHour: unitsPerRunHour(d.unitsDay, d.hoursDown, assumedDayHours),
    pocketcoilEstimate: d.pocketcoilEstimate,
    mean7: mean7[i] ?? null,
    mean30: mean30[i] ?? null,
  }));
}

/** Σ cost_cents per calendar month (`YYYY-MM`), ascending by month. Pure. */
export function monthlyCostSeries(
  events: readonly { eventDate: Date; costCents: number | null }[],
): MonthlyCostPoint[] {
  const byMonth = new Map<string, number>();
  for (const e of events) {
    if (e.costCents == null) continue;
    const m = dayISO(e.eventDate).slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + e.costCents);
  }
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([monthISO, costCents]) => ({ monthISO, costCents }));
}

function num(v: Prisma.Decimal | number | null | undefined): number {
  if (v == null) return 0;
  return typeof v === 'number' ? v : v.toNumber();
}

/**
 * Compute the derived throughput view for a site over a rolling window ending
 * today (Pacific). Site-scoped. Never throws on empty data — a window with no
 * closes yields an all-null daily series, not a crash. `nowISO`/`windowDays` are
 * injectable for deterministic tests.
 */
export async function computeEquipmentThroughput(
  siteId: string,
  opts: { nowISO?: string; windowDays?: number; equipmentCode?: string } = {},
): Promise<EquipmentThroughput> {
  const windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : 90;
  const endISO = opts.nowISO ?? appTodayISO();
  const endKey = dayKeyUTCFromISO(endISO);
  const startKey = new Date(endKey.getTime() - (windowDays - 1) * 86_400_000);
  const startISO = dayISO(startKey);

  const [closes, events] = await Promise.all([
    prisma.processedUnitsDaily.findMany({
      where: { site_id: siteId, production_date: { gte: startKey, lte: endKey } },
      select: {
        production_date: true,
        stripped_program: true,
        stripped_non_program: true,
        pocketcoil_estimate: true,
      },
      orderBy: { production_date: 'asc' },
    }),
    prisma.equipmentEvent.findMany({
      where: {
        site_id: siteId,
        voided_at: null,
        event_date: { gte: startKey, lte: endKey },
        ...(opts.equipmentCode ? { equipment_code: opts.equipmentCode } : {}),
      },
      select: { event_date: true, kind: true, hours_down: true, cost_cents: true },
    }),
  ]);

  const unitsByDay = new Map<string, number>();
  const pocketByDay = new Map<string, number>();
  for (const c of closes) {
    const k = dayISO(c.production_date);
    unitsByDay.set(k, num(c.stripped_program) + num(c.stripped_non_program));
    if (c.pocketcoil_estimate != null) pocketByDay.set(k, c.pocketcoil_estimate);
  }

  const downtimeByDay = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'downtime' || e.hours_down == null) continue;
    const k = dayISO(e.event_date);
    downtimeByDay.set(k, (downtimeByDay.get(k) ?? 0) + num(e.hours_down));
  }

  const dayInputs: DayInput[] = enumerateDaysISO(startISO, endISO).map((dateISO) => ({
    dateISO,
    unitsDay: unitsByDay.has(dateISO) ? unitsByDay.get(dateISO)! : null,
    hoursDown: downtimeByDay.has(dateISO) ? downtimeByDay.get(dateISO)! : null,
    pocketcoilEstimate: pocketByDay.has(dateISO) ? pocketByDay.get(dateISO)! : null,
  }));

  const daily = buildDailySeries(dayInputs, ASSUMED_DAY_HOURS);
  const downtimeBands: DowntimeBand[] = dayInputs
    .filter((d) => d.hoursDown != null && d.hoursDown > 0)
    .map((d) => ({ dateISO: d.dateISO, hoursDown: d.hoursDown! }));
  const monthlyCost = monthlyCostSeries(events.map((e) => ({ eventDate: e.event_date, costCents: e.cost_cents })));
  const pocketcoil: PocketcoilPoint[] = dayInputs
    .filter((d) => d.pocketcoilEstimate != null)
    .map((d) => ({ dateISO: d.dateISO, estimate: d.pocketcoilEstimate! }));

  const last = daily[daily.length - 1];
  const totalDowntimeHours = downtimeBands.reduce((s, b) => s + b.hoursDown, 0);
  const totalCostCents = monthlyCost.reduce((s, m) => s + m.costCents, 0);

  return {
    windowStartISO: startISO,
    windowEndISO: endISO,
    assumedDayHours: ASSUMED_DAY_HOURS,
    assumedDayHoursLabel: ASSUMED_DAY_HOURS_LABEL,
    daily,
    downtimeBands,
    monthlyCost,
    pocketcoil,
    summary: {
      last7UnitsPerDay: last?.mean7 ?? null,
      last30UnitsPerDay: last?.mean30 ?? null,
      totalDowntimeHours,
      totalCostCents,
    },
  };
}
