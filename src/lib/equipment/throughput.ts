// ADR-0078 (supersedes ADR-0044 D2) — the machine's throughput is CAPTURED.
//
// ADR-0044 D2 derived throughput from `processed_units_daily` and reasoned that a
// second entry path would recreate the two-artifact drift class. The reasoning was
// sound and the premise was wrong: `stripped_program + stripped_non_program` is the
// WHOLE FLOOR's output, and calling it the Terex's cannot distinguish the machine
// from hand-stripping or a second machine. It is not a second artifact of the same
// fact — it is a DIFFERENT fact wearing the machine's name. Production shows the
// scale: Woodland's derived "Terex" days run 1,000–1,250 units.
//
// units/day        = the MANAGER-ENTERED `units_processed` for the machine that
//                    day (ADR-0078 D3). NULL on a day nobody entered — rendered
//                    "not recorded", never 0 and never the floor-wide number.
// units/run-hour   = units/day ÷ the ENTERED `run_hours`. Real hours, not the 8h
//                    assumption — the primary reason to capture rather than derive.
// downtime hours   = Σ hours_down of `kind=downtime` events that day. Maintenance
//                    and repair hours are captured but NOT folded into the red
//                    bands: those are planned interventions, not line-stopping
//                    downtime, and the trend view's "downtime" concept must match
//                    the red bands D3 draws (kind=downtime).
// derived floor    = RETAINED and still computed, as a LATENT cross-check only
//                    (ADR-0078 D5). Never rendered as a competing throughput
//                    number. A manager entering 40 units on a day the floor
//                    stripped 400 is either a light Terex day or a data-entry
//                    error, and telling those apart needs a RULE that does not
//                    exist yet — so v1 keeps the input and builds no rule.
//
// The pure builders below are unit-tested without a DB; the one aggregator
// (`computeEquipmentThroughput`) wires them to Prisma, site-scoped (hard rule #2).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appTodayISO, dayISO, dayKeyUTCFromISO } from '@/lib/time';
import { enteredThroughputByDay, resolveSiteThroughputMachine } from './daily-throughput';

/**
 * LEGACY (ADR-0044 D2, superseded by ADR-0078 D3). A Terex working day was assumed
 * to be 8 productive hours because the real figure was not captured anywhere.
 *
 * It is no longer on the live path: `run_hours` is captured with the units, is
 * `NOT NULL` and DB-checked `> 0`, so an entered day ALWAYS carries real hours and
 * the assumption can never stand in for one. Retained, exported and still labeled
 * because the derived series it belongs to is retained as a latent cross-check
 * (D5) — and because deleting a number the UI has been showing, in the same change
 * that moves the number it qualifies, would make two changes look like one.
 */
export const ASSUMED_DAY_HOURS = 8;
export const ASSUMED_DAY_HOURS_LABEL = 'assumed_day_hours' as const;

export interface DailyThroughputPoint {
  dateISO: string;
  /**
   * The MACHINE's entered units for the day. `null` = NOT RECORDED — nobody wrote
   * a number down. It is never 0 (a recorded zero is a real 0) and never the
   * floor-wide derived total (ADR-0078 D3).
   */
  unitsDay: number | null;
  /** The ENTERED run hours; null when the day was not recorded. */
  runHours: number | null;
  /**
   * ADR-0078 D5 — the retained floor-wide `stripped_program + stripped_non_program`.
   * A LATENT cross-check for a future reconciliation rule. This is NOT the
   * machine's throughput and must never be rendered as though it were.
   */
  derivedFloorUnits: number | null;
  /** Σ hours_down of kind=downtime events that day; null when there were none. */
  hoursDown: number | null;
  /** units/day ÷ entered run_hours; null unless the day was recorded. */
  unitsPerRunHour: number | null;
  pocketcoilEstimate: number | null;
  /** 7-day trailing mean of unitsDay (recorded days only); null when none. */
  mean7: number | null;
  /** 30-day trailing mean of unitsDay (recorded days only); null when none. */
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
  /**
   * ADR-0078 D1 — the machine these numbers belong to, resolved from the equipment
   * registry (never hardcoded). `null` at a site with no such machine, which is
   * why every `unitsDay` there is honestly "not recorded" rather than the floor's
   * total relabelled.
   */
  machine: { id: string; displayName: string } | null;
  daily: DailyThroughputPoint[];
  downtimeBands: DowntimeBand[];
  monthlyCost: MonthlyCostPoint[];
  pocketcoil: PocketcoilPoint[];
  summary: {
    last7UnitsPerDay: number | null;
    last30UnitsPerDay: number | null;
    /** ADR-0077 D4 — NULL means no downtime was ever RECORDED; 0 means a recorded zero. */
    totalDowntimeHours: number | null;
    totalCostCents: number;
    /** Days in the window the manager actually recorded. 0 ⇒ nothing entered yet. */
    recordedDays: number;
  };
}

/** A single day's raw inputs, before rolling means are layered on. */
export interface DayInput {
  dateISO: string;
  /** ENTERED units for the machine; null = not recorded. */
  unitsDay: number | null;
  /** ENTERED run hours; null = not recorded. */
  runHours: number | null;
  /** ADR-0078 D5 — retained floor-wide total, a latent cross-check. Not throughput. */
  derivedFloorUnits: number | null;
  hoursDown: number | null;
  pocketcoilEstimate: number | null;
}

/**
 * units/run-hour for one day, from the ENTERED figures. Pure.
 *
 * ADR-0078 D3 — the denominator is now the hours the machine ACTUALLY RAN, not
 * `assumed_day_hours − hours_down`. That old formula answered a question nobody
 * asked ("how many units per hour, if we pretend the day was 8 hours and subtract
 * the downtime somebody happened to log") and it only produced a number at all on
 * days that had downtime recorded — which, on this machine, was never: `hours_down`
 * is NULL on all 67 production Terex rows.
 *
 * Null unless BOTH figures are recorded and the run window is positive, so a
 * missing day yields null rather than a divide-by-zero, an Infinity, or a rate
 * computed against a guess.
 */
export function unitsPerRunHour(unitsDay: number | null, runHours: number | null): number | null {
  if (unitsDay == null || runHours == null || runHours <= 0) return null;
  return unitsDay / runHours;
}

/**
 * ADR-0078 D5 — the SUPERSEDED ADR-0044 D2 rate, retained and exported so the
 * derived series stays fully computable for a future reconciliation cross-check.
 *
 * NOT on the live path and must not be rendered as throughput: its numerator is
 * the whole floor's output and its denominator is an assumption. Kept callable
 * (and tested) rather than deleted so that when the reconciliation rule is
 * specified, the comparison it needs is already here and already pinned.
 */
export function legacyDerivedUnitsPerRunHour(
  derivedFloorUnits: number | null,
  hoursDown: number | null,
  assumedDayHours: number = ASSUMED_DAY_HOURS,
): number | null {
  if (derivedFloorUnits == null || hoursDown == null || hoursDown <= 0) return null;
  const runHours = assumedDayHours - hoursDown;
  if (runHours <= 0) return null;
  return derivedFloorUnits / runHours;
}

/**
 * Trailing rolling mean over `windowDays` (inclusive of each index), counting only
 * non-null values in the window. Pure. `values` MUST be in ascending date order.
 * A window with no data yields null (never NaN).
 */
export function rollingMean(
  values: readonly (number | null)[],
  windowDays: number,
): (number | null)[] {
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
export function buildDailySeries(days: readonly DayInput[]): DailyThroughputPoint[] {
  // The rolling means run over the ENTERED units and skip null days rather than
  // counting them as zero (ADR-0077 D4 / ADR-0078 D3). A machine nobody recorded
  // on Tuesday must not drag Tuesday's absence into Wednesday's average as a 0.
  const units = days.map((d) => d.unitsDay);
  const mean7 = rollingMean(units, 7);
  const mean30 = rollingMean(units, 30);
  return days.map((d, i) => ({
    dateISO: d.dateISO,
    unitsDay: d.unitsDay,
    runHours: d.runHours,
    derivedFloorUnits: d.derivedFloorUnits,
    hoursDown: d.hoursDown,
    unitsPerRunHour: unitsPerRunHour(d.unitsDay, d.runHours),
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
  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthISO, costCents]) => ({ monthISO, costCents }));
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

  // ADR-0078 D1 — resolve the machine from the registry FIRST; every entered read
  // is scoped to that row, never to a hardcoded id and never to a typed string.
  const machine = await resolveSiteThroughputMachine(siteId);

  const [closes, events, entered] = await Promise.all([
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
    // ADR-0078 D3 — the manager's entered days. Absent day ⇒ absent key, never a 0.
    machine
      ? enteredThroughputByDay(siteId, startKey, endKey, machine.id)
      : Promise.resolve(new Map<string, { unitsProcessed: number; runHours: number }>()),
  ]);

  // ADR-0078 D5 — the floor-wide total is still computed, and is NOT unitsDay.
  const derivedFloorByDay = new Map<string, number>();
  const pocketByDay = new Map<string, number>();
  for (const c of closes) {
    const k = dayISO(c.production_date);
    derivedFloorByDay.set(k, num(c.stripped_program) + num(c.stripped_non_program));
    if (c.pocketcoil_estimate != null) pocketByDay.set(k, c.pocketcoil_estimate);
  }

  const downtimeByDay = new Map<string, number>();
  for (const e of events) {
    if (e.kind !== 'downtime' || e.hours_down == null) continue;
    const k = dayISO(e.event_date);
    downtimeByDay.set(k, (downtimeByDay.get(k) ?? 0) + num(e.hours_down));
  }

  // `.has()` rather than `?? null`: a RECORDED zero must survive as 0. Reading a
  // map with `??` would collapse a real "the machine ran and produced nothing"
  // into "not recorded" — the exact conflation ADR-0077 D4 exists to prevent, and
  // the reason each lookup below tests presence before reading.
  const dayInputs: DayInput[] = enumerateDaysISO(startISO, endISO).map((dateISO) => {
    const e = entered.get(dateISO);
    return {
      dateISO,
      unitsDay: e ? e.unitsProcessed : null,
      runHours: e ? e.runHours : null,
      derivedFloorUnits: derivedFloorByDay.has(dateISO) ? derivedFloorByDay.get(dateISO)! : null,
      hoursDown: downtimeByDay.has(dateISO) ? downtimeByDay.get(dateISO)! : null,
      pocketcoilEstimate: pocketByDay.has(dateISO) ? pocketByDay.get(dateISO)! : null,
    };
  });

  const daily = buildDailySeries(dayInputs);
  const downtimeBands: DowntimeBand[] = dayInputs
    .filter((d) => d.hoursDown != null && d.hoursDown > 0)
    .map((d) => ({ dateISO: d.dateISO, hoursDown: d.hoursDown! }));
  const monthlyCost = monthlyCostSeries(
    events.map((e) => ({ eventDate: e.event_date, costCents: e.cost_cents })),
  );
  const pocketcoil: PocketcoilPoint[] = dayInputs
    .filter((d) => d.pocketcoilEstimate != null)
    .map((d) => ({ dateISO: d.dateISO, estimate: d.pocketcoilEstimate! }));

  const last = daily[daily.length - 1];
  // ADR-0077 D4 — NULL, not 0, when the window recorded no downtime AT ALL.
  //
  // `equipment_events.hours_down` is NULL on all 68 production Terex rows: the
  // column has never once been written. Summing that to `0` and rendering
  // "0.0 hrs" told Bill the machine never stopped, and the overview card went
  // one further and painted it GREEN (`tone: hoursDown > 0 ? 'warn' : 'ok'`) —
  // an unmeasured machine displayed as a perfect one. The distinction the type
  // has to carry is "nobody recorded any" vs "somebody recorded none", and only
  // the second of those is a zero.
  //
  // Measured off `dayInputs` rather than `downtimeBands`, because the bands
  // deliberately drop `hoursDown === 0` for the chart — reusing them here would
  // re-collapse a genuine recorded zero back into "not recorded".
  const daysWithDowntime = dayInputs.filter((d) => d.hoursDown != null);
  const totalDowntimeHours =
    daysWithDowntime.length === 0
      ? null
      : daysWithDowntime.reduce((s, d) => s + (d.hoursDown ?? 0), 0);
  const totalCostCents = monthlyCost.reduce((s, m) => s + m.costCents, 0);

  return {
    windowStartISO: startISO,
    windowEndISO: endISO,
    assumedDayHours: ASSUMED_DAY_HOURS,
    assumedDayHoursLabel: ASSUMED_DAY_HOURS_LABEL,
    machine,
    daily,
    downtimeBands,
    monthlyCost,
    pocketcoil,
    summary: {
      last7UnitsPerDay: last?.mean7 ?? null,
      last30UnitsPerDay: last?.mean30 ?? null,
      totalDowntimeHours,
      totalCostCents,
      recordedDays: dayInputs.filter((d) => d.unitsDay != null).length,
    },
  };
}
