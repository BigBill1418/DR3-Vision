#!/usr/bin/env node
// ADR-0143 plan item 8 / §5 R-B — PROPOSE the repair of Woodland's program pool.
//
// Bill's decisions, 2026-10-29: the Woodland floor is physically MIXED (B3), so a
// split count is impossible and the repair is the ADJUSTMENT path (R-B), not a count.
// "a non program unit is always non program - the total is what matters not
// necessarily that specific unit" (B2): the adjustment keeps the TOTAL constant and is
// a bookkeeping correction of the floor split only. Units are NOT reclassified for
// MRC reporting, and nothing here touches processed_units_daily, inbound_loads or the
// 09-14 count (plan §5: never clamp, never edit MRC's record, never void the count).
//
// What it writes, with --apply only: ONE `inventory_pool_adjustments` row in status
// `proposed`, dated 2026-10-08 (the last day the residue moved), from non_program to
// program, units = the program shortfall (expected 247), linked to the open Woodland
// program exception, plus its audit row — in one transaction. A proposal moves
// NOTHING. Bill approves it in the app (four-eyes: the proposer is the system label
// below, so Bill — a different identity — can approve; the DB CHECK refuses an
// approver equal to the proposer).
//
// It reads the pools at the close of the LAST CLOSED Pacific day (see
// readLastClosedDay), never the live mid-day figure. It refuses (exit 2) when: that
// day's program pool is not negative; the shortfall is
// not the expected number (pass --expect-units=N after reading why); the non-program
// pool would go below zero; there is no open program exception (run the pool-check
// sweep first); or an adjustment is already proposed/approved for that exception.
//
// RUN ONLY AFTER: the ADR-0143 migration and app are deployed, the pool-check sweep
// has opened the Woodland program exception, and Bill has said to propose it.
//   docker exec dr3-vision-app node scripts/propose-woodland-pool-repair.mjs            # dry run
//   docker exec dr3-vision-app node scripts/propose-woodland-pool-repair.mjs --apply    # propose
// Output carries counts and ids only.

import { PrismaClient } from '@prisma/client';

export const PROPOSER = 'system:adr0143-repair';
export const REASON =
  'ADR-0143 R-B (Bill 2026-10-29, B2/B3): non-program units processed as program 09-15..10-08 ' +
  '(17 of 19 days non-program processed = 0). Floor is mixed, so the split is corrected by adjustment, ' +
  'not a count. Total unchanged; no MRC reclassification.';

/** Parse argv. Pure. */
export function parseArgs(argv) {
  const opts = { apply: false, siteCode: 'woodland', day: '2026-10-08', expectUnits: 247 };
  for (const a of argv) {
    if (a === '--apply') opts.apply = true;
    else if (a.startsWith('--site=')) opts.siteCode = a.slice(7);
    else if (a.startsWith('--day=')) opts.day = a.slice(6);
    else if (a.startsWith('--expect-units=')) opts.expectUnits = Number(a.slice(15));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.day)) throw new Error(`--day must be YYYY-MM-DD, got ${opts.day}`);
  if (!(opts.expectUnits > 0)) throw new Error('--expect-units must be positive');
  return opts;
}

export class RepairRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'RepairRefused';
  }
}

/**
 * Pure. From the last closed day's pools (Decimal strings, positions table),
 * the units to move and the resulting pools. The total cannot change: units leave
 * non-program and enter program.
 */
export function planRepair(floor, expectUnits) {
  const program = Number(floor.program);
  const nonProgram = Number(floor.nonProgram);
  const total = Number(floor.total);
  if (![program, nonProgram, total].every(Number.isFinite)) throw new RepairRefused('positions returned non-numbers');
  if (Math.abs(program + nonProgram - total) > 1e-9) throw new RepairRefused('floor pools do not sum to the total');
  if (!(program < 0)) throw new RepairRefused(`program pool is not negative (${program}); nothing to repair`);
  const units = -program;
  if (units !== expectUnits) {
    throw new RepairRefused(
      `program shortfall is ${units}, expected ${expectUnits}. The pool moved since ADR-0143 was measured; ` +
        `read the exception page, then re-run with --expect-units=${units} if that is still the right repair.`,
    );
  }
  const after = { program: program + units, nonProgram: nonProgram - units, total };
  if (after.nonProgram < 0) throw new RepairRefused('non-program pool would go below zero; not a split repair');
  return { units, before: { program, nonProgram, total }, after };
}

/** The Pacific calendar day (YYYY-MM-DD) of an instant. Pure. */
export function pacificDay(instant) {
  return instant.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

/** How fresh the positions must be: two sweeps (the sweep runs every 10 minutes). */
export const POSITIONS_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * The pools at the close of the LAST CLOSED Pacific day (the day before `now`),
 * read from `inventory_position_daily` — the ADR-0143 materialisation of the ONE
 * balance computation, bucketed by Pacific day.
 *
 * Why not the live floor: `onHand(site, now)` includes TODAY's partial day. On
 * 2026-10-29 the 385-unit intake posted at ~10:01 PDT before that day's processed
 * figure, so the live program pool read +138 while every closed day since 10-16
 * closed negative (10-28: -247) — and the first version of this script refused.
 * A repair decision must not depend on the time of day it is run.
 */
export async function readLastClosedDay(prisma, siteId, now = new Date()) {
  const today = pacificDay(now);
  const rows = await prisma.inventoryPositionDaily.findMany({
    where: { site_id: siteId, day: { lt: new Date(`${today}T00:00:00.000Z`) } },
    orderBy: { day: 'desc' },
    take: 2,
    select: { day: true, pool: true, closing: true, computed_at: true },
  });
  const day = rows[0]?.day.toISOString().slice(0, 10);
  const program = rows.find((r) => r.pool === 'program' && r.day.toISOString().slice(0, 10) === day);
  const nonProgram = rows.find((r) => r.pool === 'non_program' && r.day.toISOString().slice(0, 10) === day);
  if (!day || !program || !nonProgram) {
    throw new RepairRefused('no daily positions for a closed day; run /api/internal/inventory/pool-check first');
  }
  const newest = await prisma.inventoryPositionDaily.aggregate({
    where: { site_id: siteId },
    _max: { computed_at: true },
  });
  const age = now.getTime() - (newest._max.computed_at?.getTime() ?? 0);
  if (age > POSITIONS_MAX_AGE_MS) {
    throw new RepairRefused(
      `daily positions are ${Math.round(age / 60000)} min old; run /api/internal/inventory/pool-check first`,
    );
  }
  const p = program.closing.toString();
  const n = nonProgram.closing.toString();
  // Sum in tenths: the columns are Decimal(10,1), and float addition can drift.
  const total = (Math.round(Number(p) * 10) + Math.round(Number(n) * 10)) / 10;
  return { day, program: p, nonProgram: n, total: String(total) };
}

/**
 * Plan (and with apply, propose) the repair, from the LAST CLOSED day's pools
 * (`readLastClosedDay`; injectable for tests). Returns counts and ids only.
 */
export async function proposeRepair(prisma, opts, readClosed = readLastClosedDay, now = new Date()) {
  const site = await prisma.site.findFirst({ where: { code: opts.siteCode }, select: { id: true, code: true } });
  if (!site) throw new RepairRefused(`unknown site ${opts.siteCode}`);
  const floor = await readClosed(prisma, site.id, now);
  const plan = planRepair(floor, opts.expectUnits);

  const exception = await prisma.inventoryException.findFirst({
    where: { site_id: site.id, pool: 'program', status: 'open' },
    select: { id: true, first_negative_day: true },
  });
  if (!exception) {
    throw new RepairRefused('no open program inventory exception for this site; run /api/internal/inventory/pool-check first');
  }
  if (opts.day < exception.first_negative_day.toISOString().slice(0, 10)) {
    throw new RepairRefused(`--day ${opts.day} is before the exception's first negative day`);
  }
  const existing = await prisma.inventoryPoolAdjustment.count({
    where: { exception_id: exception.id, status: { in: ['proposed', 'approved'] } },
  });
  if (existing > 0) throw new RepairRefused(`an adjustment is already proposed or approved for exception ${exception.id}`);

  const summary = {
    site: site.code,
    exceptionId: exception.id,
    day: opts.day,
    measuredOnClosedDay: floor.day,
    ...plan,
    applied: false,
    adjustmentId: null,
  };
  if (!opts.apply) return summary;

  const adjustmentId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`dr3:promotion:${site.id}`})::bigint)`;
    const row = await tx.inventoryPoolAdjustment.create({
      data: {
        site_id: site.id,
        day: new Date(`${opts.day}T00:00:00.000Z`),
        from_pool: 'non_program',
        to_pool: 'program',
        units: String(plan.units),
        reason: REASON,
        exception_id: exception.id,
        proposed_by: PROPOSER,
      },
      select: { id: true },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: null,
        actor_label: PROPOSER,
        action: 'insert',
        table_name: 'inventory_pool_adjustments',
        row_id: row.id,
        after: { exception_id: exception.id, day: opts.day, from_pool: 'non_program', to_pool: 'program', units: String(plan.units), status: 'proposed' },
      },
    });
    return row.id;
  });
  return { ...summary, applied: true, adjustmentId };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const out = await proposeRepair(prisma, opts);
    console.log(JSON.stringify({ mode: opts.apply ? 'apply' : 'dry-run', ...out }));
  } catch (err) {
    if (err instanceof RepairRefused) {
      console.error(`REFUSED: ${err.message}`);
      process.exitCode = 2;
    } else throw err;
  } finally {
    await prisma.$disconnect();
  }
}

const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  main().catch((err) => {
    console.error(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
