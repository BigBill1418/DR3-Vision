// ADR-0037 D6 (Addendum B4) — inventory as ONE computed running balance, pool-aware.
//
// There is exactly ONE shared function that computes on-hand inventory
// (`computeRunningBalance`), reconciled to physical counts. This kills the
// 06-22→23 divergence class: totals are a single query-backed computation, never
// two competing spreadsheet sums.
//
//   End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled     (Addendum B4)
//
//   onHand(site, asOf) = anchor              (latest PHYSICAL snapshot ≤ asOf)  [Start]
//                      + verified inbound     (inbound_loads split)             [Inbound]
//                      + consumer drop-offs   (units — program pool)            [Inbound]
//                      − stripped             (processed_units_daily split)     [Stripped]
//                      − whole units sold     (outbound_materials sub_category  [WholeUnitsSold]
//                                              = renovation, split)
//                      − landfilled units     (landfilled_units split)         [Landfilled]
//   … everything since the anchor.
//
// Weight-based `outbound_materials` (sub_category `baled`/`shredded`) NEVER
// subtract units — they are post-deconstruction commodities, and deconstruction is
// what `stripped` already counts. `processed_units_daily.saved_units` SUBTRACTS from
// the NON-PROGRAM pool (ADR-0037 amendment, rollup §A.2 — Kelsey confirmed 2026-07-17:
// saved mattresses are set aside, not processed, and drawn from non-program inventory).
//
// POOL AWARENESS (Addendum B4 + survey amendment, Rick Albritton, both states):
// inventory is two ledgers — program / non-program — because MRC is billed on
// PROGRAM units only. Inbound, stripped, whole-units-sold, and landfilled all carry
// a program/non-program split; consumer drop-offs (CIP) are program-pool units.
// The function returns `{ program, nonProgram, total }` and `program + nonProgram
// === total` always holds.
//
// All arithmetic uses `Prisma.Decimal` (stripped units are Decimal(7,1); every
// other count is an Int) so there is zero float drift at any count boundary.

import { Prisma, type LoadStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

const D = Prisma.Decimal;
type DecimalLike = Prisma.Decimal | number | string;

/** A program / non-program pool pair of unit quantities. */
export interface PoolPair {
  program: DecimalLike;
  nonProgram: DecimalLike;
}

/** Every additive/subtractive component of the running balance, since the anchor. */
export interface BalanceComponents {
  /** Physical-count anchor at/before asOf, split by pool (see onHand for the default). */
  anchor: PoolPair;
  /** Verified inbound loads' program/non-program unit counts since the anchor. */
  verifiedInbound: PoolPair;
  /** Consumer drop-off units since the anchor — attributed to the PROGRAM pool (CIP). */
  dropoffUnits: DecimalLike;
  /** processed_units_daily stripped program/non-program units since the anchor. */
  stripped: PoolPair;
  /** outbound_materials (sub_category = renovation) program/non-program WHOLE units sold since the anchor. */
  wholeUnitsSold: PoolPair;
  /** landfilled_units program/non-program units since the anchor. */
  landfilled: PoolPair;
  /**
   * `Saved` units set aside since the anchor, subtracted from the NON-PROGRAM pool.
   * HISTORICAL-RECONCILIATION USE ONLY: the closed-month audit path
   * (workbook-promotion / inventory-close) supplies this to reproduce the workbook's
   * own recorded subtraction (the June 3,977 oracle). The LIVE path (`onHand`) does
   * NOT supply it — per rollup §5.2 (Rick) saved units stay in inventory until a store
   * transfer, so they must not decrement the live floor. Optional/absent → 0.
   */
  savedUnits?: DecimalLike;
}

/** The single pool-aware running balance. `program.plus(nonProgram)` equals `total`. */
export interface RunningBalance {
  program: Prisma.Decimal;
  nonProgram: Prisma.Decimal;
  total: Prisma.Decimal;
  /**
   * ADR-0037 §3 (pool split, handoff §1.4) — how the anchor's pools were derived:
   * `measured` when the anchor snapshot carried an entered program/non-program
   * split; `legacy` when the whole anchor was attributed to the program pool
   * (pre-amendment rows, or a measured row missing either pool value). Additive —
   * existing consumers may ignore it.
   */
  anchorPool?: 'measured' | 'legacy';
}

/**
 * A `measured` physical count was submitted with a program/non-program split that
 * does not sum to the physical total. Refused rather than persisted — a wrong split
 * would silently mis-bill MRC (program-only). 422: the office fixes the pools and
 * resubmits. Mirrors the typed-status-error shape of the loads/dropoffs services so
 * `loadsErrorResponse` maps it uniformly.
 */
export class PoolSplitMismatchError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PoolSplitMismatchError';
  }
}

/**
 * The one shared pure computation (D6). Given every component since the anchor,
 * returns the pool-aware on-hand balance. No DB, no clock — fully unit-testable
 * with real `Prisma.Decimal` values.
 */
export function computeRunningBalance(c: BalanceComponents): RunningBalance {
  const program = new D(c.anchor.program)
    .plus(c.verifiedInbound.program)
    .plus(c.dropoffUnits)
    .minus(c.stripped.program)
    .minus(c.wholeUnitsSold.program)
    .minus(c.landfilled.program);

  const nonProgram = new D(c.anchor.nonProgram)
    .plus(c.verifiedInbound.nonProgram)
    .minus(c.stripped.nonProgram)
    .minus(c.wholeUnitsSold.nonProgram)
    .minus(c.landfilled.nonProgram)
    .minus(c.savedUnits ?? 0);

  return { program, nonProgram, total: program.plus(nonProgram) };
}

// ─────────────────────────────────────────────────────────────────────────
// DB adapter
// ─────────────────────────────────────────────────────────────────────────

/** Inbound statuses that have cleared the manager verify gate (D6 "verified inbound"). */
export const VERIFIED_INBOUND_STATUSES: readonly LoadStatus[] = [
  'verified',
  'submitted_to_mymrc',
  'processed',
] as const;

/** Sum the non-null physical unit fields of a snapshot into a single total. */
export function snapshotTotalUnits(s: {
  units_indoor: number | null;
  units_outdoor: number | null;
  units_total: number | null;
  units_in_processing: number;
}): number {
  return (
    (s.units_indoor ?? 0) + (s.units_outdoor ?? 0) + (s.units_total ?? 0) + s.units_in_processing
  );
}

/**
 * Compute the pool-aware on-hand balance for a site as of `asOf`.
 *
 * Anchor pool split: physical snapshots do not yet carry a program/non-program
 * split (ADR-0039 will add historical pool attribution when the workbooks are
 * imported). Until then the entire physical anchor is attributed to the PROGRAM
 * pool, so the non-program pool reflects only flow since the anchor. The invariant
 * `program + nonProgram === total` still holds. This default is documented in
 * docs/QUESTIONS.md (question ADR-0037-inventory-anchor-pool).
 */
export async function onHand(siteId: string, asOf: Date): Promise<RunningBalance> {
  const anchor = await prisma.siteInventorySnapshot.findFirst({
    where: { site_id: siteId, snapshot_kind: 'physical', snapshot_at: { lte: asOf } },
    orderBy: { snapshot_at: 'desc' },
    select: {
      snapshot_at: true,
      units_indoor: true,
      units_outdoor: true,
      units_total: true,
      units_in_processing: true,
      program_units: true,
      non_program_units: true,
      pool_attribution: true,
    },
  });

  const anchorUnits = anchor ? snapshotTotalUnits(anchor) : 0;
  // ADR-0037 §3 pool split: a `measured` anchor carries an entered program/non-program
  // split (which was validated to sum to the total at write time), so use it directly.
  // Otherwise fall back to the LEGACY default — attribute the whole anchor to the
  // program pool. Either way `program + nonProgram === total` holds for the anchor.
  const measuredAnchor =
    anchor != null &&
    anchor.pool_attribution === 'measured' &&
    anchor.program_units != null &&
    anchor.non_program_units != null;
  const anchorPair: PoolPair = measuredAnchor
    ? {
        program: anchor.program_units as Prisma.Decimal,
        nonProgram: anchor.non_program_units as Prisma.Decimal,
      }
    : { program: anchorUnits, nonProgram: 0 };
  const anchorPool: 'measured' | 'legacy' = measuredAnchor ? 'measured' : 'legacy';
  // No physical anchor yet → count everything from the epoch up to asOf.
  const since = anchor ? anchor.snapshot_at : new Date(0);
  const dateWindow = { gt: since, lte: asOf };

  const [inbound, dropoffs, stripped, wholeUnitsSold, landfilled] = await Promise.all([
    prisma.inboundLoad.aggregate({
      _sum: { program_unit_count: true, non_program_unit_count: true },
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        arrived_at: dateWindow,
      },
    }),
    prisma.consumerDropoff.aggregate({
      _sum: { units: true },
      where: { site_id: siteId, dropoff_date: dateWindow },
    }),
    prisma.processedUnitsDaily.aggregate({
      _sum: { stripped_program: true, stripped_non_program: true },
      where: { site_id: siteId, production_date: dateWindow },
    }),
    // WholeUnitsSold = renovation-sub-category outbound rows (the folded-in renovator
    // channel). Baled/shredded commodity sales are excluded — they never subtract units.
    prisma.outboundMaterial.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: dateWindow },
    }),
    prisma.landfilledUnit.aggregate({
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, disposal_date: dateWindow },
    }),
  ]);

  const balance = computeRunningBalance({
    anchor: anchorPair,
    verifiedInbound: {
      program: inbound._sum.program_unit_count ?? 0,
      nonProgram: inbound._sum.non_program_unit_count ?? 0,
    },
    dropoffUnits: dropoffs._sum.units ?? 0,
    stripped: {
      program: stripped._sum.stripped_program ?? 0,
      nonProgram: stripped._sum.stripped_non_program ?? 0,
    },
    wholeUnitsSold: {
      program: wholeUnitsSold._sum.program_units ?? 0,
      nonProgram: wholeUnitsSold._sum.non_program_units ?? 0,
    },
    landfilled: {
      program: landfilled._sum.program_units ?? 0,
      nonProgram: landfilled._sum.non_program_units ?? 0,
    },
    // rollup §5.2 (Rick, 2026-07-19): saved units are NOT removed from inventory until
    // physically transferred to a store, so the LIVE on-hand balance (and the §3 floor
    // tile that reads it) must NOT subtract them — `savedUnits` is deliberately omitted
    // here (defaults to 0). Kelsey's Addendum-A §A.2 immediate-subtraction model was
    // operationally wrong and is retracted on the live path. The historical closed-month
    // audit reconciliation (workbook-promotion / inventory-close, the June 3,977 oracle)
    // still applies the workbook's own recorded subtraction — that parity is unchanged.
  });
  return { ...balance, anchorPool };
}

/** Result of a physical-count reconciliation. */
export interface ReconcileResult {
  snapshotId: string;
  computedTotal: Prisma.Decimal;
  physicalTotal: number;
  /** `physical − computed`, rounded to the nearest whole unit (Int column). */
  reconciledDelta: number;
}

/** Physical unit fields for a new anchor snapshot (jurisdiction-appropriate subset). */
export interface PhysicalCountInput {
  units_indoor?: number | null;
  units_outdoor?: number | null;
  units_total?: number | null;
  units_in_processing?: number;
}

/**
 * Record a physical count as the new inventory anchor (D6). Writes a `physical`
 * snapshot whose `reconciled_delta = physical − computed` (the drift vs. the
 * running balance, recorded and audited — never silently absorbed), plus an
 * append-only audit row in the SAME transaction (CLAUDE.md hard rule #6).
 */
export async function reconcilePhysicalCount(args: {
  siteId: string;
  countedAt: Date;
  physical: PhysicalCountInput;
  /** ADR-0037 §3 pool split — entered program pool for this count (whole units). */
  programUnits?: number | null;
  /** ADR-0037 §3 pool split — entered non-program pool for this count. */
  nonProgramUnits?: number | null;
  /** `measured` (default) validates the split; `legacy` records the count unsplit. */
  poolAttribution?: 'measured' | 'legacy';
  actorUserId: string | null;
}): Promise<ReconcileResult> {
  const poolAttribution = args.poolAttribution ?? 'measured';
  const physicalTotal = snapshotTotalUnits({
    units_indoor: args.physical.units_indoor ?? null,
    units_outdoor: args.physical.units_outdoor ?? null,
    units_total: args.physical.units_total ?? null,
    units_in_processing: args.physical.units_in_processing ?? 0,
  });

  // ADR-0037 §3 — a `measured` count with BOTH pools entered must sum to the physical
  // total (MRC is billed on program units only; a wrong split silently mis-bills).
  // Validate pre-transaction so nothing is persisted on refusal.
  const bothPools = args.programUnits != null && args.nonProgramUnits != null;
  if (poolAttribution === 'measured' && bothPools) {
    const sum = new D(args.programUnits as number).plus(args.nonProgramUnits as number);
    if (!sum.equals(new D(physicalTotal))) {
      throw new PoolSplitMismatchError(
        'pool_mismatch',
        `program (${args.programUnits}) + non-program (${args.nonProgramUnits}) = ${sum.toString()}, which does not equal the physical total ${physicalTotal}`,
      );
    }
  }

  const computed = await onHand(args.siteId, args.countedAt);
  const reconciledDelta = new D(physicalTotal).minus(computed.total).toNearest(1).toNumber();

  const snapshot = await prisma.$transaction(async (tx) => {
    const created = await tx.siteInventorySnapshot.create({
      data: {
        site_id: args.siteId,
        snapshot_at: args.countedAt,
        snapshot_kind: 'physical',
        source: 'manual',
        units_indoor: args.physical.units_indoor ?? null,
        units_outdoor: args.physical.units_outdoor ?? null,
        units_total: args.physical.units_total ?? null,
        units_in_processing: args.physical.units_in_processing ?? 0,
        reconciled_delta: reconciledDelta,
        program_units: args.programUnits ?? null,
        non_program_units: args.nonProgramUnits ?? null,
        pool_attribution: poolAttribution,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        actor_label: args.actorUserId ? null : 'system:inventory-reconcile',
        action: 'insert',
        table_name: 'site_inventory_snapshots',
        row_id: created.id,
        after: {
          snapshot_kind: 'physical',
          physical_total: physicalTotal,
          computed_total: computed.total.toString(),
          reconciled_delta: reconciledDelta,
          program_units: args.programUnits ?? null,
          non_program_units: args.nonProgramUnits ?? null,
          pool_attribution: poolAttribution,
        },
      },
    });
    return created;
  });

  return {
    snapshotId: snapshot.id,
    computedTotal: computed.total,
    physicalTotal,
    reconciledDelta,
  };
}
