// ADR-0079 (supersedes ADR-0044 D2) — the machine's throughput is CAPTURED.
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
//                    day (ADR-0079 D3). NULL on a day nobody entered — rendered
//                    "not recorded", never 0 and never the floor-wide number.
// units/run-hour   = units/day ÷ the ENTERED `run_hours`. Real hours, not the 8h
//                    assumption — the primary reason to capture rather than derive.
// downtime hours   = Σ hours_down of `kind=downtime` events that day. Maintenance
//                    and repair hours are captured but NOT folded into the red
//                    bands: those are planned interventions, not line-stopping
//                    downtime, and the trend view's "downtime" concept must match
//                    the red bands D3 draws (kind=downtime).
// derived floor    = RETAINED and still computed, as a LATENT cross-check only
//                    (ADR-0079 D5). Never rendered as a competing throughput
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
import {
  enteredThroughputByDay,
  resolveSiteThroughputMachine,
  type RecordedDay,
} from './daily-throughput';

/**
 * LEGACY (ADR-0044 D2, superseded by ADR-0079 D3). A Terex working day was assumed
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

/**
 * ADR-0079 Amendment 1 — the day daily capture began. The ERA BOUNDARY.
 *
 * Days BEFORE this are the sheet era: no manager entry exists or ever will, and
 * the honest thing to show is the floor-derived figure, LABELED as floor-wide.
 * Days FROM this date on are the capture era, where an absent entry is a real
 * gap and must stay loudly "not recorded".
 *
 * A STORED CONSTANT, deliberately never derived from the data. Deriving the
 * boundary from "the first entered day" would silently RE-LABEL history the
 * moment anyone backfills an older day: one manager entering 2026-07-15 would
 * flip every day from mid-July onward out of the legacy era and into "not
 * recorded", blanking a month of the chart as a side effect of a single entry.
 * The boundary is a fact about when the process changed, not a fact about the
 * contents of the table. `cutover.boundary-is-constant-not-data` pins this.
 */
export const TEREX_CAPTURE_CUTOVER_ISO = '2026-08-07';

/**
 * ADR-0079 Amendment 1 — where a day's displayed number CAME FROM.
 *
 * The whole point of Amendment 1 is that history stayed visible without the
 * floor's number ever passing itself off as the machine's. Every consumer must
 * be able to tell the two apart, so provenance travels WITH the number rather
 * than being re-inferred (and re-inferred differently) at each render site.
 *
 * - `entered`        — a manager's own figure for the machine. The truth.
 * - `workbook`       — ADR-0081. The MACHINE'S OWN number, read off the TEREX
 *                      workbook's monthly operating tabs, with the machine's own
 *                      run hours beside it. Not a person's entry, and not the
 *                      floor's total either: it is the same measurement JT now
 *                      types in, taken from the sheet that is being replaced.
 * - `legacy_derived` — a pre-cutover day showing `derivedFloorUnits`: the whole
 *                      floor's output, NOT machine-specific. MUST be rendered
 *                      with a structural legacy treatment and never as entered.
 * - `not_recorded`   — nothing to show. Post-cutover gaps land here and stay
 *                      loud; `derivedFloorUnits` is NOT substituted for them.
 */
export type ThroughputSource = 'entered' | 'workbook' | 'legacy_derived' | 'not_recorded';

/**
 * ADR-0081 — the two sources that are REAL measurements of THIS MACHINE.
 *
 * The distinction that matters for every statistic on the page is not
 * manager-vs-sheet, it is machine-vs-floor. `entered` and `workbook` are the
 * same physical quantity recorded by the same people about the same machine,
 * one typed into Vision and one typed into Excel. `legacy_derived` is a
 * different quantity entirely.
 */
export function isRealMachineSource(source: ThroughputSource): boolean {
  return source === 'entered' || source === 'workbook';
}

export interface DailyThroughputPoint {
  dateISO: string;
  /**
   * ADR-0079 Am.1 — provenance of this day's displayed figure. Read this BEFORE
   * deciding how to draw the day; `unitsDay` alone cannot distinguish a machine
   * number from a floor number.
   */
  source: ThroughputSource;
  /**
   * The MACHINE's entered units for the day. `null` = NOT RECORDED — nobody wrote
   * a number down. It is never 0 (a recorded zero is a real 0) and never the
   * floor-wide derived total (ADR-0079 D3).
   */
  unitsDay: number | null;
  /** The ENTERED run hours; null when the day was not recorded. */
  runHours: number | null;
  /**
   * ADR-0079 D5 — the retained floor-wide `stripped_program + stripped_non_program`.
   * A LATENT cross-check for a future reconciliation rule. This is NOT the
   * machine's throughput and must never be rendered as though it were.
   */
  derivedFloorUnits: number | null;
  /** Σ hours_down of kind=downtime events that day; null when there were none. */
  hoursDown: number | null;
  /** units/day ÷ entered run_hours; null unless the day was recorded. */
  unitsPerRunHour: number | null;
  pocketcoilEstimate: number | null;
  /**
   * ADR-0081 D5 — 7-day trailing mean over the COMBINED REAL series
   * (`entered` + `workbook`). Supersedes Am.1 D10's entered-only rule; see
   * `buildDailySeries` for why blending these two is like-with-like while
   * blending in `legacy_derived` still is not.
   */
  mean7: number | null;
  /** 30-day trailing mean over the combined real series; null when none. */
  mean30: number | null;
  /** What the 7-day window is made of. The mean is not shown without it. */
  mean7Composition: { entered: number; workbook: number };
  mean30Composition: { entered: number; workbook: number };
  /** e.g. `"7-day mean — 5 sheet, 2 entered"`. Null when the window is empty. */
  mean7Label: string | null;
  mean30Label: string | null;
  /**
   * ADR-0079 Am.1 — 7-day trailing mean over LEGACY days only.
   *
   * A SEPARATE field rather than a widened `mean7`, because the two eras measure
   * different things: legacy days are the whole floor (1,000–1,250 units at
   * Woodland) and entered days are one machine (a few hundred). A window
   * straddling the boundary would average those into a figure that describes
   * nothing and — being plotted on the machine's line — would read as the
   * machine's. No field in this type ever carries a blended number.
   * `means.no-blending-across-era` pins this.
   */
  legacyMean7: number | null;
  /** 30-day trailing mean over LEGACY days only. Never blended with `mean30`. */
  legacyMean30: number | null;
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
   * ADR-0079 D1 — the machine these numbers belong to, resolved from the equipment
   * registry (never hardcoded). `null` at a site with no such machine, which is
   * why every `unitsDay` there is honestly "not recorded" rather than the floor's
   * total relabelled.
   */
  machine: { id: string; displayName: string } | null;
  /**
   * ADR-0079 Am.1 — the era boundary, passed to the UI so the legacy legend names
   * the real date instead of hardcoding one that could drift from the constant.
   */
  captureCutoverISO: string;
  daily: DailyThroughputPoint[];
  downtimeBands: DowntimeBand[];
  monthlyCost: MonthlyCostPoint[];
  pocketcoil: PocketcoilPoint[];
  summary: {
    last7UnitsPerDay: number | null;
    last30UnitsPerDay: number | null;
    /** ADR-0077 D4 — NULL means no downtime was ever RECORDED; 0 means a recorded zero. */
    totalDowntimeHours: number | null;
    /**
     * ADR-0077 Amendment 2 — NULL means no event in the window recorded a cost at
     * all; 0 means a real, recorded zero.
     *
     * This was `number` and summed to `0` when nothing was priced, which painted
     * an unpriced machine as a free one — the same defect ADR-0077 D4 fixed for
     * downtime and deliberately left here because cost is only PARTLY unpopulated
     * (7 of 68 live events carry one), which made it the weaker case rather than
     * a different one. Partly-populated is exactly when the fake zero is most
     * convincing: the column looks alive, so nobody questions the total.
     */
    totalCostCents: number | null;
    /**
     * ADR-0081 D5 — days in the window carrying a REAL machine figure, from
     * either real source. This is the denominator every tile discloses.
     */
    recordedDays: number;
    /** Of those, how many a person entered. */
    enteredDays: number;
    /** Of those, how many came from the imported workbook. */
    workbookDays: number;
    /** e.g. `"7-day mean — 5 sheet, 2 entered"`. Null when nothing is recorded. */
    last7Label: string | null;
    last30Label: string | null;
  };
}

/** A single day's raw inputs, before rolling means are layered on. */
export interface DayInput {
  dateISO: string;
  /** The RECORDED units for the machine (manager or workbook); null = not recorded. */
  unitsDay: number | null;
  /** The RECORDED run hours; null = not recorded. */
  runHours: number | null;
  /** ADR-0081 — the recorded row is a workbook projection, not a person's entry. */
  recordedIsWorkbook?: boolean;
  /** ADR-0079 D5 — retained floor-wide total, a latent cross-check. Not throughput. */
  derivedFloorUnits: number | null;
  hoursDown: number | null;
  pocketcoilEstimate: number | null;
}

/**
 * ADR-0079 Am.1 — classify one day into its era. Pure; the single place the
 * boundary rule lives, so no render site can invent its own.
 *
 * ENTERED ALWAYS WINS, on either side of the boundary. A manager who fills in an
 * old day has replaced the floor's guess with the machine's real number, and
 * Bill's instruction was that history "should have all stayed and just been added
 * to" — so an addition must beat the legacy figure it supersedes, not be ignored
 * for being early.
 *
 * A pre-cutover day with NO entry and NO close has nothing to show and is
 * `not_recorded`: `legacy_derived` is a promise that there IS a derived figure to
 * render, and a source that lies about having a number is worse than none.
 */
export function classifyDaySource(
  dateISO: string,
  enteredUnits: number | null,
  derivedFloorUnits: number | null,
  cutoverISO: string = TEREX_CAPTURE_CUTOVER_ISO,
  /**
   * ADR-0081 — true when the RECORDED row for this day came from the imported
   * workbook rather than from a person.
   *
   * Note there is no tie-break between `entered` and `workbook`, and there does
   * not need to be: ADR-0079's partial unique index allows exactly ONE live row
   * per (machine, day), so a day is recorded by one source or the other and
   * never both. The precedence `entered → workbook` is enforced by the DATABASE
   * — the import's `ON CONFLICT ... DO UPDATE ... WHERE source =
   * 'workbook_import'` cannot overwrite a manager's row, and a manager's entry
   * overwrites an imported one in place. A tie-break here would be dead code
   * dressed up as a safeguard.
   */
  recordedIsWorkbook = false,
): ThroughputSource {
  if (enteredUnits != null) return recordedIsWorkbook ? 'workbook' : 'entered';
  if (dateISO < cutoverISO && derivedFloorUnits != null) return 'legacy_derived';
  return 'not_recorded';
}

/**
 * units/run-hour for one day, from the ENTERED figures. Pure.
 *
 * ADR-0079 D3 — the denominator is now the hours the machine ACTUALLY RAN, not
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
 * ADR-0079 D5 — the SUPERSEDED ADR-0044 D2 rate, retained and exported so the
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

/**
 * ADR-0081 D5 — how many days of each REAL source sit inside each trailing
 * window. Pure. `sources` MUST be in ascending date order.
 *
 * The composition is carried rather than recomputed at render time because it
 * is what makes a blended mean HONEST: a "7-day mean" over five sheet days and
 * two entered days is a defensible number, but only if the reader is told that
 * is what it is. A blended figure with no disclosure would be exactly the
 * silent conflation Am.1 D10 refused.
 */
export function rollingComposition(
  sources: readonly ThroughputSource[],
  windowDays: number,
): { entered: number; workbook: number }[] {
  return sources.map((_, i) => {
    const from = Math.max(0, i - windowDays + 1);
    let entered = 0;
    let workbook = 0;
    for (let j = from; j <= i; j++) {
      if (sources[j] === 'entered') entered += 1;
      else if (sources[j] === 'workbook') workbook += 1;
    }
    return { entered, workbook };
  });
}

/**
 * ADR-0081 D5 — the disclosure that rides every blended mean.
 *
 * `"7-day mean — 5 sheet, 2 entered"`. Both halves are named only when both are
 * present; a pure window says `"7-day mean — 7 entered"` rather than
 * `"7 entered, 0 sheet"`, because a zero-count clause reads as a warning about
 * something that did not happen. An empty window returns null — there is no
 * mean to label.
 */
export function meanWindowLabel(
  windowDays: number,
  comp: { entered: number; workbook: number },
): string | null {
  const parts: string[] = [];
  if (comp.workbook > 0) parts.push(`${comp.workbook} sheet`);
  if (comp.entered > 0) parts.push(`${comp.entered} entered`);
  if (parts.length === 0) return null;
  return `${windowDays}-day mean — ${parts.join(', ')}`;
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
  cutoverISO: string = TEREX_CAPTURE_CUTOVER_ISO,
): DailyThroughputPoint[] {
  const sources = days.map((d) =>
    classifyDaySource(
      d.dateISO,
      d.unitsDay,
      d.derivedFloorUnits,
      cutoverISO,
      d.recordedIsWorkbook === true,
    ),
  );

  // ── ADR-0081 D5 — the means run over the COMBINED REAL SERIES ─────────────
  //
  // This SUPERSEDES ADR-0079 Amendment 1 D10 ("means never blend across the
  // era") for the entered/workbook pair, and it does so on Bill's directive:
  // "ALL OF THAT DATA needs to be aggregated and displayed IN THIS PAGE."
  //
  // Am.1 was right to refuse blending, and its reason is worth restating
  // because it is what makes this change safe rather than a reversal: the thing
  // it refused to blend was the WHOLE FLOOR's output (1,000–1,250 units/day at
  // Woodland) with ONE MACHINE's (a few hundred). Those measure different
  // physical quantities, so an average across them describes nothing.
  //
  // The workbook figure is not that. It is the machine's own units against the
  // machine's own hour-meter hours — the identical measurement JT now types
  // into Vision, taken from the sheet Vision is replacing. Blending it with
  // `entered` is blending like with like; refusing to would leave a 19-month
  // history sitting next to a 7-day average that ignores it, which is precisely
  // the blank-history complaint Am.1 itself was written to fix.
  //
  // `legacy_derived` is STILL never blended. `legacyMean7`/`legacyMean30` below
  // are unchanged and remain a disjoint series over proxy-only days.
  const units = days.map((d, i) => (isRealMachineSource(sources[i]!) ? d.unitsDay : null));
  const mean7 = rollingMean(units, 7);
  const mean30 = rollingMean(units, 30);
  const comp7 = rollingComposition(sources, 7);
  const comp30 = rollingComposition(sources, 30);

  // ADR-0079 Am.1 — the legacy means run over a DISJOINT set of days. `units`
  // above is entered-only and `legacyUnits` here is legacy-only, so no window
  // can mix a floor-wide figure into a machine average no matter where the
  // boundary falls inside it. The separation is structural, not a guard.
  const legacyUnits = days.map((d, i) =>
    sources[i] === 'legacy_derived' ? d.derivedFloorUnits : null,
  );
  const legacyMean7 = rollingMean(legacyUnits, 7);
  const legacyMean30 = rollingMean(legacyUnits, 30);

  return days.map((d, i) => ({
    dateISO: d.dateISO,
    source: sources[i]!,
    unitsDay: d.unitsDay,
    runHours: d.runHours,
    derivedFloorUnits: d.derivedFloorUnits,
    hoursDown: d.hoursDown,
    // ADR-0079 Am.1 §5 — a legacy day gets NO rate. Reviving the assumed-8h
    // figure, even labeled, would publish a number whose denominator was
    // fabricated. `unitsPerRunHour` is entered-only and already returns null
    // here; that is the correct answer, not an omission to be fixed.
    unitsPerRunHour: unitsPerRunHour(d.unitsDay, d.runHours),
    pocketcoilEstimate: d.pocketcoilEstimate,
    mean7: mean7[i] ?? null,
    mean30: mean30[i] ?? null,
    // ADR-0081 D5 — the disclosure travels WITH the blended figure, so no
    // render site can show the mean without being able to show what is in it.
    mean7Composition: comp7[i] ?? { entered: 0, workbook: 0 },
    mean30Composition: comp30[i] ?? { entered: 0, workbook: 0 },
    mean7Label: meanWindowLabel(7, comp7[i] ?? { entered: 0, workbook: 0 }),
    mean30Label: meanWindowLabel(30, comp30[i] ?? { entered: 0, workbook: 0 }),
    // Rendered ONLY on legacy days, so the dashed legacy line STOPS at the
    // boundary. The trailing window still contains legacy values for a few days
    // past the cutover, and plotting those over entered days would run a ~1,070
    // line across the machine's era — a floor figure sitting on machine days,
    // which is precisely what this amendment exists to prevent.
    legacyMean7: sources[i] === 'legacy_derived' ? (legacyMean7[i] ?? null) : null,
    legacyMean30: sources[i] === 'legacy_derived' ? (legacyMean30[i] ?? null) : null,
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

  // ADR-0079 D1 — resolve the machine from the registry FIRST; every entered read
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
    // ADR-0079 D3 — the manager's entered days. Absent day ⇒ absent key, never a 0.
    machine
      ? enteredThroughputByDay(siteId, startKey, endKey, machine.id)
      : Promise.resolve(new Map<string, RecordedDay>()),
  ]);

  // ADR-0079 D5 — the floor-wide total is still computed, and is NOT unitsDay.
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
      // ADR-0081 — provenance from the row itself, never re-inferred by date.
      recordedIsWorkbook: e ? e.isWorkbook : false,
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
  // Mirrors `totalDowntimeHours` above, deliberately: presence is decided on the
  // EVENTS, not on the monthly series. `monthlyCostSeries` drops null-cost events,
  // so an empty series is ambiguous — it means "nothing priced" AND "no events" AND
  // "every event priced at zero" — and reducing it to 0 is what manufactured the
  // free machine. Reading the events keeps a recorded 0 distinct from no record.
  const pricedEvents = events.filter((e) => e.cost_cents != null);
  const totalCostCents =
    pricedEvents.length === 0
      ? null
      : pricedEvents.reduce((sum, e) => sum + (e.cost_cents ?? 0), 0);

  return {
    windowStartISO: startISO,
    windowEndISO: endISO,
    assumedDayHours: ASSUMED_DAY_HOURS,
    assumedDayHoursLabel: ASSUMED_DAY_HOURS_LABEL,
    machine,
    captureCutoverISO: TEREX_CAPTURE_CUTOVER_ISO,
    daily,
    downtimeBands,
    monthlyCost,
    pocketcoil,
    summary: {
      last7UnitsPerDay: last?.mean7 ?? null,
      last30UnitsPerDay: last?.mean30 ?? null,
      totalDowntimeHours,
      totalCostCents,
      // ADR-0081 D5 — the combined REAL series. Every stat box on the page
      // computes over `entered` + `workbook`, because both are this machine's
      // own units against this machine's own hours.
      recordedDays: daily.filter((d) => isRealMachineSource(d.source)).length,
      enteredDays: daily.filter((d) => d.source === 'entered').length,
      workbookDays: daily.filter((d) => d.source === 'workbook').length,
      last7Label: last?.mean7Label ?? null,
      last30Label: last?.mean30Label ?? null,
    },
  };
}
