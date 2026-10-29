// ADR-0143 D4 / D5 + Bill B4 (2026-10-29) — resolving a negative-pool exception.
//
// Who acts: the SITE MANAGER, in the app. A second person approves (four-eyes).
// Bill is paged at onset and at 7 days (exception-alerts.ts); managers are never
// pushed (CLAUDE.md hard rule 5) and see this only in-app, born pilot.
//
// Two ways an exception closes:
//   1. An APPROVED pool adjustment linked to it, after which the pool closes ≥ 0 on
//      every day from the adjustment's date onward. Units leave one pool and enter
//      the other, so the total cannot move (B2: "the total is what matters"). Units
//      are NOT reclassified for MRC reporting — this is bookkeeping of the floor
//      split only.
//   2. An APPROVED no-adjustment resolution (e.g. a count already reset the pool),
//      allowed only when the pool's current position is ≥ 0.
//
// Every decision is a compare-and-swap inside one transaction with its audit row
// (ADR-0118), under the site's promotion lock, and re-runs the pool guard so the
// position table and the exception agree at commit (the D3 trigger checks it).

import { Prisma } from '@prisma/client';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { prisma } from '@/lib/prisma';
import { dayISO, dayKeyUTCFromISO, pacificDayISO } from '@/lib/time';
import { assertPoolsAfterWrite, type PoolKey } from './pool-guard';

const D = Prisma.Decimal;

export const MIN_REASON_CHARS = 10;

export class InventoryExceptionError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 422,
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'InventoryExceptionError';
  }
}

export interface ExceptionSummary {
  id: string;
  pool: PoolKey;
  status: 'open' | 'resolved';
  firstNegativeDay: string;
  lastNegativeDay: string | null;
  openedByWriter: string;
  openedAt: string;
  shortfall: string;
  resolvedAt: string | null;
  resolution: string | null;
  resolutionProposedBy: string | null;
  resolutionProposedNote: string | null;
  /**
   * ISO instant of the CURRENT proposal. The approver sends it back, so the approval
   * binds to the exact text they were shown (a re-proposal changes it → 409).
   */
  resolutionProposedAt: string | null;
}

function summary(e: {
  id: string;
  pool: PoolKey;
  status: 'open' | 'resolved';
  first_negative_day: Date;
  last_negative_day: Date | null;
  opened_by_writer: string;
  opened_at: Date;
  shortfall: Prisma.Decimal;
  resolved_at: Date | null;
  resolution: string | null;
  resolution_proposed_by: string | null;
  resolution_proposed_note: string | null;
  resolution_proposed_at: Date | null;
}): ExceptionSummary {
  return {
    id: e.id,
    pool: e.pool,
    status: e.status,
    firstNegativeDay: dayISO(e.first_negative_day),
    lastNegativeDay: e.last_negative_day ? dayISO(e.last_negative_day) : null,
    openedByWriter: e.opened_by_writer,
    openedAt: e.opened_at.toISOString(),
    shortfall: e.shortfall.toString(),
    resolvedAt: e.resolved_at ? e.resolved_at.toISOString() : null,
    resolution: e.resolution,
    resolutionProposedBy: e.resolution_proposed_by,
    resolutionProposedNote: e.resolution_proposed_note,
    resolutionProposedAt: e.resolution_proposed_at ? e.resolution_proposed_at.toISOString() : null,
  };
}

const SUMMARY_SELECT = {
  id: true,
  pool: true,
  status: true,
  first_negative_day: true,
  last_negative_day: true,
  opened_by_writer: true,
  opened_at: true,
  shortfall: true,
  resolved_at: true,
  resolution: true,
  resolution_proposed_by: true,
  resolution_proposed_note: true,
  resolution_proposed_at: true,
} as const;

/** Open exceptions first, then the 20 most recent resolved ones. Site-scoped. */
export async function listInventoryExceptions(siteId: string): Promise<ExceptionSummary[]> {
  const [open, resolved] = await Promise.all([
    prisma.inventoryException.findMany({
      where: { site_id: siteId, status: 'open' },
      orderBy: { opened_at: 'desc' },
      select: SUMMARY_SELECT,
    }),
    prisma.inventoryException.findMany({
      where: { site_id: siteId, status: 'resolved' },
      orderBy: { resolved_at: 'desc' },
      take: 20,
      select: SUMMARY_SELECT,
    }),
  ]);
  return [...open, ...resolved].map((e) => summary(e as Parameters<typeof summary>[0]));
}

export interface PositionView {
  day: string;
  opening: string;
  inbound: string;
  dropoffs: string;
  stripped: string;
  sold: string;
  landfilled: string;
  adjustments: string;
  closing: string;
  negative: boolean;
}

export interface AdjustmentView {
  id: string;
  day: string;
  fromPool: PoolKey;
  toPool: PoolKey;
  units: string;
  reason: string;
  status: 'proposed' | 'approved' | 'rejected';
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  decisionNote: string | null;
}

export interface ExceptionDetail {
  exception: ExceptionSummary;
  legs: Record<string, unknown>;
  positions: PositionView[];
  adjustments: AdjustmentView[];
}

/** One exception with the legs table for its pool (first negative day − 3 → today). */
export async function getInventoryExceptionDetail(
  siteId: string,
  id: string,
): Promise<ExceptionDetail> {
  const e = await prisma.inventoryException.findFirst({
    where: { id, site_id: siteId },
    select: { ...SUMMARY_SELECT, legs: true },
  });
  if (!e) throw new InventoryExceptionError(404, 'exception_not_found');
  const from = new Date(e.first_negative_day.getTime() - 3 * 86_400_000);
  const [positions, adjustments] = await Promise.all([
    prisma.inventoryPositionDaily.findMany({
      where: { site_id: siteId, pool: e.pool, day: { gte: from } },
      orderBy: { day: 'asc' },
      take: 120,
    }),
    prisma.inventoryPoolAdjustment.findMany({
      where: { site_id: siteId, exception_id: id },
      orderBy: { proposed_at: 'asc' },
    }),
  ]);
  return {
    exception: summary(e as Parameters<typeof summary>[0]),
    legs: (e.legs ?? {}) as Record<string, unknown>,
    positions: positions.map((p) => ({
      day: dayISO(p.day),
      opening: p.opening.toString(),
      inbound: p.inbound.toString(),
      dropoffs: p.dropoffs.toString(),
      stripped: p.stripped.toString(),
      sold: p.sold.toString(),
      landfilled: p.landfilled.toString(),
      adjustments: p.adjustments.toString(),
      closing: p.closing.toString(),
      negative: p.closing.isNegative(),
    })),
    adjustments: adjustments.map((a) => ({
      id: a.id,
      day: dayISO(a.day),
      fromPool: a.from_pool,
      toPool: a.to_pool,
      units: a.units.toString(),
      reason: a.reason,
      status: a.status,
      proposedBy: a.proposed_by,
      proposedAt: a.proposed_at.toISOString(),
      approvedBy: a.approved_by,
      rejectedBy: a.rejected_by,
      decisionNote: a.decision_note,
    })),
  };
}

async function loadOpenException(
  tx: Prisma.TransactionClient,
  siteId: string,
  id: string,
): Promise<{ id: string; pool: PoolKey; first_negative_day: Date }> {
  const e = await tx.inventoryException.findFirst({
    where: { id, site_id: siteId },
    select: { id: true, pool: true, status: true, first_negative_day: true },
  });
  if (!e) throw new InventoryExceptionError(404, 'exception_not_found');
  if (e.status !== 'open') throw new InventoryExceptionError(409, 'exception_not_open');
  return e as { id: string; pool: PoolKey; first_negative_day: Date };
}

/**
 * Propose a split correction. Moves NOTHING until a second person approves it.
 * Pure input checks first (422), then the row and its audit in one transaction.
 */
export async function proposePoolAdjustment(args: {
  siteId: string;
  exceptionId: string;
  day: string;
  fromPool: PoolKey;
  toPool: PoolKey;
  units: number;
  reason: string;
  actorUserId: string;
  now?: Date;
}): Promise<AdjustmentView> {
  const reason = args.reason.trim();
  if (args.fromPool === args.toPool) throw new InventoryExceptionError(422, 'same_pool');
  if (!(args.units > 0) || Math.round(args.units * 10) !== args.units * 10) {
    throw new InventoryExceptionError(422, 'units_invalid');
  }
  if (reason.length < MIN_REASON_CHARS) throw new InventoryExceptionError(422, 'reason_too_short');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) throw new InventoryExceptionError(422, 'day_invalid');
  const today = pacificDayISO(args.now ?? new Date());
  if (args.day > today) throw new InventoryExceptionError(422, 'day_in_future');

  const row = await prisma.$transaction(async (tx) => {
    await lockSiteAgainstPromotion(tx, args.siteId);
    const ex = await loadOpenException(tx, args.siteId, args.exceptionId);
    if (args.fromPool !== ex.pool && args.toPool !== ex.pool) {
      throw new InventoryExceptionError(422, 'pool_not_in_exception');
    }
    const created = await tx.inventoryPoolAdjustment.create({
      data: {
        site_id: args.siteId,
        day: dayKeyUTCFromISO(args.day),
        from_pool: args.fromPool,
        to_pool: args.toPool,
        units: new D(args.units),
        reason,
        exception_id: ex.id,
        proposed_by: args.actorUserId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: args.actorUserId,
        action: 'insert',
        table_name: 'inventory_pool_adjustments',
        row_id: created.id,
        after: {
          exception_id: ex.id,
          day: args.day,
          from_pool: args.fromPool,
          to_pool: args.toPool,
          units: String(args.units),
          reason,
          status: 'proposed',
        },
      },
    });
    return created;
  });
  return {
    id: row.id,
    day: dayISO(row.day),
    fromPool: row.from_pool,
    toPool: row.to_pool,
    units: row.units.toString(),
    reason: row.reason,
    status: row.status,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at.toISOString(),
    approvedBy: null,
    rejectedBy: null,
    decisionNote: null,
  };
}

/** The pool's negative days after a fresh guard run, and its latest closing. */
async function poolState(
  tx: Prisma.TransactionClient,
  siteId: string,
  pool: PoolKey,
): Promise<{ negativeDays: string[]; latest: Prisma.Decimal | null }> {
  const rows = await tx.inventoryPositionDaily.findMany({
    where: { site_id: siteId, pool },
    orderBy: { day: 'asc' },
    select: { day: true, closing: true },
  });
  return {
    negativeDays: rows.filter((r) => r.closing.isNegative()).map((r) => dayISO(r.day)),
    latest: rows.length > 0 ? rows[rows.length - 1]!.closing : null,
  };
}

export interface DecisionResult {
  adjustmentId: string;
  status: 'approved' | 'rejected';
  exceptionResolved: boolean;
}

/**
 * Approve or reject a proposed adjustment.
 *
 * No proposal-changed-under-the-approver window exists here (the TOCTOU guarded in
 * approveExceptionResolution): an adjustment's content is immutable while proposed
 * (migration trigger `adr0143_adjustments_guard` lets only the decision columns
 * move), and a re-proposal is a NEW row with a new id. Deciding by id therefore
 * decides exactly the proposal the approver was shown. The approver is never the proposer
 * (403 here; the CHECK refuses it as well). A CAS on `status = 'proposed'` makes a
 * double decision a 409, not a second write.
 */
export async function decidePoolAdjustment(args: {
  siteId: string;
  adjustmentId: string;
  decision: 'approve' | 'reject';
  actorUserId: string;
  note?: string | null;
  now?: Date;
}): Promise<DecisionResult> {
  const now = args.now ?? new Date();
  const note = args.note?.trim() || null;
  return prisma.$transaction(
    async (tx) => {
      await lockSiteAgainstPromotion(tx, args.siteId);
      const adj = await tx.inventoryPoolAdjustment.findFirst({
        where: { id: args.adjustmentId, site_id: args.siteId },
      });
      if (!adj) throw new InventoryExceptionError(404, 'adjustment_not_found');
      if (adj.status !== 'proposed') throw new InventoryExceptionError(409, 'already_decided');
      if (args.decision === 'approve' && adj.proposed_by === args.actorUserId) {
        throw new InventoryExceptionError(
          403,
          'four_eyes',
          'the approver must be a different person',
        );
      }
      const { count } = await tx.inventoryPoolAdjustment.updateMany({
        where: { id: adj.id, status: 'proposed' },
        data:
          args.decision === 'approve'
            ? {
                status: 'approved',
                approved_by: args.actorUserId,
                approved_at: now,
                decision_note: note,
              }
            : {
                status: 'rejected',
                rejected_by: args.actorUserId,
                rejected_at: now,
                decision_note: note,
              },
      });
      if (count !== 1) throw new InventoryExceptionError(409, 'already_decided');
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: 'inventory_pool_adjustments',
          row_id: adj.id,
          before: { status: 'proposed' },
          after: {
            status: args.decision === 'approve' ? 'approved' : 'rejected',
            decision_note: note,
          },
        },
      });
      if (args.decision === 'reject') {
        return { adjustmentId: adj.id, status: 'rejected' as const, exceptionResolved: false };
      }

      // The adjustment is now a leg: rebuild the positions on THIS transaction. Not
      // the swallowing form — a failure here fails the approval, which is right for
      // a write Vision itself owns.
      await assertPoolsAfterWrite(tx, args.siteId, 'pool-adjustment', now);

      let exceptionResolved = false;
      if (adj.exception_id) {
        const ex = await tx.inventoryException.findFirst({
          where: { id: adj.exception_id, site_id: args.siteId },
          select: { id: true, pool: true, status: true, first_negative_day: true },
        });
        if (ex && ex.status === 'open') {
          const state = await poolState(tx, args.siteId, ex.pool as PoolKey);
          const adjDay = dayISO(adj.day);
          const stillNegativeFrom = state.negativeDays.filter((d) => d >= adjDay);
          if (stillNegativeFrom.length === 0) {
            const firstDay = dayISO(ex.first_negative_day);
            const last = state.negativeDays.filter((d) => d >= firstDay).at(-1) ?? firstDay;
            await tx.inventoryException.update({
              where: { id: ex.id },
              data: {
                status: 'resolved',
                resolved_by: args.actorUserId,
                resolved_at: now,
                resolution: `pool adjustment ${adj.id} (${adj.units.toString()} ${adj.from_pool} -> ${adj.to_pool}, dated ${adjDay})`,
                last_negative_day: dayKeyUTCFromISO(last),
              },
            });
            await tx.auditLog.create({
              data: {
                actor_user_id: args.actorUserId,
                action: 'update',
                table_name: 'inventory_exceptions',
                row_id: ex.id,
                before: { status: 'open' },
                after: { status: 'resolved', by_adjustment: adj.id, last_negative_day: last },
              },
            });
            exceptionResolved = true;
          }
        }
      }
      return { adjustmentId: adj.id, status: 'approved' as const, exceptionResolved };
    },
    { timeout: 60_000 },
  );
}

/** Propose closing an exception WITHOUT an adjustment. Only when the pool is ≥ 0 now. */
export async function proposeExceptionResolution(args: {
  siteId: string;
  exceptionId: string;
  note: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const note = args.note.trim();
  if (note.length < MIN_REASON_CHARS) throw new InventoryExceptionError(422, 'reason_too_short');
  const now = args.now ?? new Date();
  await prisma.$transaction(
    async (tx) => {
      await lockSiteAgainstPromotion(tx, args.siteId);
      const ex = await loadOpenException(tx, args.siteId, args.exceptionId);
      await assertPoolsAfterWrite(tx, args.siteId, 'pool-adjustment', now);
      const state = await poolState(tx, args.siteId, ex.pool);
      if (state.latest == null || state.latest.isNegative()) {
        throw new InventoryExceptionError(
          409,
          'still_negative',
          'the pool is still negative: propose an adjustment',
        );
      }
      await tx.inventoryException.update({
        where: { id: ex.id },
        data: {
          resolution_proposed_by: args.actorUserId,
          resolution_proposed_note: note,
          resolution_proposed_at: now,
        },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: 'inventory_exceptions',
          row_id: ex.id,
          after: { resolution_proposed: note },
        },
      });
    },
    { timeout: 60_000 },
  );
}

/** Approve a proposed no-adjustment resolution. Four-eyes; the pool must still be ≥ 0. */
export async function approveExceptionResolution(args: {
  siteId: string;
  exceptionId: string;
  actorUserId: string;
  /**
   * `resolutionProposedAt` exactly as the approver's page showed it. Four-eyes means
   * the approver signs off on the text THEY SAW: if the proposer re-proposes after the
   * page loaded, the timestamp moves and this approval is refused (409
   * `stale_proposal`), both up front and in the compare-and-swap.
   */
  expectedProposedAt: string;
  now?: Date;
}): Promise<void> {
  const expected = new Date(args.expectedProposedAt);
  if (Number.isNaN(expected.getTime())) throw new InventoryExceptionError(422, 'invalid_input');
  const now = args.now ?? new Date();
  await prisma.$transaction(
    async (tx) => {
      await lockSiteAgainstPromotion(tx, args.siteId);
      const ex = await loadOpenException(tx, args.siteId, args.exceptionId);
      const row = await tx.inventoryException.findUniqueOrThrow({
        where: { id: ex.id },
        select: {
          resolution_proposed_by: true,
          resolution_proposed_note: true,
          resolution_proposed_at: true,
        },
      });
      if (
        !row.resolution_proposed_by ||
        !row.resolution_proposed_note ||
        !row.resolution_proposed_at
      ) {
        throw new InventoryExceptionError(409, 'nothing_proposed');
      }
      if (row.resolution_proposed_at.getTime() !== expected.getTime()) {
        throw new InventoryExceptionError(
          409,
          'stale_proposal',
          'the proposal changed since you loaded the page',
        );
      }
      if (row.resolution_proposed_by === args.actorUserId) {
        throw new InventoryExceptionError(
          403,
          'four_eyes',
          'the approver must be a different person',
        );
      }
      await assertPoolsAfterWrite(tx, args.siteId, 'pool-adjustment', now);
      const state = await poolState(tx, args.siteId, ex.pool);
      if (state.latest == null || state.latest.isNegative()) {
        throw new InventoryExceptionError(409, 'still_negative');
      }
      const firstDay = dayISO(ex.first_negative_day);
      const last = state.negativeDays.filter((d) => d >= firstDay).at(-1) ?? firstDay;
      const { count } = await tx.inventoryException.updateMany({
        // CAS on the proposal the approver SAW: proposer, text and instant.
        where: {
          id: ex.id,
          status: 'open',
          resolution_proposed_by: row.resolution_proposed_by,
          resolution_proposed_note: row.resolution_proposed_note,
          resolution_proposed_at: expected,
        },
        data: {
          status: 'resolved',
          resolved_by: args.actorUserId,
          resolved_at: now,
          resolution: row.resolution_proposed_note,
          last_negative_day: dayKeyUTCFromISO(last),
        },
      });
      if (count !== 1) throw new InventoryExceptionError(409, 'stale_proposal');
      await tx.auditLog.create({
        data: {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: 'inventory_exceptions',
          row_id: ex.id,
          before: { status: 'open' },
          after: {
            status: 'resolved',
            resolution: row.resolution_proposed_note,
            last_negative_day: last,
          },
        },
      });
    },
    { timeout: 60_000 },
  );
}
