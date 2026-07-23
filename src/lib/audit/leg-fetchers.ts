// ════════════════════════════════════════════════════════════════════════
// ADR-0039 — DB-fetch layer (INTEGRATED against merged ADR-0037/0038 models)
// ════════════════════════════════════════════════════════════════════════
//
// Maps the sibling ADR-0037 (loads/inventory) and ADR-0038 (MyMRC mirror)
// Prisma models onto the plain `src/lib/audit/types.ts` interfaces the pure
// comparators consume, and assembles the `RunChecksForWindow` callback the sweep
// (src/lib/audit/sweep.ts) accepts via injection. The comparators never touch a
// Prisma model — only these mapped rows.
//
// Reconciliation notes (real merged shapes forced these adjustments vs the
// pre-merge blueprint):
//   - `inbound_loads` has NO scalar record-source and NO submitted/verified
//     timestamp columns → provenance is `manual` and the "entered into MyMRC"
//     instant is derived from the matched haul mirror (first_seen_at).
//   - `processed_units_daily` stores STRIPPED program/non-program (Decimal),
//     not `units_processed`; total is derived. Its MyMRC entry instant comes
//     from the matched processed mirror's `entry_date`.
//   - `outbound_materials` has NO `eod_closed_at`/submitted columns → the EOD
//     close clock uses `locked_at`; the MyMRC entry instant comes from the
//     matched outbound mirror's `entry_date`.
//   - `mymrc_processed_mirror` carries NO program/non-program split → C2's
//     split sub-checks degrade to the total-units comparison (bothPresent guard).
//   - `mymrc_outbound_mirror` uses `shipment_date` (not ship_date), has NO
//     ticket/units columns → the Material # join key is `external_materials_id`.
//   - C5/C6 internal-invariant inputs are DERIVED per-day from the operational
//     rows anchored at the running balance (reuses `computeRunningBalance`).

import type { PrismaClient } from '@prisma/client';
import {
  computeRunningBalance,
  resolveAnchorPair,
  anchorFlowBounds,
  type PoolPair,
} from '@/lib/inventory/running-balance';
import { aggregateSiteRates, resolveRateThresholds } from '@/lib/rates';
import {
  c1Inbound,
  c2Processed,
  c3Outbound,
  c4BillingBasis,
  c5Conservation,
  c6InventoryContinuity,
  c7Deadline,
  r1RecyclingRate,
  r2RecoveryRate,
  m1MissingClose,
  m2MissingSnapshot,
  m3CommodityPaymentAging,
  type M1DayRow,
} from './comparators';
import { resolveCheckConfigs } from './config';
import { dayISO, dayKeyUTCFromISO } from '@/lib/time';
import { resolveLegLiveness, type BootstrapLeg } from './bootstrap-gate';
import { log } from '@/lib/observability/logger';
import type {
  AuditWindow,
  BillingLegRow,
  CheckCode,
  ConservationRow,
  Finding,
  InboundLegRow,
  InventoryDayRow,
  LandfilledLegRow,
  MirrorHaulRow,
  MirrorOutboundRow,
  MirrorProcessedRow,
  OutboundLegRow,
  ProcessedLegRow,
} from './types';

const toISO = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;
const toInstantISO = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const rangeDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
/** Coerce a Prisma.Decimal | number | string | null into a plain number. */
const toNum = (v: unknown): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));
const toNumOrNull = (v: unknown): number | null =>
  v == null ? null : typeof v === 'number' ? v : Number(v);

// Inbound statuses that have cleared the manager verify gate (mirrors ADR-0037
// running-balance.VERIFIED_INBOUND_STATUSES; kept local to avoid the prisma
// import pulled in by that module in this always-compiled fetcher).
const VERIFIED_STATUSES = ['verified', 'submitted_to_mymrc', 'processed'] as const;

// ── Leg fetchers ────────────────────────────────────────────────────────

async function fetchInbound(db: PrismaClient, w: AuditWindow): Promise<InboundLegRow[]> {
  const rows = await db.inboundLoad.findMany({
    where: {
      site_id: w.siteId,
      status: { in: [...VERIFIED_STATUSES] },
      arrived_at: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      retrac_id: true,
      external_mymrc_haul_id: true,
      arrived_at: true,
      total_units: true,
      program_unit_count: true,
      non_program_unit_count: true,
      slip_number: true,
      transport_charged: true,
      // `inbound_loads` has no scalar RecordSource; the site name is the source relation.
      source: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    retracId: r.retrac_id ?? null,
    externalHaulId: r.external_mymrc_haul_id ?? null,
    businessDateISO: toISO(r.arrived_at) ?? w.startISO,
    totalUnits: r.total_units ?? 0,
    programUnits: r.program_unit_count ?? null,
    nonProgramUnits: r.non_program_unit_count ?? null,
    slipNumber: r.slip_number ?? null,
    transportCharged: r.transport_charged ?? false,
    source: 'manual', // operator-entered at the dock; MyMRC feeds expected_loads, not inbound_loads
    sourceSiteName: r.source?.name ?? null,
    verifiedAtISO: null, // no verified_at column; the verify transition lives in audit_log (out of scope for C1/C7)
    mymrcSubmittedAtISO: null, // enriched below from the matched haul mirror
  }));
}

async function fetchHaulMirror(db: PrismaClient, w: AuditWindow): Promise<MirrorHaulRow[]> {
  const rows = await db.mymrcHaulsMirror.findMany({
    where: {
      site_id: w.siteId,
      docking_appointment_at: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      external_haul_id: true,
      retrac_id: true,
      docking_appointment_at: true,
      units: true,
      weight_lbs: true,
      status: true,
      first_seen_at: true,
    },
  });
  return rows.map((r) => ({
    // external_haul_id is null until the detail pass; fall back to the stable
    // Salesforce record id so the C1 map key is always present + unique.
    externalHaulId: r.external_haul_id ?? r.id,
    retracId: r.retrac_id ?? null,
    businessDateISO: toISO(r.docking_appointment_at) ?? w.startISO,
    units: r.units ?? null,
    weightLbs: toNumOrNull(r.weight_lbs),
    status: r.status ?? '',
    entryDateISO: toISO(r.first_seen_at),
    firstSeenAtISO: toInstantISO(r.first_seen_at),
  }));
}

async function fetchProcessed(db: PrismaClient, w: AuditWindow): Promise<ProcessedLegRow[]> {
  const rows = await db.processedUnitsDaily.findMany({
    where: {
      site_id: w.siteId,
      production_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      production_date: true,
      stripped_program: true,
      stripped_non_program: true,
      source: true,
      closed_at: true,
    },
  });
  return rows.map((r) => {
    const program = toNum(r.stripped_program);
    const nonProgram = toNum(r.stripped_non_program);
    return {
      id: r.id,
      productionDateISO: toISO(r.production_date) ?? w.startISO,
      unitsProcessed: program + nonProgram, // total is derived (never stored)
      programUnitsProcessed: program,
      nonProgramUnitsProcessed: nonProgram,
      source: r.source, // RecordSource: 'manual' | 'mymrc' | 'import'
      closedAtISO: toInstantISO(r.closed_at),
      mymrcSubmittedAtISO: null, // enriched below from the matched processed mirror
    };
  });
}

async function fetchProcessedMirror(
  db: PrismaClient,
  w: AuditWindow,
): Promise<MirrorProcessedRow[]> {
  const rows = await db.mymrcProcessedMirror.findMany({
    where: {
      site_id: w.siteId,
      processed_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      external_materials_id: true,
      processed_date: true,
      units: true,
      entry_date: true,
    },
  });
  return rows.map((r) => ({
    externalMaterialsId: r.external_materials_id ?? r.id,
    processedDateISO: toISO(r.processed_date) ?? w.startISO,
    units: r.units ?? null,
    // The processed mirror carries only the program-unit total (Number_of_Program_Units__c),
    // not a program/non-program split → C2's split sub-checks skip via bothPresent().
    programUnits: null,
    nonProgramUnits: null,
    entryDateISO: toISO(r.entry_date),
  }));
}

async function fetchOutbound(db: PrismaClient, w: AuditWindow): Promise<OutboundLegRow[]> {
  const rows = await db.outboundMaterial.findMany({
    where: {
      site_id: w.siteId,
      ship_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      ship_date: true,
      commodity: true,
      sub_category: true,
      weight_lbs: true,
      whole_units: true,
      bale_count: true,
      ticket_number: true,
      retrac_id: true,
      buyer: true,
      source: true,
      locked_at: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    shipDateISO: toISO(r.ship_date) ?? w.startISO,
    commodity: r.commodity as OutboundLegRow['commodity'],
    subCategory: r.sub_category as OutboundLegRow['subCategory'],
    weightLbs: r.weight_lbs ?? null,
    wholeUnits: r.whole_units ?? null,
    baleCount: r.bale_count ?? null,
    ticketNumber: r.ticket_number ?? null,
    retracId: r.retrac_id ?? null,
    buyer: r.buyer ?? null,
    source: r.source,
    eodClosedAtISO: toInstantISO(r.locked_at), // EOD close = the day-lock instant
    mymrcSubmittedAtISO: null, // enriched below from the matched outbound mirror
  }));
}

async function fetchLandfilled(db: PrismaClient, w: AuditWindow): Promise<LandfilledLegRow[]> {
  const rows = await db.landfilledUnit.findMany({
    where: {
      site_id: w.siteId,
      disposal_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      disposal_date: true,
      units: true,
      slip_number: true,
      reason: true,
      source: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    disposalDateISO: toISO(r.disposal_date) ?? w.startISO,
    units: r.units ?? 0,
    slipNumber: r.slip_number ?? null,
    reason: r.reason ?? 'other',
    source: r.source,
  }));
}

async function fetchOutboundMirror(db: PrismaClient, w: AuditWindow): Promise<MirrorOutboundRow[]> {
  const rows = await db.mymrcOutboundMirror.findMany({
    where: {
      site_id: w.siteId,
      shipment_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: {
      id: true,
      external_materials_id: true,
      shipment_date: true,
      entry_date: true,
      weight_lbs: true,
      vendor: true,
    },
  });
  return rows.map((r) => ({
    externalMaterialsId: r.external_materials_id ?? r.id,
    shipDateISO: toISO(r.shipment_date) ?? w.startISO,
    entryDateISO: toISO(r.entry_date),
    weightLbs: toNumOrNull(r.weight_lbs),
    units: null, // the outbound mirror is weight-based; no unit column
    // The portal Material # (external_materials_id) IS the ticket the Vision
    // outbound row carries in `ticket_number` → C3 joins on it.
    ticketNumber: r.external_materials_id ?? null,
    materialType: null, // no material_type column (would come from payload; unused by C3)
    vendor: r.vendor ?? null,
  }));
}

// C4 billing leg: P2 invoice when it exists, else the workbook Summary staging.
// P2 has not shipped, so a live sweep has no billing leg → C4 emits a
// missing-billing finding (correct: nothing to reconcile against yet). Retro
// windows get their billing leg from the workbook Summary in the import path.
function fetchBilling(): Promise<BillingLegRow | null> {
  return Promise.resolve(null);
}

// ── C5 / C6 internal-invariant inputs (derived from operational rows) ─────
//
// Both anchor at the running balance's on-hand position at window start and roll
// forward day-by-day using `computeRunningBalance` — the ONE shared inventory
// computation (ADR-0037 D6) — so these never fork a second, divergent formula.

/** Per-day pool-split flows, keyed by ISO day. */
interface DayFlows {
  inbound: PoolPair;
  dropoffProgram: number; // CIP consumer drop-offs land in the PROGRAM pool
  stripped: PoolPair;
  renovationSold: PoolPair; // outbound sub_category = renovation whole units
  landfilled: PoolPair;
  physicalSnapshot: number | null;
}

function emptyFlows(): DayFlows {
  return {
    inbound: { program: 0, nonProgram: 0 },
    dropoffProgram: 0,
    stripped: { program: 0, nonProgram: 0 },
    renovationSold: { program: 0, nonProgram: 0 },
    landfilled: { program: 0, nonProgram: 0 },
    physicalSnapshot: null,
  };
}

/**
 * Fetch and bucket every pool-split flow in the window by ISO day. Uses the same
 * tables + verify-gate semantics as `running-balance.onHand`.
 */
async function fetchDayFlows(db: PrismaClient, w: AuditWindow): Promise<Map<string, DayFlows>> {
  const range = { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) };
  const [inbound, dropoffs, processed, renovation, landfilled, snapshots] = await Promise.all([
    db.inboundLoad.findMany({
      where: { site_id: w.siteId, status: { in: [...VERIFIED_STATUSES] }, arrived_at: range },
      select: {
        arrived_at: true,
        total_units: true,
        program_unit_count: true,
        non_program_unit_count: true,
      },
    }),
    db.consumerDropoff.findMany({
      where: { site_id: w.siteId, dropoff_date: range },
      select: { dropoff_date: true, units: true },
    }),
    db.processedUnitsDaily.findMany({
      where: { site_id: w.siteId, production_date: range },
      select: { production_date: true, stripped_program: true, stripped_non_program: true },
    }),
    db.outboundMaterial.findMany({
      where: { site_id: w.siteId, sub_category: 'renovation', ship_date: range },
      select: { ship_date: true, program_units: true, non_program_units: true, whole_units: true },
    }),
    db.landfilledUnit.findMany({
      where: { site_id: w.siteId, disposal_date: range },
      select: { disposal_date: true, program_units: true, non_program_units: true, units: true },
    }),
    db.siteInventorySnapshot.findMany({
      where: { site_id: w.siteId, snapshot_kind: 'physical', snapshot_at: range },
      select: {
        snapshot_at: true,
        units_indoor: true,
        units_total: true,
        units_in_processing: true,
      },
    }),
  ]);

  const days = new Map<string, DayFlows>();
  const at = (iso: string | null): DayFlows => {
    const key = iso ?? w.startISO;
    let f = days.get(key);
    if (!f) {
      f = emptyFlows();
      days.set(key, f);
    }
    return f;
  };

  for (const r of inbound) {
    const f = at(toISO(r.arrived_at));
    const program = r.program_unit_count ?? r.total_units ?? 0;
    const nonProgram = r.non_program_unit_count ?? 0;
    f.inbound = {
      program: toNum(f.inbound.program) + program,
      nonProgram: toNum(f.inbound.nonProgram) + nonProgram,
    };
  }
  for (const r of dropoffs) {
    at(toISO(r.dropoff_date)).dropoffProgram += r.units ?? 0;
  }
  for (const r of processed) {
    const f = at(toISO(r.production_date));
    f.stripped = {
      program: toNum(f.stripped.program) + toNum(r.stripped_program),
      nonProgram: toNum(f.stripped.nonProgram) + toNum(r.stripped_non_program),
    };
  }
  for (const r of renovation) {
    const f = at(toISO(r.ship_date));
    // whole_units split into program/non_program (validated == whole_units).
    f.renovationSold = {
      program: toNum(f.renovationSold.program) + (r.program_units ?? 0),
      nonProgram: toNum(f.renovationSold.nonProgram) + (r.non_program_units ?? 0),
    };
  }
  for (const r of landfilled) {
    const f = at(toISO(r.disposal_date));
    f.landfilled = {
      program: toNum(f.landfilled.program) + (r.program_units ?? 0),
      nonProgram: toNum(f.landfilled.nonProgram) + (r.non_program_units ?? 0),
    };
  }
  for (const r of snapshots) {
    const total = (r.units_indoor ?? 0) + (r.units_total ?? 0) + r.units_in_processing;
    at(toISO(r.snapshot_at)).physicalSnapshot = total;
  }

  return days;
}

/**
 * The pool-aware on-hand balance strictly BEFORE the window (the roll anchor).
 * Mirrors `running-balance.onHand`, bounded to `< windowStart`, over the injected
 * db (so it is testable with a fake client). The anchor's pool split is resolved by
 * the SHARED `resolveAnchorPair` (D-4) — a `measured` physical count uses its entered
 * program/non-program split; otherwise the whole count is attributed to the program
 * pool. This selects the pool columns so onHand and the audit can never disagree on a
 * measured anchor (which previously produced spurious C6 `physical_reconcile` findings).
 */
async function startBalance(db: PrismaClient, w: AuditWindow): Promise<PoolPair> {
  const before = rangeDate(w.startISO);
  const anchor = await db.siteInventorySnapshot.findFirst({
    where: { site_id: w.siteId, snapshot_kind: 'physical', snapshot_at: { lt: before } },
    orderBy: { snapshot_at: 'desc' },
    select: {
      snapshot_at: true,
      units_indoor: true,
      units_total: true,
      units_in_processing: true,
      program_units: true,
      non_program_units: true,
      pool_attribution: true,
    },
  });
  const { pair: anchorPair } = resolveAnchorPair(anchor);
  // D-3: Pacific-calendar-consistent anchor bounds (shared with onHand). `@db.Date`
  // outflow columns exclude the anchor's own Pacific day (`gt dateSince`); the
  // `arrived_at` instant excludes it via Pacific midnight of the following day
  // (`gte inboundSince`). Upper bound stays the audit window start (`lt before`).
  const { dateSince, inboundSince } = anchorFlowBounds(anchor ? anchor.snapshot_at : null);
  const dateFlowWindow = { gt: dateSince, lt: before };
  const inboundFlowWindow = { gte: inboundSince, lt: before };

  const [inbound, dropoffs, stripped, renovation, landfilled] = await Promise.all([
    db.inboundLoad.aggregate({
      _sum: { program_unit_count: true, non_program_unit_count: true },
      where: {
        site_id: w.siteId,
        status: { in: [...VERIFIED_STATUSES] },
        arrived_at: inboundFlowWindow,
      },
    }),
    db.consumerDropoff.aggregate({
      _sum: { units: true },
      where: { site_id: w.siteId, dropoff_date: dateFlowWindow },
    }),
    db.processedUnitsDaily.aggregate({
      _sum: { stripped_program: true, stripped_non_program: true },
      where: { site_id: w.siteId, production_date: dateFlowWindow },
    }),
    db.outboundMaterial.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: w.siteId, sub_category: 'renovation', ship_date: dateFlowWindow },
    }),
    db.landfilledUnit.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: w.siteId, disposal_date: dateFlowWindow },
    }),
  ]);

  const bal = computeRunningBalance({
    anchor: anchorPair,
    verifiedInbound: {
      program: toNum(inbound._sum.program_unit_count),
      nonProgram: toNum(inbound._sum.non_program_unit_count),
    },
    dropoffUnits: toNum(dropoffs._sum.units),
    stripped: {
      program: toNum(stripped._sum.stripped_program),
      nonProgram: toNum(stripped._sum.stripped_non_program),
    },
    wholeUnitsSold: {
      program: toNum(renovation._sum.program_units),
      nonProgram: toNum(renovation._sum.non_program_units),
    },
    landfilled: {
      program: toNum(landfilled._sum.program_units),
      nonProgram: toNum(landfilled._sum.non_program_units),
    },
  });
  return { program: bal.program, nonProgram: bal.nonProgram };
}

/**
 * PURE roll: given the pre-window balance and per-day flows, produce one
 * `InventoryDayRow` per day. Each day's End is `computeRunningBalance` with the
 * prior End as the anchor — so C6's own `Start + Inbound − Stripped −
 * WholeUnitsSold − Landfilled` reproduces it exactly and live data is
 * continuity-clean by construction (only physical reconcile can fire). Exported
 * for the cross-check test tying the daily roll to the shared computation.
 */
export function rollInventoryDays(
  start: PoolPair,
  days: ReadonlyMap<string, DayFlows>,
): InventoryDayRow[] {
  const out: InventoryDayRow[] = [];
  let prev = { program: toNum(start.program), nonProgram: toNum(start.nonProgram) };
  for (const dateISO of [...days.keys()].sort()) {
    const f = days.get(dateISO)!;
    const inboundProgram = toNum(f.inbound.program) + f.dropoffProgram;
    const inboundNonProgram = toNum(f.inbound.nonProgram);
    const end = computeRunningBalance({
      anchor: { program: prev.program, nonProgram: prev.nonProgram },
      verifiedInbound: {
        program: toNum(f.inbound.program),
        nonProgram: toNum(f.inbound.nonProgram),
      },
      dropoffUnits: f.dropoffProgram,
      stripped: f.stripped,
      wholeUnitsSold: f.renovationSold,
      landfilled: f.landfilled,
    });
    out.push({
      dateISO,
      recordedStart: prev.program,
      inbound: inboundProgram,
      stripped: toNum(f.stripped.program),
      wholeUnitsSold: toNum(f.renovationSold.program),
      landfilled: toNum(f.landfilled.program),
      recordedEnd: end.program.toNumber(),
      npRecordedStart: prev.nonProgram,
      npInbound: inboundNonProgram,
      npStripped: toNum(f.stripped.nonProgram),
      npSold: toNum(f.renovationSold.nonProgram),
      npLandfilled: toNum(f.landfilled.nonProgram),
      npRecordedEnd: end.nonProgram.toNumber(),
      physicalSnapshot: f.physicalSnapshot,
    });
    prev = { program: end.program.toNumber(), nonProgram: end.nonProgram.toNumber() };
  }
  return out;
}

/** The pool-aware day-by-day inventory ledger for a window (reused by the Workbench). */
export async function buildInventoryDays(
  db: PrismaClient,
  w: AuditWindow,
): Promise<InventoryDayRow[]> {
  const [start, days] = await Promise.all([startBalance(db, w), fetchDayFlows(db, w)]);
  return rollInventoryDays(start, days);
}

/**
 * PURE roll for C5: cumulative program/non-program availability per day. The
 * starting floor is folded into the first day's `inbound*` term so processing
 * against existing inventory is legal; `prior processed` and `renovation
 * outflow` accumulate. Exported for direct testing.
 */
export function rollConservationRows(
  start: PoolPair,
  days: ReadonlyMap<string, DayFlows>,
): ConservationRow[] {
  const out: ConservationRow[] = [];
  let cumInboundP = toNum(start.program);
  let cumInboundNP = toNum(start.nonProgram);
  let cumRenovP = 0;
  let cumRenovNP = 0;
  let priorProcP = 0;
  let priorProcNP = 0;
  for (const dateISO of [...days.keys()].sort()) {
    const f = days.get(dateISO)!;
    cumInboundP += toNum(f.inbound.program) + f.dropoffProgram;
    cumInboundNP += toNum(f.inbound.nonProgram);
    cumRenovP += toNum(f.renovationSold.program);
    cumRenovNP += toNum(f.renovationSold.nonProgram);
    out.push({
      dateISO,
      inboundProgram: cumInboundP,
      priorProcessedProgram: priorProcP,
      programRenovationOutflow: cumRenovP,
      programProcessed: toNum(f.stripped.program),
      inboundNonProgram: cumInboundNP,
      priorProcessedNonProgram: priorProcNP,
      nonProgramRenovationOutflow: cumRenovNP,
      nonProgramProcessed: toNum(f.stripped.nonProgram),
    });
    priorProcP += toNum(f.stripped.program);
    priorProcNP += toNum(f.stripped.nonProgram);
  }
  return out;
}

async function buildConservationRows(db: PrismaClient, w: AuditWindow): Promise<ConservationRow[]> {
  const [start, days] = await Promise.all([startBalance(db, w), fetchDayFlows(db, w)]);
  return rollConservationRows(start, days);
}

// ── Cross-leg enrichment: derive each Vision row's MyMRC entry instant ────
//
// No Vision operational table stores a "submitted to MyMRC" timestamp. The
// mirror IS the record of when MyMRC received a row, so C7's lateness clock reads
// the matched mirror's entry instant. A Vision row with no mirror counterpart
// keeps a null instant → C7 correctly treats it as overdue once its clock lapses.

function enrichInboundSubmission(inbound: InboundLegRow[], mirror: readonly MirrorHaulRow[]): void {
  const byHaul = new Map<string, MirrorHaulRow>();
  const byRetrac = new Map<string, MirrorHaulRow>();
  for (const m of mirror) {
    byHaul.set(m.externalHaulId, m);
    if (m.retracId) byRetrac.set(m.retracId, m);
  }
  for (const row of inbound) {
    const m =
      (row.externalHaulId ? byHaul.get(row.externalHaulId) : undefined) ??
      (row.retracId ? byRetrac.get(row.retracId) : undefined);
    if (m) row.mymrcSubmittedAtISO = m.firstSeenAtISO;
  }
}

function enrichProcessedSubmission(
  processed: ProcessedLegRow[],
  mirror: readonly MirrorProcessedRow[],
): void {
  const byDay = new Map<string, MirrorProcessedRow>();
  for (const m of mirror) byDay.set(m.processedDateISO, m);
  for (const row of processed) {
    const m = byDay.get(row.productionDateISO);
    if (m) row.mymrcSubmittedAtISO = m.entryDateISO;
  }
}

function enrichOutboundSubmission(
  outbound: OutboundLegRow[],
  mirror: readonly MirrorOutboundRow[],
): void {
  const byTicket = new Map<string, MirrorOutboundRow>();
  for (const m of mirror) if (m.ticketNumber) byTicket.set(m.ticketNumber, m);
  for (const row of outbound) {
    const m = row.ticketNumber ? byTicket.get(row.ticketNumber) : undefined;
    if (m) row.mymrcSubmittedAtISO = m.entryDateISO;
  }
}

// ── ADR-0043 (P3) rate + missing-record inputs ───────────────────────────
//
// R1/R2 rate over a rolling ~9-month window (the CA reconciliation window; per
// R1 config `rate_window_days`), DISTINCT from the sweep's trailing window. M1
// reuses the sweep window (recent-day grace); M2 reads the latest physical
// snapshot as of the run day.

function shiftDaysISO(iso: string, deltaDays: number): string {
  const d = dayKeyUTCFromISO(iso);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dayISO(d);
}

/** Consumer-drop-off business days in a window (an inbound-activity signal for M1). */
async function fetchDropoffDays(db: PrismaClient, w: AuditWindow): Promise<Set<string>> {
  const rows = await db.consumerDropoff.findMany({
    where: {
      site_id: w.siteId,
      dropoff_date: { gte: rangeDate(w.startISO), lt: rangeDate(w.endISO) },
    },
    select: { dropoff_date: true },
  });
  const days = new Set<string>();
  for (const r of rows) {
    const iso = toISO(r.dropoff_date);
    if (iso) days.add(iso);
  }
  return days;
}

/** The latest physical snapshot day as of the run (M2), or null. */
async function fetchLastPhysicalSnapshotISO(
  db: PrismaClient,
  w: AuditWindow,
): Promise<string | null> {
  const asOfISO = w.asOfISO ?? w.endISO;
  const snap = await db.siteInventorySnapshot.findFirst({
    where: {
      site_id: w.siteId,
      snapshot_kind: 'physical',
      snapshot_at: { lt: rangeDate(shiftDaysISO(asOfISO, 1)) },
    },
    orderBy: { snapshot_at: 'desc' },
    select: { snapshot_at: true },
  });
  return snap ? toISO(snap.snapshot_at) : null;
}

/** ADR-0052 M3 — every non-paid outbound load with its (implicit) payment
 * state. FULL history, not window-bounded: payment aging outlives any sweep
 * window, and the open set stays small once the owner works it. */
async function fetchM3PaymentRows(
  db: PrismaClient,
  w: AuditWindow,
): Promise<import('./comparators').M3PaymentRow[]> {
  const loads = await db.outboundMaterial.findMany({
    where: { site_id: w.siteId, OR: [{ payment: null }, { payment: { status: { not: 'paid' } } }] },
    select: {
      id: true,
      buyer: true,
      ship_date: true,
      ticket_number: true,
      payment: { select: { status: true, invoiced_at: true } },
    },
  });
  return loads.map((l) => ({
    loadId: l.id,
    buyer: l.buyer,
    shipDateISO: toISO(l.ship_date) ?? l.ship_date.toISOString().slice(0, 10),
    status: l.payment?.status ?? 'awaiting_invoice',
    invoicedAtISO: l.payment?.invoiced_at ? toISO(l.payment.invoiced_at) : null,
    ticketNumber: l.ticket_number,
  }));
}

/** Build the M1 activity-day rows from inbound loads + drop-offs vs closes. */
function buildM1Days(
  inbound: readonly InboundLegRow[],
  dropoffDays: ReadonlySet<string>,
  processed: readonly ProcessedLegRow[],
): M1DayRow[] {
  const activity = new Set<string>(dropoffDays);
  for (const r of inbound) activity.add(r.businessDateISO);
  const closes = new Set(processed.map((p) => p.productionDateISO));
  return [...activity]
    .sort()
    .map((dateISO) => ({
      dateISO,
      hadInboundActivity: true,
      hasProcessedRow: closes.has(dateISO),
    }));
}

// ── Assemble the per-window comparator runner the sweep injects ──────────

export function buildRunChecksForWindow(db: PrismaClient) {
  return async (
    window: AuditWindow,
  ): Promise<{
    checkCodes: CheckCode[];
    findings: Finding[];
    suppressedBootstrap: Record<string, number>;
  }> => {
    const configRows = await db.auditCheckConfig.findMany({
      where: { OR: [{ site_id: null }, { site_id: window.siteId }] },
    });
    const configs = resolveCheckConfigs(window.siteId, configRows);
    const holidays = (
      await db.siteHoliday.findMany({
        where: { site_id: window.siteId },
        select: { holiday_date: true },
      })
    ).map((h) => h.holiday_date);

    // ADR-0043 — the site jurisdiction picks the R1/R2 floor; null → skip R checks.
    const site = await db.site.findUnique({
      where: { id: window.siteId },
      select: { jurisdiction: true },
    });
    const jurisdiction = site?.jurisdiction ?? null;

    // R1/R2 run over a rolling ~9-month rate window (per R1 config), NOT the
    // sweep's trailing window. asOf anchors the window end.
    const asOfISO = window.asOfISO ?? window.endISO;
    const r1Config = configs.get('r1_recycling_rate');
    const rateWindowDays = (() => {
      const v = r1Config?.params['rate_window_days'];
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 273;
    })();
    const rateWindow: AuditWindow = {
      siteId: window.siteId,
      startISO: shiftDaysISO(asOfISO, -rateWindowDays),
      endISO: asOfISO,
      ...(window.asOfISO ? { asOfISO: window.asOfISO } : {}),
    };

    const [
      inbound,
      haulMirror,
      processed,
      processedMirror,
      outbound,
      landfilled,
      outboundMirror,
      billing,
      conservation,
      inventoryDays,
    ] = await Promise.all([
      fetchInbound(db, window),
      fetchHaulMirror(db, window),
      fetchProcessed(db, window),
      fetchProcessedMirror(db, window),
      fetchOutbound(db, window),
      fetchLandfilled(db, window),
      fetchOutboundMirror(db, window),
      fetchBilling(),
      buildConservationRows(db, window),
      buildInventoryDays(db, window),
    ]);

    // ADR-0043 inputs (rate window + missing-record signals).
    const [rateInputs, dropoffDays, lastPhysicalSnapshotISO, m3PaymentRows] = await Promise.all([
      aggregateSiteRates(db, rateWindow.siteId, rateWindow.startISO, rateWindow.endISO),
      fetchDropoffDays(db, window),
      fetchLastPhysicalSnapshotISO(db, window),
      fetchM3PaymentRows(db, window),
    ]);
    const m1Days = buildM1Days(inbound, dropoffDays, processed);

    // ADR-0043 D4 — rate computations log window + components at debug.
    log.debug(
      {
        siteId: window.siteId,
        rateWindowStartISO: rateWindow.startISO,
        rateWindowEndISO: rateWindow.endISO,
        recycling: rateInputs.recycling,
        recovery: rateInputs.recovery,
      },
      '[audit-rates] rate window computed',
    );

    // Derive the C7 lateness clocks from the mirror (no Vision-side submit column).
    enrichInboundSubmission(inbound, haulMirror);
    enrichProcessedSubmission(processed, processedMirror);
    enrichOutboundSubmission(outbound, outboundMirror);

    // ADR-0039 Amendment 1 — resolve leg liveness once per run (cached). A
    // missing-counterpart check on a non-live leg has its findings WITHHELD and
    // counted into the ledger, never emitted.
    const liveness = await resolveLegLiveness(db, window.siteId, rangeDate(asOfISO));

    const findings: Finding[] = [];
    const checkCodes: CheckCode[] = [];
    const suppressedBootstrap: Record<string, number> = {};
    const run = (code: CheckCode, produce: () => Finding[]) => {
      const cfg = configs.get(code);
      if (!cfg?.enabled) return;
      checkCodes.push(code);
      findings.push(...produce());
    };
    // Bootstrap-gated variant: when the leg is not live, produce (to count) but
    // WITHHOLD the findings and record the suppressed count; the check is not
    // added to checkCodes so the lifecycle reconciler leaves the (already
    // auto-resolved) bootstrap findings untouched (their provenance is
    // `bootstrap_suppression`, set by the one-shot resolve, not a generic
    // "corrected" auto-resolve).
    const runGated = (code: CheckCode, leg: BootstrapLeg, produce: () => Finding[]) => {
      const cfg = configs.get(code);
      if (!cfg?.enabled) return;
      const produced = produce();
      if (liveness.isLive(leg)) {
        checkCodes.push(code);
        findings.push(...produced);
      } else if (produced.length > 0) {
        suppressedBootstrap[code] = (suppressedBootstrap[code] ?? 0) + produced.length;
      }
    };

    run('c1_inbound', () => c1Inbound(window, inbound, haulMirror, configs.get('c1_inbound')!));
    run('c2_processed', () =>
      c2Processed(window, processed, processedMirror, configs.get('c2_processed')!),
    );
    run('c3_outbound', () =>
      c3Outbound(
        window,
        { outbound, landfilled },
        outboundMirror,
        configs.get('c3_outbound')!,
        holidays,
      ),
    );
    runGated('c4_billing_basis', 'billing', () =>
      c4BillingBasis(window, processed, billing, configs.get('c4_billing_basis')!),
    );
    run('c5_conservation', () =>
      c5Conservation(window, conservation, configs.get('c5_conservation')!),
    );
    run('c6_inventory_continuity', () =>
      c6InventoryContinuity(window, inventoryDays, configs.get('c6_inventory_continuity')!),
    );
    run('c7_deadline', () =>
      c7Deadline(window, { inbound, processed, outbound }, configs.get('c7_deadline')!, holidays),
    );

    // ── ADR-0043 (P3) rate + missing-record checks ──────────────────────
    if (jurisdiction) {
      run('r1_recycling_rate', () =>
        r1RecyclingRate(
          rateWindow,
          rateInputs.recycling,
          configs.get('r1_recycling_rate')!,
          resolveRateThresholds(configs.get('r1_recycling_rate')!.params, jurisdiction),
          jurisdiction,
        ),
      );
      run('r2_recovery_rate', () =>
        r2RecoveryRate(
          rateWindow,
          rateInputs.recovery,
          configs.get('r2_recovery_rate')!,
          resolveRateThresholds(configs.get('r2_recovery_rate')!.params, jurisdiction),
          jurisdiction,
        ),
      );
    }
    runGated('m1_missing_close', 'close', () =>
      m1MissingClose(window, { days: m1Days }, configs.get('m1_missing_close')!, holidays),
    );
    runGated('m2_missing_snapshot', 'snapshot', () =>
      m2MissingSnapshot(window, { lastPhysicalSnapshotISO }, configs.get('m2_missing_snapshot')!),
    );
    // ADR-0052 — commodity payment aging (per-buyer rollup, D3); gated on the
    // commodity_payment leg so it stays silent until the first payment entry.
    runGated('m3_commodity_payment_aging', 'commodity_payment', () =>
      m3CommodityPaymentAging(
        window,
        { rows: m3PaymentRows },
        configs.get('m3_commodity_payment_aging')!,
      ),
    );

    // Explain-don't-flag cross-annotation (ADR-0043 D2 / survey §B): a low rate
    // that coincides with an open missing-record finding is likely a data gap,
    // not an operational breach. Link the concurrent OPEN M-finding ids into each
    // R-finding's detail so the reviewer sees the probable cause. (M findings
    // opened THIS run have no id yet; they link on the next nightly refresh.)
    const rFindings = findings.filter(
      (f) => f.checkCode === 'r1_recycling_rate' || f.checkCode === 'r2_recovery_rate',
    );
    if (rFindings.length > 0) {
      const openMissing = await db.auditFinding.findMany({
        where: {
          site_id: window.siteId,
          check_code: { in: ['m1_missing_close', 'm2_missing_snapshot'] },
          status: { in: ['open', 'acknowledged'] },
        },
        select: { id: true, check_code: true },
      });
      if (openMissing.length > 0) {
        const links = openMissing.map((m) => ({ id: m.id, checkCode: m.check_code }));
        for (const f of rFindings) {
          const base =
            f.detail && typeof f.detail === 'object' && !Array.isArray(f.detail) ? f.detail : {};
          f.detail = { ...base, linkedMissingFindings: links };
        }
      }
    }

    return { checkCodes, findings, suppressedBootstrap };
  };
}
