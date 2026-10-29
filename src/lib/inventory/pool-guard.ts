// ADR-0143 D2 / D3 — the split is checked where it is written, the same day.
//
// Why this exists. On-hand is DERIVED (ADR-0037 D6: anchor + five flow legs), which
// is the right design — there is no counter to race. But nothing looked at the pools
// after a write. Woodland's processed days arrive through the workbook sync and the
// MyMRC bridge; the only write-time negative check sat in `closeProcessedUnitsDay`,
// a door Woodland closed 0 of 33 days through. Program went negative on 2026-09-17
// and was first acted on 38 days later.
//
// What it does, inside the WRITER'S transaction, under the site's promotion lock:
//   1. Rebuild `inventory_position_daily` for the current anchor window — one row per
//      Pacific day per pool — from the SAME legs and the SAME `computeRunningBalance`
//      the live floor uses (one computation, ADR-0037 D6). The last closing equals
//      `computePoolBalance` exactly; the DB test pins it.
//   2. Link every negative day to an `inventory_exceptions` row of that site + pool.
//      If a negative day is explained by no exception, open ONE (the partial unique
//      index allows one open per site + pool, so a replay or a second writer cannot
//      open another).
//   3. It NEVER refuses the write. MRC is the system of record for processed and
//      delivered units; Vision records the disagreement, it does not reject the fact.
//
// A deferred constraint trigger (migration 20260870) refuses a negative `closing`
// with no exception at COMMIT, so "no unexplained negative" is a database fact, not
// a promise this module makes.

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { lockSiteAgainstPromotion } from '@/lib/audit/promotion-lock';
import { log } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';
import { dayISO, pacificDayISO, pacificMidnightInstantOfDayISO } from '@/lib/time';
import {
  VERIFIED_INBOUND_STATUSES,
  anchorFlowBounds,
  computeRunningBalance,
  netAdjustments,
  resolveAnchorPair,
  selectPoolAnchor,
  sumTaughtDropoffKinds,
  type AdjustmentGroup,
  type BalanceDb,
  type PoolPair,
} from './running-balance';

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;

/**
 * Every writer that may call the guard. A closed list so a page or an alert can say
 * which door a negative came through (the exception's `opened_by_writer`).
 */
export type PoolWriter =
  | 'workbook-sync'
  | 'mymrc-processed-bridge'
  | 'mymrc-inbound-bridge'
  | 'processed-units-entry'
  | 'processed-units-close'
  | 'dropoff'
  | 'floor-dropoff'
  | 'outbound'
  | 'landfilled'
  | 'physical-count'
  | 'count-correction'
  | 'count-void'
  | 'inbound-bulk'
  | 'inbound-floor'
  | 'inbound-verify'
  | 'inbound-eod-line'
  | 'inbound-load'
  | 'workbook-promotion'
  | 'pool-adjustment'
  | 'sweep';

export type PoolKey = 'program' | 'non_program';
export const POOLS: readonly PoolKey[] = ['program', 'non_program'];

/** One Pacific day's flow legs, per pool. Dropoffs are program-only (DROPOFF_KIND_POOL). */
export interface DayLegs {
  inbound: { program: Dec; nonProgram: Dec };
  dropoffs: Dec;
  stripped: { program: Dec; nonProgram: Dec };
  sold: { program: Dec; nonProgram: Dec };
  landfilled: { program: Dec; nonProgram: Dec };
  adjustments: { program: Dec; nonProgram: Dec };
}

export function emptyLegs(): DayLegs {
  const z = () => ({ program: new D(0), nonProgram: new D(0) });
  return {
    inbound: z(),
    dropoffs: new D(0),
    stripped: z(),
    sold: z(),
    landfilled: z(),
    adjustments: z(),
  };
}

export interface PositionRow {
  day: string; // YYYY-MM-DD, Pacific
  pool: PoolKey;
  opening: Dec;
  inbound: Dec;
  dropoffs: Dec;
  stripped: Dec;
  sold: Dec;
  landfilled: Dec;
  adjustments: Dec;
  closing: Dec;
}

/** Every Pacific calendar day from `from` to `to` inclusive (YYYY-MM-DD strings). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let t = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (t <= end) {
    out.push(new Date(t).toISOString().slice(0, 10));
    t += 86_400_000;
  }
  return out;
}

/**
 * Pure. Day-by-day positions for both pools, CUMULATIVELY through
 * `computeRunningBalance` — the one function the live floor uses — so the last
 * closing is the live balance by construction, not by a second copy of the formula.
 */
export function buildDailyPositions(input: {
  anchor: PoolPair;
  days: readonly string[];
  legsByDay: ReadonlyMap<string, DayLegs>;
}): PositionRow[] {
  const rows: PositionRow[] = [];
  const acc = emptyLegs();
  let prev = computeRunningBalance({
    anchor: input.anchor,
    verifiedInbound: acc.inbound,
    dropoffUnits: acc.dropoffs,
    stripped: acc.stripped,
    wholeUnitsSold: acc.sold,
    landfilled: acc.landfilled,
    adjustments: acc.adjustments,
  });
  for (const day of input.days) {
    const l = input.legsByDay.get(day) ?? emptyLegs();
    acc.inbound = {
      program: acc.inbound.program.plus(l.inbound.program),
      nonProgram: acc.inbound.nonProgram.plus(l.inbound.nonProgram),
    };
    acc.dropoffs = acc.dropoffs.plus(l.dropoffs);
    acc.stripped = {
      program: acc.stripped.program.plus(l.stripped.program),
      nonProgram: acc.stripped.nonProgram.plus(l.stripped.nonProgram),
    };
    acc.sold = {
      program: acc.sold.program.plus(l.sold.program),
      nonProgram: acc.sold.nonProgram.plus(l.sold.nonProgram),
    };
    acc.landfilled = {
      program: acc.landfilled.program.plus(l.landfilled.program),
      nonProgram: acc.landfilled.nonProgram.plus(l.landfilled.nonProgram),
    };
    acc.adjustments = {
      program: acc.adjustments.program.plus(l.adjustments.program),
      nonProgram: acc.adjustments.nonProgram.plus(l.adjustments.nonProgram),
    };
    const now = computeRunningBalance({
      anchor: input.anchor,
      verifiedInbound: acc.inbound,
      dropoffUnits: acc.dropoffs,
      stripped: acc.stripped,
      wholeUnitsSold: acc.sold,
      landfilled: acc.landfilled,
      adjustments: acc.adjustments,
    });
    rows.push({
      day,
      pool: 'program',
      opening: prev.program,
      inbound: l.inbound.program,
      dropoffs: l.dropoffs,
      stripped: l.stripped.program,
      sold: l.sold.program,
      landfilled: l.landfilled.program,
      adjustments: l.adjustments.program,
      closing: now.program,
    });
    rows.push({
      day,
      pool: 'non_program',
      opening: prev.nonProgram,
      inbound: l.inbound.nonProgram,
      dropoffs: new D(0),
      stripped: l.stripped.nonProgram,
      sold: l.sold.nonProgram,
      landfilled: l.landfilled.nonProgram,
      adjustments: l.adjustments.nonProgram,
      closing: now.nonProgram,
    });
    prev = now;
  }
  return rows;
}

export interface PositionWindow {
  anchorSnapshotId: string | null;
  anchorPair: PoolPair;
  /** First Pacific day of the window (the day after the anchor's count day). */
  startDay: string;
  endDay: string;
  rows: PositionRow[];
}

/**
 * Read the per-day legs for the current anchor window and build the positions.
 * Uses THE anchor selector and THE window bounds `computePoolBalance` uses.
 */
export async function computePositionWindow(
  db: BalanceDb,
  siteId: string,
  now: Date = new Date(),
): Promise<PositionWindow> {
  const upper = { lte: now };
  const anchor = await selectPoolAnchor(db, siteId, upper);
  const { pair } = resolveAnchorPair(anchor);
  const { dateSince, inboundSince } = anchorFlowBounds(anchor ? anchor.snapshot_at : null);
  const dateWindow = { gt: dateSince, ...upper };
  const inboundWindow = { gte: inboundSince, ...upper };

  const [inbound, dropoffs, stripped, sold, landfilled, adjustments] = await Promise.all([
    db.inboundLoad.findMany({
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        arrived_at: inboundWindow,
      },
      select: { arrived_at: true, program_unit_count: true, non_program_unit_count: true },
    }),
    db.consumerDropoff.groupBy({
      by: ['dropoff_date', 'kind'],
      _sum: { units: true },
      where: { site_id: siteId, dropoff_date: dateWindow },
    }),
    db.processedUnitsDaily.groupBy({
      by: ['production_date'],
      _sum: { stripped_program: true, stripped_non_program: true },
      where: { site_id: siteId, production_date: dateWindow },
    }),
    db.outboundMaterial.groupBy({
      by: ['ship_date'],
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: dateWindow },
    }),
    db.landfilledUnit.groupBy({
      by: ['disposal_date'],
      _sum: { program_units: true, non_program_units: true },
      where: { site_id: siteId, disposal_date: dateWindow },
    }),
    db.inventoryPoolAdjustment.groupBy({
      by: ['day', 'from_pool', 'to_pool'],
      _sum: { units: true },
      where: { site_id: siteId, status: 'approved', day: dateWindow },
    }),
  ]);

  const legs = new Map<string, DayLegs>();
  const at = (day: string): DayLegs => {
    let l = legs.get(day);
    if (!l) {
      l = emptyLegs();
      legs.set(day, l);
    }
    return l;
  };
  for (const r of inbound) {
    if (!r.arrived_at) continue;
    const l = at(pacificDayISO(r.arrived_at));
    l.inbound.program = l.inbound.program.plus(r.program_unit_count ?? 0);
    l.inbound.nonProgram = l.inbound.nonProgram.plus(r.non_program_unit_count ?? 0);
  }
  const dropByDay = new Map<string, { kind: string; _sum: { units: number | null } }[]>();
  for (const g of dropoffs) {
    const day = dayISO(g.dropoff_date);
    const list = dropByDay.get(day) ?? [];
    list.push({ kind: g.kind, _sum: { units: g._sum.units } });
    dropByDay.set(day, list);
  }
  for (const [day, groups] of dropByDay) {
    // Refuses an untaught kind exactly as the live balance does (gate 2).
    at(day).dropoffs = at(day).dropoffs.plus(sumTaughtDropoffKinds(groups, siteId));
  }
  for (const g of stripped) {
    const l = at(dayISO(g.production_date));
    l.stripped.program = l.stripped.program.plus(g._sum.stripped_program ?? 0);
    l.stripped.nonProgram = l.stripped.nonProgram.plus(g._sum.stripped_non_program ?? 0);
  }
  for (const g of sold) {
    const l = at(dayISO(g.ship_date));
    l.sold.program = l.sold.program.plus(g._sum.program_units ?? 0);
    l.sold.nonProgram = l.sold.nonProgram.plus(g._sum.non_program_units ?? 0);
  }
  for (const g of landfilled) {
    const l = at(dayISO(g.disposal_date));
    l.landfilled.program = l.landfilled.program.plus(g._sum.program_units ?? 0);
    l.landfilled.nonProgram = l.landfilled.nonProgram.plus(g._sum.non_program_units ?? 0);
  }
  const adjByDay = new Map<string, AdjustmentGroup[]>();
  for (const g of adjustments) {
    const day = dayISO(g.day);
    const list = adjByDay.get(day) ?? [];
    list.push({ from_pool: g.from_pool, to_pool: g.to_pool, _sum: { units: g._sum.units } });
    adjByDay.set(day, list);
  }
  for (const [day, groups] of adjByDay) {
    const n = netAdjustments(groups);
    at(day).adjustments = { program: n.program, nonProgram: n.nonProgram };
  }

  const endDay = pacificDayISO(now);
  let startDay: string;
  if (anchor) {
    // Pacific day after the anchor's count day (the D-3 boundary).
    startDay = pacificDayISO(inboundSince);
  } else {
    const flowDays = [...legs.keys()].sort();
    startDay = flowDays[0] ?? endDay;
  }
  const days = startDay <= endDay ? daysBetween(startDay, endDay) : [];
  // A flow dated after "today" (Pacific) is outside the live balance's upper bound
  // only if its instant is; @db.Date keys for today are included. Nothing later.
  return {
    anchorSnapshotId: anchor?.id ?? null,
    anchorPair: pair,
    startDay,
    endDay,
    rows: buildDailyPositions({ anchor: pair, days, legsByDay: legs }),
  };
}

export interface OpenedException {
  id: string;
  pool: PoolKey;
  firstNegativeDay: string;
  shortfall: string;
}

export interface GuardResult {
  siteId: string;
  writer: PoolWriter;
  rowsWritten: number;
  opened: OpenedException[];
  negativeDays: number;
}

interface ExceptionRow {
  id: string;
  pool: PoolKey;
  status: 'open' | 'resolved';
  first_negative_day: Date;
  last_negative_day: Date | null;
}

/**
 * Pure. Which exception explains a negative day. A RESOLVED exception explains the
 * days it was resolved over (first..last) and keeps them — history is not re-pointed
 * at a later exception. Any other negative day of the pool is explained by the pool's
 * OPEN exception. Null when nothing does (the guard then opens one).
 */
export function coveringException(
  exceptions: readonly ExceptionRow[],
  pool: PoolKey,
  day: string,
): string | null {
  const resolved = exceptions.find(
    (e) =>
      e.pool === pool &&
      e.status === 'resolved' &&
      dayISO(e.first_negative_day) <= day &&
      e.last_negative_day != null &&
      day <= dayISO(e.last_negative_day),
  );
  if (resolved) return resolved.id;
  const open = exceptions.find((e) => e.pool === pool && e.status === 'open');
  return open?.id ?? null;
}

/**
 * When the SWEEP (not a writer) finds a new negative, name the door it most likely
 * came through from the first negative day's own rows. The MyMRC bridges run in the
 * standalone scraper and cannot call the guard, so their negatives are found here
 * (≤ 10 min after the hourly bridge); `sweep:processed=mymrc` tells the reader so.
 */
async function attributeSweep(
  tx: Prisma.TransactionClient,
  siteId: string,
  day: string,
): Promise<string> {
  const key = new Date(`${day}T00:00:00.000Z`);
  const [processed, inbound] = await Promise.all([
    tx.processedUnitsDaily.findFirst({
      where: { site_id: siteId, production_date: key },
      select: { source: true },
    }),
    tx.inboundLoad.groupBy({
      by: ['load_source_type'],
      where: {
        site_id: siteId,
        status: { in: [...VERIFIED_INBOUND_STATUSES] },
        arrived_at: {
          gte: pacificMidnightInstantOfDayISO(day),
          lt: pacificMidnightInstantOfDayISO(nextDay(day)),
        },
      },
    }),
  ]);
  const parts: string[] = [];
  if (processed) parts.push(`processed=${processed.source}`);
  if (inbound.length > 0)
    parts.push(
      `inbound=${inbound
        .map((g) => g.load_source_type)
        .sort()
        .join('+')}`,
    );
  return parts.length > 0 ? `sweep:${parts.join(',')}` : 'sweep';
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

function rowHash(anchorId: string | null, r: PositionRow): string {
  return createHash('sha256')
    .update(
      [
        anchorId ?? '-',
        r.day,
        r.pool,
        r.opening,
        r.inbound,
        r.dropoffs,
        r.stripped,
        r.sold,
        r.landfilled,
        r.adjustments,
        r.closing,
      ]
        .map(String)
        .join('|'),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * ADR-0143 D2 — call inside the transaction of every writer of an inventory leg,
 * AFTER the write. See the file header. Throws only on a genuine failure (a DB error,
 * an untaught drop-off kind); use `guardPoolsInTx` from writers so such a failure can
 * never roll back the external fact being recorded.
 */
export async function assertPoolsAfterWrite(
  tx: Prisma.TransactionClient,
  siteId: string,
  writer: PoolWriter,
  now: Date = new Date(),
): Promise<GuardResult> {
  await lockSiteAgainstPromotion(tx, siteId);
  const win = await computePositionWindow(tx, siteId, now);

  const exceptions = (await tx.inventoryException.findMany({
    where: { site_id: siteId },
    select: {
      id: true,
      pool: true,
      status: true,
      first_negative_day: true,
      last_negative_day: true,
    },
    orderBy: { opened_at: 'desc' },
  })) as ExceptionRow[];

  const opened: OpenedException[] = [];
  const linked = new Map<string, string | null>(); // `${day}|${pool}` → exception id
  let negativeDays = 0;
  for (const pool of POOLS) {
    const rows = win.rows.filter((r) => r.pool === pool);
    const negative = rows.filter((r) => r.closing.isNegative());
    negativeDays += negative.length;
    const uncovered = negative.filter((r) => coveringException(exceptions, pool, r.day) == null);
    if (uncovered.length > 0) {
      const first = uncovered[0]!;
      const openedBy = writer === 'sweep' ? await attributeSweep(tx, siteId, first.day) : writer;
      const deepest = uncovered.reduce(
        (m, r) => (r.closing.lessThan(m) ? r.closing : m),
        first.closing,
      );
      const created = await tx.inventoryException.create({
        data: {
          site_id: siteId,
          pool,
          first_negative_day: new Date(`${first.day}T00:00:00.000Z`),
          opened_by_writer: openedBy,
          shortfall: deepest.negated(),
          legs: {
            day: first.day,
            opening: first.opening.toString(),
            inbound: first.inbound.toString(),
            dropoffs: first.dropoffs.toString(),
            stripped: first.stripped.toString(),
            sold: first.sold.toString(),
            landfilled: first.landfilled.toString(),
            adjustments: first.adjustments.toString(),
            closing: first.closing.toString(),
            writer: openedBy,
            anchor_snapshot_id: win.anchorSnapshotId,
          },
        },
        select: {
          id: true,
          pool: true,
          status: true,
          first_negative_day: true,
          last_negative_day: true,
        },
      });
      exceptions.unshift(created as ExceptionRow);
      opened.push({
        id: created.id,
        pool,
        firstNegativeDay: first.day,
        shortfall: deepest.negated().toString(),
      });
      // The audit trail names the opening; the exception row is its own record too.
      await tx.auditLog.create({
        data: {
          actor_user_id: null,
          actor_label: `system:pool-guard:${openedBy}`,
          action: 'insert',
          table_name: 'inventory_exceptions',
          row_id: created.id,
          after: {
            site_id: siteId,
            pool,
            first_negative_day: first.day,
            shortfall: deepest.negated().toString(),
            writer: openedBy,
          },
        },
      });
    }
    for (const r of negative)
      linked.set(`${r.day}|${pool}`, coveringException(exceptions, pool, r.day));
  }

  // Diff against what is stored for this window; write only what changed.
  const startKey = new Date(`${win.startDay}T00:00:00.000Z`);
  const existing = await tx.inventoryPositionDaily.findMany({
    where: { site_id: siteId, day: { gte: startKey } },
    select: { day: true, pool: true, inputs_hash: true, exception_id: true },
  });
  const have = new Map(existing.map((e) => [`${dayISO(e.day)}|${e.pool}`, e]));
  const want = new Set<string>();
  let rowsWritten = 0;
  const computedAt = now;
  const toCreate: Prisma.InventoryPositionDailyCreateManyInput[] = [];
  for (const r of win.rows) {
    const key = `${r.day}|${r.pool}`;
    want.add(key);
    const hash = rowHash(win.anchorSnapshotId, r);
    const exceptionId = r.closing.isNegative() ? (linked.get(key) ?? null) : null;
    const cur = have.get(key);
    if (cur && cur.inputs_hash === hash && cur.exception_id === exceptionId) continue;
    const data = {
      anchor_snapshot_id: win.anchorSnapshotId,
      opening: r.opening,
      inbound: r.inbound,
      dropoffs: r.dropoffs,
      stripped: r.stripped,
      sold: r.sold,
      landfilled: r.landfilled,
      adjustments: r.adjustments,
      closing: r.closing,
      exception_id: exceptionId,
      inputs_hash: hash,
      computed_at: computedAt,
    };
    const day = new Date(`${r.day}T00:00:00.000Z`);
    if (cur) {
      await tx.inventoryPositionDaily.update({
        where: { site_id_day_pool: { site_id: siteId, day, pool: r.pool } },
        data,
      });
    } else {
      toCreate.push({ site_id: siteId, day, pool: r.pool, ...data });
    }
    rowsWritten += 1;
  }
  // One statement for the first build of a window (~2 rows x days since the count).
  if (toCreate.length > 0) await tx.inventoryPositionDaily.createMany({ data: toCreate });
  // Rows inside this window that the window no longer produces (a later count moved
  // the anchor forward, or a backdated anchor shortened the window). This table is a
  // materialisation, not a record — the records are the legs and the exceptions.
  const stale = existing.filter((e) => !want.has(`${dayISO(e.day)}|${e.pool}`));
  for (const e of stale) {
    await tx.inventoryPositionDaily.delete({
      where: { site_id_day_pool: { site_id: siteId, day: e.day, pool: e.pool } },
    });
  }

  // `computed_at` means "last VERIFIED", not "last changed". Every row of the window
  // was just recomputed and found equal or rewritten, so stamp them all in one
  // statement. Without this, a quiet day left computed_at hours old and the repair
  // script's freshness gate refused even though the sweep had run 2 minutes earlier
  // (Ryan, 2026-10-29: "daily positions are 33 min old" after a sweep at :x8).
  if (win.rows.length > 0) {
    await tx.inventoryPositionDaily.updateMany({
      where: { site_id: siteId, day: { gte: startKey }, computed_at: { lt: computedAt } },
      data: { computed_at: computedAt },
    });
  }

  return { siteId, writer, rowsWritten, opened, negativeDays };
}

/**
 * The form every WRITER uses. The guard runs inside a SAVEPOINT and its deferred
 * constraint is forced immediate there, so a failure in the guard rolls back only
 * the guard's own rows — never the external fact the writer is recording (D2: Vision
 * does not refuse MRC data). A swallowed failure is logged loudly, and the 10-minute
 * `/api/internal/inventory/pool-check` sweep re-runs the guard on its own
 * transaction, where a failure is NOT swallowed.
 */
export async function guardPoolsInTx(
  tx: Prisma.TransactionClient,
  siteId: string,
  writer: PoolWriter,
  now: Date = new Date(),
): Promise<GuardResult | null> {
  let savepoint = false;
  try {
    await tx.$executeRawUnsafe('SAVEPOINT adr0143_pool_guard');
    savepoint = true;
    const result = await assertPoolsAfterWrite(tx, siteId, writer, now);
    // Force the deferred D3 check NOW, inside the savepoint, so a defect in this
    // module surfaces here (and is rolled back here) instead of failing the
    // writer's COMMIT.
    await tx.$executeRawUnsafe(
      'SET CONSTRAINTS "inventory_position_daily_explained_trg" IMMEDIATE',
    );
    await tx.$executeRawUnsafe('SET CONSTRAINTS "inventory_position_daily_explained_trg" DEFERRED');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT adr0143_pool_guard');
    return result;
  } catch (err) {
    if (savepoint) {
      try {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT adr0143_pool_guard');
      } catch (rollbackErr) {
        log.error({ err: rollbackErr, siteId, writer }, '[pool-guard] savepoint rollback failed');
        throw rollbackErr; // the transaction is unusable; let the writer see it
      }
    }
    log.error(
      { err, siteId, writer, op: 'inventory.pool_guard.failed' },
      '[pool-guard] ADR-0143 post-write pool check FAILED; the write stands, the 10-min sweep retries',
    );
    return null;
  }
}

/** The sweep / bridge form: its own transaction, failures propagate. */
export async function runPoolCheck(
  siteId: string,
  writer: PoolWriter,
  now: Date = new Date(),
): Promise<GuardResult> {
  return prisma.$transaction((tx) => assertPoolsAfterWrite(tx, siteId, writer, now), {
    timeout: 60_000,
  });
}
