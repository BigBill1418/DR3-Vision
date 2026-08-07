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
// COUNT-DAY BOUNDARY (D-3): the anchor `snapshot_at` is stamped at Pacific-midnight
// (00:00 PT) of its count day, and flows attribute to America/Los_Angeles calendar
// days. A physical count is that day's CLOSING position — its own day's flows are
// already in the count, only LATER Pacific days add. `anchorFlowBounds` derives the
// two lower bounds (@db.Date columns vs the `arrived_at` instant) so both sides of
// the boundary use the same Pacific-day convention (no same-day inbound/outflow skew).
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
import { pacificDayKeyUTC, pacificMidnightInstantOfDayISO, dayISO } from '@/lib/time';

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

/**
 * Sum the non-null physical unit fields of a snapshot into a single total.
 *
 * ADR-0037 addendum (2026-07-22): outdoor storage is not tracked — DR3 never
 * stores units outside — so the total is indoor + total + in-processing only.
 */
export function snapshotTotalUnits(s: {
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
}): number {
  return (s.units_indoor ?? 0) + (s.units_total ?? 0) + s.units_in_processing;
}

/** The physical-snapshot fields `resolveAnchorPair` needs (a subset of the row). */
export interface AnchorSnapshotFields {
  units_indoor: number | null;
  units_total: number | null;
  units_in_processing: number;
  program_units: Prisma.Decimal | null;
  non_program_units: Prisma.Decimal | null;
  pool_attribution: string | null;
}

/**
 * Resolve a physical anchor snapshot into its pool-split pair + attribution — the
 * SINGLE source of truth for how an anchor's program/non-program pools are derived
 * (D-4). A `measured` anchor carrying BOTH pool columns is used directly (its split
 * was validated to sum to the physical total at write time). Otherwise the whole
 * physical count is attributed to the PROGRAM pool (`legacy`), per the documented
 * onHand convention. `null` anchor → the zero pair (epoch/no-count case).
 *
 * Both `onHand` (the live floor) and the audit's `startBalance` (leg-fetchers) MUST
 * call this so the two paths can never disagree on a measured anchor's pools — the
 * divergence that produced spurious C6 `physical_reconcile` findings.
 */
export function resolveAnchorPair(anchor: AnchorSnapshotFields | null): {
  pair: PoolPair;
  pool: 'measured' | 'legacy';
} {
  const measured =
    anchor != null &&
    anchor.pool_attribution === 'measured' &&
    anchor.program_units != null &&
    anchor.non_program_units != null;
  if (measured) {
    return {
      pair: {
        program: anchor.program_units as Prisma.Decimal,
        nonProgram: anchor.non_program_units as Prisma.Decimal,
      },
      pool: 'measured',
    };
  }
  return {
    pair: { program: anchor ? snapshotTotalUnits(anchor) : 0, nonProgram: 0 },
    pool: 'legacy',
  };
}

/**
 * The flow-window lower bounds since a physical anchor, Pacific-calendar consistent
 * (D-3 — the SINGLE definition, shared by `onHand` and the audit's `startBalance`).
 *
 * A physical count is the CLOSING position of its Pacific calendar day: flows dated
 * that day are already reflected in the count, so only flows on LATER Pacific days
 * add to the balance. The two operational storage shapes need different bounds:
 *
 *  - `@db.Date` columns (processed_units_daily / outbound_materials / landfilled_units
 *    / consumer_dropoffs) store a Pacific calendar day at UTC-midnight (00:00:00Z).
 *    The anchor's Pacific-midnight instant (07:00Z PDT / 08:00Z PST) sits BETWEEN two
 *    consecutive UTC-midnight day keys, so `{ gt: anchorDay }` cleanly excludes the
 *    anchor's own Pacific day and includes every later day. (`anchorDay` is that
 *    Pacific day's own @db.Date key, so the comparison is day-vs-day.)
 *  - `inbound_loads.arrived_at` is a true `timestamptz` instant, so the anchor day is
 *    excluded by starting the window at Pacific-midnight of the day AFTER the anchor's
 *    Pacific day (`gte`). Comparing the raw anchor instant against `arrived_at` (the
 *    pre-D-3 bug) let a same-Pacific-day arrival slip in while same-day @db.Date
 *    outflow was dropped — the asymmetry this eliminates.
 *
 * A null anchor (no physical count yet) → epoch for both: count everything up to asOf.
 * Requires the anchor `snapshot_at` to be stamped at Pacific-midnight (00:00 PT) of its
 * count day (the manager API and reconcilePhysicalCount both do); an old UTC-midnight
 * stamp still yields the correct @db.Date bound but mis-attributes the anchor's Pacific
 * day for inbound — the two prod rows were corrected (migration 20260807).
 */
export function anchorFlowBounds(anchorAt: Date | null): {
  dateSince: Date;
  inboundSince: Date;
} {
  if (anchorAt == null) return { dateSince: new Date(0), inboundSince: new Date(0) };
  const anchorDay = pacificDayKeyUTC(anchorAt);
  const dayAfter = new Date(anchorDay.getTime() + 86_400_000);
  return { dateSince: anchorDay, inboundSince: pacificMidnightInstantOfDayISO(dayISO(dayAfter)) };
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
    // ADR-0078 D1 — MUST match `loadPriorAnchor` in anchor-guardrail.ts exactly.
    // Counts are stored at Pacific midnight (D-3 below), so same-day counts tie
    // on `snapshot_at` and the planner picked the anchor. `created_at DESC`
    // makes the last-entered count the anchor, deterministically. If you change
    // one of these two orderings, change both — a guardrail measuring a swing
    // against a different anchor than the balance computes forward from is worse
    // than either being wrong alone.
    orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],
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

  // ADR-0037 §3 pool split via the shared resolver (D-4): `measured` anchors use
  // their entered split; otherwise the whole count is attributed to the program pool.
  // Either way `program + nonProgram === total` holds for the anchor.
  const { pair: anchorPair, pool: anchorPool } = resolveAnchorPair(anchor);
  // D-3: Pacific-calendar-consistent flow windows since the anchor. `@db.Date`
  // outflow columns key on `dateWindow` (Pacific days strictly after the anchor's
  // day); `arrived_at` (a true instant) keys on `inboundWindow` (on/after Pacific
  // midnight of the day AFTER the anchor's day). No physical anchor → epoch (count
  // everything up to asOf). See anchorFlowBounds for the storage-shape rationale.
  const { dateSince, inboundSince } = anchorFlowBounds(anchor ? anchor.snapshot_at : null);
  const dateWindow = { gt: dateSince, lte: asOf };
  const inboundWindow = { gte: inboundSince, lte: asOf };

  const [inbound, dropoffs, stripped, wholeUnitsSold, landfilled] = await Promise.all([
    prisma.inboundLoad.aggregate({
      _sum: { program_unit_count: true, non_program_unit_count: true },
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        arrived_at: inboundWindow,
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
  /**
   * ADR-0078 — an OPEN transaction to write the snapshot + audit row on, so a
   * caller can bind this write to its own (e.g. an idempotency claim). Omit and
   * this opens its own, as it always did.
   *
   * Note what is deliberately NOT moved inside: the `onHand` read above still
   * runs on the shared client, outside any caller transaction. That is
   * pre-existing behaviour and is left alone here — pulling a read of six
   * aggregate tables into a caller's transaction changes the lock footprint of
   * every count, which is a separate change that deserves its own evidence.
   */
  tx?: Prisma.TransactionClient;
}): Promise<ReconcileResult> {
  const poolAttribution = args.poolAttribution ?? 'measured';
  const physicalTotal = snapshotTotalUnits({
    units_indoor: args.physical.units_indoor ?? null,
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

  // ADR-0078 — when the caller supplies a transaction, the snapshot is written on
  // IT rather than in a private one. The floor count route claims its idempotency
  // key in the same transaction as this insert, and a claim that commits
  // separately from the write it guards is not a guard: the two orders of failure
  // give you either a burned key with no count, or a count with no defence.
  // Callers that pass nothing keep the previous behaviour exactly.
  const write = async (tx: Prisma.TransactionClient) => {
    const created = await tx.siteInventorySnapshot.create({
      data: {
        site_id: args.siteId,
        snapshot_at: args.countedAt,
        snapshot_kind: 'physical',
        source: 'manual',
        units_indoor: args.physical.units_indoor ?? null,
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
  };

  const snapshot = args.tx ? await write(args.tx) : await prisma.$transaction(write);

  return {
    snapshotId: snapshot.id,
    computedTotal: computed.total,
    physicalTotal,
    reconciledDelta,
  };
}
