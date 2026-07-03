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
// what `stripped` already counts. `processed_units_daily.saved_units` is captured
// but EXCLUDED from this equation (semantics open, Addendum B10-2).
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
}

/** The single pool-aware running balance. `program.plus(nonProgram)` equals `total`. */
export interface RunningBalance {
  program: Prisma.Decimal;
  nonProgram: Prisma.Decimal;
  total: Prisma.Decimal;
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
    .minus(c.landfilled.nonProgram);

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
  return (s.units_indoor ?? 0) + (s.units_outdoor ?? 0) + (s.units_total ?? 0) + s.units_in_processing;
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
    },
  });

  const anchorUnits = anchor ? snapshotTotalUnits(anchor) : 0;
  // No physical anchor yet → count everything from the epoch up to asOf.
  const since = anchor ? anchor.snapshot_at : new Date(0);
  const dateWindow = { gt: since, lte: asOf };

  const [inbound, dropoffs, stripped, wholeUnitsSold, landfilled] = await Promise.all([
    prisma.inboundLoad.aggregate({
      _sum: { program_unit_count: true, non_program_unit_count: true },
      where: { site_id: siteId, status: { in: [...VERIFIED_INBOUND_STATUSES] }, arrived_at: dateWindow },
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

  return computeRunningBalance({
    anchor: { program: anchorUnits, nonProgram: 0 },
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
  });
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
  actorUserId: string | null;
}): Promise<ReconcileResult> {
  const computed = await onHand(args.siteId, args.countedAt);
  const physicalTotal = snapshotTotalUnits({
    units_indoor: args.physical.units_indoor ?? null,
    units_outdoor: args.physical.units_outdoor ?? null,
    units_total: args.physical.units_total ?? null,
    units_in_processing: args.physical.units_in_processing ?? 0,
  });
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
