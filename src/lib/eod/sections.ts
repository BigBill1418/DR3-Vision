// ADR-0125 — the day, sectioned, with a gap flag per section.
//
// This module is the ONE place a day's captured rows are read and turned into
// numbers. The EOD screen's per-day sections and its month-to-date rollup are
// both built from these functions — the rollup is a PURE FOLD over the same
// per-day totals the sections display (`rollupFromDays`), never a second set of
// queries. That is the whole G-1/ADR-0110 discipline: one computation of one
// number. A rollup that re-derived its own totals would be a second computation,
// and two computations of one number is the defect, not the redundancy.
//
// ── Why the sheet's Summary tabs are NOT the acceptance target ──────────────
//
// The handoff's original criterion was "the rollup reproduces the Summary /
// Trans Summary tabs". The Phase 0 audit measured the workbook and found those
// tabs sum over DUPLICATED rows: `inb no trans charge` and the unpaid drop-off
// block carry every row exactly twice in both July and August, and the sheet's
// `Transportation Total` and `Fuel Surcharge` equal the doubled sums (July:
// 112,150 raw / 56,075 distinct — exactly 2.000x). Matching the sheet would
// reproduce a defect. The criterion is therefore withdrawn and replaced with:
// the rollup equals the sum of the sections it displays, and any divergence from
// the sheet is a REPORTED reconciliation line, not an error to eliminate.
//
// ── The channel-routing rule (G-4), recorded so nobody re-opens it ──────────
//
// `inbound_loads` has NO `commodity` column and does not need one. The workbook's
// `commodity` cell on the inbound tabs is a CHANNEL label, not a material — its
// live values are `inbound units`, `Illegal Drop off`, `Unpaid Consumer Drop off`,
// `Incentive drop off`, `event units`. The routing is:
//
//   inbound units          -> inbound_loads
//   Unpaid Consumer Drop off -> consumer_dropoffs.kind = 'unpaid'
//   Incentive drop off     -> consumer_dropoffs.kind = 'incentive'
//   Illegal Drop off       -> consumer_dropoffs.kind = 'illegal'
//   event units            -> the Events channel — OUT OF SCOPE here (G-12,
//                             Bill's Phase-3 decision)
//
// So "no home" is the correct verdict for that cell, not "a missing enum".

import { Prisma, type OutboundCommodity, type OutboundSubCategory } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  dayISO,
  dayKeyUTCFromISO,
  pacificDayKeyUTC,
  pacificMidnightInstantOfDayISO,
} from '@/lib/time';

const D = Prisma.Decimal;

/**
 * A section's capture state.
 *
 * THREE states, not two. `not_applicable` is the one that stops this surface
 * lying about Eugene: Eugene has no Terex, so a two-state flag would put a
 * permanent warning on a site that is behaving correctly. "Could not apply" and
 * "is missing" are different statements and a flag that cannot tell them apart
 * trains people to ignore it.
 */
export type GapFlag = 'captured' | 'missing' | 'not_applicable';

/** The sections that carry a gap flag, in render order. */
export const FLAGGED_SECTIONS = [
  'inbound',
  'outbound',
  'processed',
  'nonProgram',
  'unpaidDropoff',
  'terex',
] as const;
export type FlaggedSection = (typeof FLAGGED_SECTIONS)[number];

// ─────────────────────────────────────────────────────────────────────────
// Row shapes (what the loader returns, before bucketing)
// ─────────────────────────────────────────────────────────────────────────

export interface InboundLine {
  id: string;
  dayKey: string;
  arrivedAt: Date | null;
  loadSourceType: string;
  status: string;
  sourceName: string | null;
  totalUnits: number;
  programUnits: number;
  nonProgramUnits: number;
  weightLbs: number | null;
  /** The sheet's `BOL # or Check #`. Vision holds only the BOL half. */
  bolNumber: string | null;
  dr3Number: string | null;
  haulNumber: string | null;
  slipNumber: string | null;
  /** The freight / no-freight split — which of the two Inbound tabs this row is. */
  transportCharged: boolean;
}

export interface OutboundLine {
  id: string;
  dayKey: string;
  commodity: OutboundCommodity;
  subCategory: OutboundSubCategory;
  weightLbs: number;
  wholeUnits: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  ticketNumber: string | null;
}

export interface DropoffLine {
  id: string;
  dayKey: string;
  kind: string;
  personName: string | null;
  units: number;
  checkNumber: string | null;
  slipNumber: string | null;
}

export interface ProcessedLine {
  id: string;
  dayKey: string;
  strippedProgram: number;
  strippedNonProgram: number;
  savedUnits: number | null;
  materialTicketNumber: string | null;
  /** ADR-0123 author precedence: manual > import > mymrc. */
  source: string;
  closed: boolean;
}

export interface TerexLine {
  id: string;
  dayKey: string;
  unitsProcessed: number;
  runHours: string;
  startHours: string | null;
  endHours: string | null;
}

export interface LandfilledLine {
  id: string;
  dayKey: string;
  units: number;
  reason: string;
}

/** Every operational row in the window, already day-keyed. */
export interface WindowRows {
  inbound: InboundLine[];
  outbound: OutboundLine[];
  dropoffs: DropoffLine[];
  processed: ProcessedLine[];
  terex: TerexLine[];
  landfilled: LandfilledLine[];
  /** Null when the site has no throughput machine at all (Eugene). */
  terexMachineId: string | null;
}

/** One day's rows, sliced out of {@link WindowRows}. */
export interface DaySectionRows {
  dayKey: string;
  inbound: InboundLine[];
  /** Outbound COMMODITIES — `baled`/`shredded`. Disjoint from `renovation`. */
  outbound: OutboundLine[];
  /** The workbook's separate `Renovation` tab — `sub_category = 'renovation'`. */
  renovation: OutboundLine[];
  unpaidDropoffs: DropoffLine[];
  incentiveDropoffs: DropoffLine[];
  /** Illegal + the two iPad floor kinds. Read-only summary; never re-entered here. */
  otherDropoffs: DropoffLine[];
  processed: ProcessedLine | null;
  terex: TerexLine | null;
  landfilled: LandfilledLine[];
  terexApplicable: boolean;
}

// ─────────────────────────────────────────────────────────────────────────
// Totals (what a section header shows, and what the rollup folds)
// ─────────────────────────────────────────────────────────────────────────

export interface DaySectionTotals {
  dayKey: string;
  inbound: {
    lines: number;
    units: number;
    programUnits: number;
    nonProgramUnits: number;
    weightLbs: number;
    /** `inb trans charges` — the freight tab. */
    freightLines: number;
    /** `inb no trans charge` — the 93-row workhorse tab. */
    noFreightLines: number;
    /** Rows the office has not yet put through the verify gate. */
    awaitingVerification: number;
  };
  outbound: { lines: number; weightLbs: number };
  renovation: { lines: number; weightLbs: number; wholeUnits: number };
  processed: {
    recorded: boolean;
    strippedProgram: number;
    strippedNonProgram: number;
    savedUnits: number;
  };
  /** Derived from the inbound rows — the workbook's `NonProgram` tab (`NP`). */
  nonProgram: { lines: number; units: number };
  unpaidDropoff: { lines: number; units: number };
  incentiveDropoff: { lines: number; units: number };
  otherDropoff: { lines: number; units: number };
  terex: { recorded: boolean; applicable: boolean; unitsProcessed: number; runHours: number };
  landfilled: { lines: number; units: number };
  flags: Record<FlaggedSection, GapFlag>;
}

export interface MonthRollup {
  /** `YYYY-MM-DD` of the first day folded. */
  fromDayKey: string;
  /** `YYYY-MM-DD` of the last day folded. */
  toDayKey: string;
  days: number;
  /** Days on which at least one flagged section is `missing`. */
  daysWithGaps: number;
  inbound: DaySectionTotals['inbound'];
  outbound: DaySectionTotals['outbound'];
  renovation: DaySectionTotals['renovation'];
  processed: {
    daysRecorded: number;
    strippedProgram: number;
    strippedNonProgram: number;
    savedUnits: number;
  };
  nonProgram: DaySectionTotals['nonProgram'];
  unpaidDropoff: DaySectionTotals['unpaidDropoff'];
  incentiveDropoff: DaySectionTotals['incentiveDropoff'];
  otherDropoff: DaySectionTotals['otherDropoff'];
  terex: { daysRecorded: number; unitsProcessed: number; runHours: number };
  landfilled: DaySectionTotals['landfilled'];
}

// ─────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────

const NOT_VOIDED_LOAD = { status: { not: 'voided' as const } };

/**
 * Load every operational row for a Pacific-day window, inclusive of both ends.
 *
 * DAY-KEY DISCIPLINE (src/lib/time.ts) — the two shapes are NOT interchangeable
 * and this is the one function that has to know both:
 *
 *  - `inbound_loads.arrived_at` is a true INSTANT. The window is bounded by
 *    Pacific-midnight instants and each row is keyed with `pacificDayKeyUTC`.
 *    Bounding it with @db.Date keys instead would put every load arriving after
 *    5 PM Pacific on the following day.
 *  - every other table stores a `@db.Date` — UTC midnight of the Pacific day —
 *    so it is bounded and keyed with the day keys directly, never re-shifted
 *    through the Pacific zone (`time.ts:29-32`).
 */
export async function loadWindowRows(
  siteId: string,
  startKey: Date,
  endKey: Date,
  opts: { terexMachineId?: string | null } = {},
): Promise<WindowRows> {
  const inboundFrom = pacificMidnightInstantOfDayISO(dayISO(startKey));
  const inboundToExclusive = pacificMidnightInstantOfDayISO(
    dayISO(new Date(endKey.getTime() + 86_400_000)),
  );

  const [inbound, outbound, dropoffs, processed, terex, landfilled] = await Promise.all([
    prisma.inboundLoad.findMany({
      where: {
        site_id: siteId,
        ...NOT_VOIDED_LOAD,
        arrived_at: { gte: inboundFrom, lt: inboundToExclusive },
      },
      orderBy: { arrived_at: 'asc' },
      select: {
        id: true,
        arrived_at: true,
        load_source_type: true,
        status: true,
        total_units: true,
        program_unit_count: true,
        non_program_unit_count: true,
        weight_lbs: true,
        bol_number: true,
        dr3_number: true,
        external_mymrc_haul_id: true,
        slip_number: true,
        transport_charged: true,
        source: { select: { name: true } },
      },
    }),
    prisma.outboundMaterial.findMany({
      where: { site_id: siteId, ship_date: { gte: startKey, lte: endKey } },
      orderBy: { ship_date: 'asc' },
      select: {
        id: true,
        ship_date: true,
        commodity: true,
        sub_category: true,
        weight_lbs: true,
        whole_units: true,
        program_units: true,
        non_program_units: true,
        ticket_number: true,
      },
    }),
    prisma.consumerDropoff.findMany({
      where: { site_id: siteId, dropoff_date: { gte: startKey, lte: endKey } },
      orderBy: { dropoff_date: 'asc' },
      select: {
        id: true,
        dropoff_date: true,
        kind: true,
        person_name: true,
        units: true,
        check_number: true,
        slip_number: true,
      },
    }),
    prisma.processedUnitsDaily.findMany({
      where: { site_id: siteId, production_date: { gte: startKey, lte: endKey } },
      orderBy: { production_date: 'asc' },
      select: {
        id: true,
        production_date: true,
        stripped_program: true,
        stripped_non_program: true,
        saved_units: true,
        material_ticket_number: true,
        source: true,
        closed_at: true,
      },
    }),
    prisma.equipmentDailyThroughput.findMany({
      where: {
        site_id: siteId,
        voided_at: null,
        throughput_date: { gte: startKey, lte: endKey },
      },
      orderBy: { throughput_date: 'asc' },
      select: {
        id: true,
        throughput_date: true,
        units_processed: true,
        run_hours: true,
        start_hours: true,
        end_hours: true,
      },
    }),
    prisma.landfilledUnit.findMany({
      where: { site_id: siteId, disposal_date: { gte: startKey, lte: endKey } },
      orderBy: { disposal_date: 'asc' },
      select: { id: true, disposal_date: true, units: true, reason: true },
    }),
  ]);

  return {
    inbound: inbound.map((r) => ({
      id: r.id,
      dayKey: r.arrived_at ? dayISO(pacificDayKeyUTC(r.arrived_at)) : '',
      arrivedAt: r.arrived_at,
      loadSourceType: r.load_source_type,
      status: r.status,
      sourceName: r.source?.name ?? null,
      totalUnits: r.total_units ?? 0,
      programUnits: r.program_unit_count ?? 0,
      nonProgramUnits: r.non_program_unit_count ?? 0,
      weightLbs: r.weight_lbs,
      bolNumber: r.bol_number,
      dr3Number: r.dr3_number,
      haulNumber: r.external_mymrc_haul_id,
      slipNumber: r.slip_number,
      transportCharged: r.transport_charged,
    })),
    outbound: outbound.map((r) => ({
      id: r.id,
      dayKey: dayISO(r.ship_date),
      commodity: r.commodity,
      subCategory: r.sub_category,
      weightLbs: r.weight_lbs,
      wholeUnits: r.whole_units,
      programUnits: r.program_units,
      nonProgramUnits: r.non_program_units,
      ticketNumber: r.ticket_number,
    })),
    dropoffs: dropoffs.map((r) => ({
      id: r.id,
      dayKey: dayISO(r.dropoff_date),
      kind: r.kind,
      personName: r.person_name,
      units: r.units,
      checkNumber: r.check_number,
      slipNumber: r.slip_number,
    })),
    processed: processed.map((r) => ({
      id: r.id,
      dayKey: dayISO(r.production_date),
      strippedProgram: Number(r.stripped_program),
      strippedNonProgram: Number(r.stripped_non_program),
      savedUnits: r.saved_units === null ? null : Number(r.saved_units),
      materialTicketNumber: r.material_ticket_number,
      source: r.source,
      closed: r.closed_at !== null,
    })),
    terex: terex.map((r) => ({
      id: r.id,
      dayKey: dayISO(r.throughput_date),
      unitsProcessed: r.units_processed,
      runHours: r.run_hours.toString(),
      startHours: r.start_hours === null ? null : r.start_hours.toString(),
      endHours: r.end_hours === null ? null : r.end_hours.toString(),
    })),
    landfilled: landfilled.map((r) => ({
      id: r.id,
      dayKey: dayISO(r.disposal_date),
      units: r.units,
      reason: r.reason,
    })),
    terexMachineId: opts.terexMachineId ?? null,
  };
}

/** Every `YYYY-MM-DD` from `startKey` to `endKey`, inclusive. */
export function dayKeysBetween(startKey: Date, endKey: Date): string[] {
  const out: string[] = [];
  for (let t = startKey.getTime(); t <= endKey.getTime(); t += 86_400_000) {
    out.push(dayISO(new Date(t)));
  }
  return out;
}

/**
 * Slice the window's rows into one bucket per day. PURE — no DB, no clock, so
 * the day sections and the month rollup can be driven from the same fixture in
 * a test and cannot silently diverge.
 */
export function bucketRowsByDay(rows: WindowRows, dayKeys: readonly string[]): DaySectionRows[] {
  const terexApplicable = rows.terexMachineId !== null;
  const index = new Map<string, DaySectionRows>(
    dayKeys.map((dayKey) => [
      dayKey,
      {
        dayKey,
        inbound: [],
        outbound: [],
        renovation: [],
        unpaidDropoffs: [],
        incentiveDropoffs: [],
        otherDropoffs: [],
        processed: null,
        terex: null,
        landfilled: [],
        terexApplicable,
      },
    ]),
  );
  for (const r of rows.inbound) index.get(r.dayKey)?.inbound.push(r);
  for (const r of rows.outbound) {
    const day = index.get(r.dayKey);
    if (!day) continue;
    // Disjoint by construction: the workbook's `Commodities` and `Renovation`
    // tabs are two sub-categories of ONE Vision table, so a row lands in exactly
    // one bucket and the rollup cannot count it twice.
    if (r.subCategory === 'renovation') day.renovation.push(r);
    else day.outbound.push(r);
  }
  for (const r of rows.dropoffs) {
    const day = index.get(r.dayKey);
    if (!day) continue;
    if (r.kind === 'unpaid') day.unpaidDropoffs.push(r);
    else if (r.kind === 'incentive') day.incentiveDropoffs.push(r);
    else day.otherDropoffs.push(r);
  }
  for (const r of rows.processed) {
    const day = index.get(r.dayKey);
    if (day) day.processed = r;
  }
  for (const r of rows.terex) {
    const day = index.get(r.dayKey);
    if (day) day.terex = r;
  }
  for (const r of rows.landfilled) index.get(r.dayKey)?.landfilled.push(r);
  return dayKeys.map((k) => index.get(k) as DaySectionRows);
}

/** Statuses that have cleared the office verify gate (mirrors VERIFIED_INBOUND_STATUSES). */
const VERIFIED_STATUSES = new Set(['verified', 'submitted_to_mymrc', 'processed']);

/**
 * Reduce one day's rows to the numbers its section headers show.
 *
 * PURE. This is the only place a day's figures are computed, and the month
 * rollup folds these exact objects — so "the rollup equals the sum of the
 * sections" is true by construction rather than by coincidence, and a test can
 * falsify it by patching one day and watching the rollup move.
 */
export function summarizeDay(day: DaySectionRows): DaySectionTotals {
  const inbound = {
    lines: day.inbound.length,
    units: day.inbound.reduce((n, r) => n + r.totalUnits, 0),
    programUnits: day.inbound.reduce((n, r) => n + r.programUnits, 0),
    nonProgramUnits: day.inbound.reduce((n, r) => n + r.nonProgramUnits, 0),
    weightLbs: day.inbound.reduce((n, r) => n + (r.weightLbs ?? 0), 0),
    freightLines: day.inbound.filter((r) => r.transportCharged).length,
    noFreightLines: day.inbound.filter((r) => !r.transportCharged).length,
    awaitingVerification: day.inbound.filter((r) => !VERIFIED_STATUSES.has(r.status)).length,
  };
  const nonProgramLines = day.inbound.filter((r) => r.nonProgramUnits > 0);
  const totals: Omit<DaySectionTotals, 'flags'> = {
    dayKey: day.dayKey,
    inbound,
    outbound: {
      lines: day.outbound.length,
      weightLbs: day.outbound.reduce((n, r) => n + r.weightLbs, 0),
    },
    renovation: {
      lines: day.renovation.length,
      weightLbs: day.renovation.reduce((n, r) => n + r.weightLbs, 0),
      wholeUnits: day.renovation.reduce((n, r) => n + (r.wholeUnits ?? 0), 0),
    },
    processed: {
      recorded: day.processed !== null,
      strippedProgram: day.processed?.strippedProgram ?? 0,
      strippedNonProgram: day.processed?.strippedNonProgram ?? 0,
      savedUnits: day.processed?.savedUnits ?? 0,
    },
    nonProgram: {
      lines: nonProgramLines.length,
      units: nonProgramLines.reduce((n, r) => n + r.nonProgramUnits, 0),
    },
    unpaidDropoff: {
      lines: day.unpaidDropoffs.length,
      units: day.unpaidDropoffs.reduce((n, r) => n + r.units, 0),
    },
    incentiveDropoff: {
      lines: day.incentiveDropoffs.length,
      units: day.incentiveDropoffs.reduce((n, r) => n + r.units, 0),
    },
    otherDropoff: {
      lines: day.otherDropoffs.length,
      units: day.otherDropoffs.reduce((n, r) => n + r.units, 0),
    },
    terex: {
      recorded: day.terex !== null,
      applicable: day.terexApplicable,
      unitsProcessed: day.terex?.unitsProcessed ?? 0,
      runHours: day.terex ? Number(day.terex.runHours) : 0,
    },
    landfilled: {
      lines: day.landfilled.length,
      units: day.landfilled.reduce((n, r) => n + r.units, 0),
    },
  };
  return { ...totals, flags: gapFlags(totals) };
}

/**
 * Grade each flagged section.
 *
 * `missing` means NOTHING WAS RECORDED — never "the number is zero". A day on
 * which a channel genuinely had no activity still flags, and the manager clears
 * it by closing the day WITH AN EXCEPTION naming it. That is deliberate: silently
 * treating absence as zero is how a month's inbound goes under-fed and the floor
 * computes negative (ADR-0110), and it is the discipline ADR-0077 D4 already
 * states one row down.
 */
export function gapFlags(t: Omit<DaySectionTotals, 'flags'>): Record<FlaggedSection, GapFlag> {
  return {
    inbound: t.inbound.lines > 0 ? 'captured' : 'missing',
    outbound: t.outbound.lines > 0 ? 'captured' : 'missing',
    processed: t.processed.recorded ? 'captured' : 'missing',
    // G-7 — NonProgram runs 12-18 rows/month, which is near-DAILY, not the
    // "0 rows, essentially unused" the handoff assumed. It is flagged and it is
    // not collapsed.
    nonProgram: t.nonProgram.lines > 0 ? 'captured' : 'missing',
    // G-7 — unpaid drop-offs run 11-21 distinct rows/month. Same treatment.
    unpaidDropoff: t.unpaidDropoff.lines > 0 ? 'captured' : 'missing',
    // Eugene has no throughput machine, so the honest grade there is
    // `not_applicable` — a permanent warning on a correct site is a broken flag.
    terex: !t.terex.applicable ? 'not_applicable' : t.terex.recorded ? 'captured' : 'missing',
  };
}

/** True when any flagged section on this day reads `missing`. */
export function hasGaps(t: DaySectionTotals): boolean {
  return FLAGGED_SECTIONS.some((s) => t.flags[s] === 'missing');
}

/** The sections a manager still has open, for the close-with-exception prompt. */
export function missingSections(t: DaySectionTotals): FlaggedSection[] {
  return FLAGGED_SECTIONS.filter((s) => t.flags[s] === 'missing');
}

// ─────────────────────────────────────────────────────────────────────────
// The month rollup — a PURE FOLD over the day totals above
// ─────────────────────────────────────────────────────────────────────────

/**
 * Month-to-date rollup. This is what replaces the workbook's `Summary` and
 * `Trans Summary` tabs.
 *
 * It takes the SAME `DaySectionTotals` objects the day sections render and adds
 * them up. There is deliberately no query in here: the moment this function
 * could reach the database it would become a second computation of numbers the
 * sections already computed, and the two would eventually disagree — which is
 * exactly the failure ADR-0110 records. A test proves the property by patching
 * one day's totals and asserting the rollup moves by the same amount.
 */
export function rollupFromDays(days: readonly DaySectionTotals[]): MonthRollup {
  const add = (pick: (d: DaySectionTotals) => number): number =>
    days.reduce((n, d) => n + pick(d), 0);

  // Decimal for the money-adjacent stripped figures: `stripped_program` is the
  // basis MRC is invoiced on and it is a Decimal(7,1) in the database. Folding
  // 31 halves in binary floating point drifts; folding them as Decimal does not.
  const strippedProgram = days.reduce((n, d) => n.plus(d.processed.strippedProgram), new D(0));
  const strippedNonProgram = days.reduce(
    (n, d) => n.plus(d.processed.strippedNonProgram),
    new D(0),
  );
  const savedUnits = days.reduce((n, d) => n.plus(d.processed.savedUnits), new D(0));
  const runHours = days.reduce((n, d) => n.plus(d.terex.runHours), new D(0));

  return {
    fromDayKey: days[0]?.dayKey ?? '',
    toDayKey: days[days.length - 1]?.dayKey ?? '',
    days: days.length,
    daysWithGaps: days.filter(hasGaps).length,
    inbound: {
      lines: add((d) => d.inbound.lines),
      units: add((d) => d.inbound.units),
      programUnits: add((d) => d.inbound.programUnits),
      nonProgramUnits: add((d) => d.inbound.nonProgramUnits),
      weightLbs: add((d) => d.inbound.weightLbs),
      freightLines: add((d) => d.inbound.freightLines),
      noFreightLines: add((d) => d.inbound.noFreightLines),
      awaitingVerification: add((d) => d.inbound.awaitingVerification),
    },
    outbound: {
      lines: add((d) => d.outbound.lines),
      weightLbs: add((d) => d.outbound.weightLbs),
    },
    renovation: {
      lines: add((d) => d.renovation.lines),
      weightLbs: add((d) => d.renovation.weightLbs),
      wholeUnits: add((d) => d.renovation.wholeUnits),
    },
    processed: {
      daysRecorded: days.filter((d) => d.processed.recorded).length,
      strippedProgram: strippedProgram.toNumber(),
      strippedNonProgram: strippedNonProgram.toNumber(),
      savedUnits: savedUnits.toNumber(),
    },
    nonProgram: {
      lines: add((d) => d.nonProgram.lines),
      units: add((d) => d.nonProgram.units),
    },
    unpaidDropoff: {
      lines: add((d) => d.unpaidDropoff.lines),
      units: add((d) => d.unpaidDropoff.units),
    },
    incentiveDropoff: {
      lines: add((d) => d.incentiveDropoff.lines),
      units: add((d) => d.incentiveDropoff.units),
    },
    otherDropoff: {
      lines: add((d) => d.otherDropoff.lines),
      units: add((d) => d.otherDropoff.units),
    },
    terex: {
      daysRecorded: days.filter((d) => d.terex.recorded).length,
      unitsProcessed: add((d) => d.terex.unitsProcessed),
      runHours: runHours.toNumber(),
    },
    landfilled: {
      lines: add((d) => d.landfilled.lines),
      units: add((d) => d.landfilled.units),
    },
  };
}

/** Parse a `YYYY-MM-DD` into its @db.Date day key. Re-exported for callers. */
export const dayKeyOf = dayKeyUTCFromISO;
