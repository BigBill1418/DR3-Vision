// ADR-0143 item 8 — the repair script against a REAL Postgres, on a Woodland-shaped
// TEST site (never production). Proves: dry run writes nothing; --apply writes ONE
// proposed row that moves nothing; a second run refuses; Bill's approval (a
// different identity) resolves the exception with program 0 and the total unchanged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { dayKeyUTCFromISO, pacificMidnightInstantOfDayISO } from '@/lib/time';
import {
  proposeRepair,
  readLastClosedDay,
  PROPOSER,
} from '../../../scripts/propose-woodland-pool-repair.mjs';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error('woodland-repair.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
const NS = `adr0143r-${Date.now().toString(36)}`;
const SITE = `${NS}-site`;
const CODE = `${NS}-woodland`;
const BILL = `${NS}-bill`;
const D = Prisma.Decimal;

describe.skipIf(!REAL_DB)('ADR-0143 Woodland repair script — real Postgres, test site', () => {
  let probe: (code: string) => Promise<{ program: string; nonProgram: string; total: string }>;

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: REAL_DB as string } } });
    const rb = await import('./running-balance');
    const guard = await import('./pool-guard');
    probe = async () => {
      // The LIVE floor (includes today's partial day) — for contrast with the closed day.
      const b = await rb.computePoolBalance(db, SITE, { lte: new Date() });
      return {
        program: b.program.toString(),
        nonProgram: b.nonProgram.toString(),
        total: b.total.toString(),
      };
    };
    await db.user.upsert({
      where: { id: BILL },
      update: {},
      create: { id: BILL, name: BILL, role: 'admin' },
    });
    await db.site.create({
      data: {
        id: SITE,
        code: CODE,
        name: 'Woodland-shaped probe',
        jurisdiction: 'california',
        mrc_program_code: 'MRC-CA-TEST',
        customer_service_open: '08:00',
        customer_service_close: '16:00',
        recycling_rate_target_pct: 75,
        records_retention_years: 4,
        inbound_processing_deadline_days: 45,
        mymrc_inbound_submission_business_days: 3,
        mymrc_processed_submission_business_days: 1,
        dock_sla_minutes: 60,
        reconciliation_target_pct: 97,
        billing_cadence: 'mid_month_and_end',
      },
    });
    // The measured end state: anchor 128/757, then flows that leave -247 / +644 / 397.
    await db.siteInventorySnapshot.create({
      data: {
        site_id: SITE,
        snapshot_at: pacificMidnightInstantOfDayISO('2026-09-14'),
        snapshot_kind: 'physical',
        source: 'manual',
        units_total: 885,
        units_in_processing: 0,
        program_units: 128,
        non_program_units: 757,
        pool_attribution: 'measured',
      },
    });
    await db.inboundLoad.create({
      data: {
        site_id: SITE,
        status: 'verified',
        load_source_type: 'paper_bulk',
        arrived_at: new Date(pacificMidnightInstantOfDayISO('2026-09-15').getTime() + 9 * 3600_000),
        total_units: 1000,
        program_unit_count: 600,
        non_program_unit_count: 400,
      },
    });
    await db.processedUnitsDaily.create({
      data: {
        site_id: SITE,
        production_date: dayKeyUTCFromISO('2026-09-17'),
        stripped_program: new D(975),
        stripped_non_program: new D(513),
        source: 'import',
      },
    });
    await guard.runPoolCheck(SITE, 'workbook-sync');
  });
  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('dry run → apply → refuse again → Bill approves → closed-day program 0, total 397', async () => {
    expect(await probe(CODE)).toEqual({ program: '-247', nonProgram: '644', total: '397' });
    const opts = { apply: false, siteCode: CODE, day: '2026-10-08', expectUnits: 247 };

    const dry = await proposeRepair(db, opts);
    expect(dry).toMatchObject({
      applied: false,
      adjustmentId: null,
      units: 247,
      after: { program: 0, nonProgram: 397, total: 397 },
    });
    expect(await db.inventoryPoolAdjustment.count({ where: { site_id: SITE } })).toBe(0);

    const applied = await proposeRepair(db, { ...opts, apply: true });
    expect(applied.applied).toBe(true);
    const row = await db.inventoryPoolAdjustment.findUnique({
      where: { id: applied.adjustmentId },
    });
    expect(row).toMatchObject({
      status: 'proposed',
      proposed_by: PROPOSER,
      from_pool: 'non_program',
      to_pool: 'program',
    });
    expect(row.units.toString()).toBe('247');
    expect(row.day.toISOString().slice(0, 10)).toBe('2026-10-08');
    // A proposal moves nothing.
    expect((await probe(CODE)).program).toBe('-247');

    await expect(proposeRepair(db, { ...opts, apply: true })).rejects.toThrowError(
      /already proposed/,
    );

    const svc = await import('./exception-service');
    const r = await svc.decidePoolAdjustment({
      siteId: SITE,
      adjustmentId: applied.adjustmentId!,
      decision: 'approve',
      actorUserId: BILL,
    });
    expect(r.exceptionResolved).toBe(true);
    expect(await probe(CODE)).toEqual({ program: '0', nonProgram: '397', total: '397' });
    const closed = await readLastClosedDay(db, SITE);
    expect([closed.program, closed.nonProgram, closed.total]).toEqual(['0', '397', '397']);
  });
});

describe.skipIf(!REAL_DB)('ADR-0143 repair — mid-day: intake posted, processed not yet', () => {
  const SITE2 = `${NS}-site-midday`;
  const CODE2 = `${NS}-woodland-midday`;

  it('2026-10-29 shape: live program is +138 at 10 AM, the last CLOSED day is -247 → still proposes 247', async () => {
    const guard = await import('./pool-guard');
    const rb = await import('./running-balance');
    await db.site.create({
      data: {
        id: SITE2,
        code: CODE2,
        name: 'Woodland-shaped probe (mid-day)',
        jurisdiction: 'california',
        mrc_program_code: 'MRC-CA-TEST',
        customer_service_open: '08:00',
        customer_service_close: '16:00',
        recycling_rate_target_pct: 75,
        records_retention_years: 4,
        inbound_processing_deadline_days: 45,
        mymrc_inbound_submission_business_days: 3,
        mymrc_processed_submission_business_days: 1,
        dock_sla_minutes: 60,
        reconciliation_target_pct: 97,
        billing_cadence: 'mid_month_and_end',
      },
    });
    await db.siteInventorySnapshot.create({
      data: {
        site_id: SITE2,
        snapshot_at: pacificMidnightInstantOfDayISO('2026-09-14'),
        snapshot_kind: 'physical',
        source: 'manual',
        units_total: 885,
        units_in_processing: 0,
        program_units: 128,
        non_program_units: 757,
        pool_attribution: 'measured',
      },
    });
    await db.inboundLoad.create({
      data: {
        site_id: SITE2,
        status: 'verified',
        load_source_type: 'paper_bulk',
        arrived_at: new Date(pacificMidnightInstantOfDayISO('2026-09-15').getTime() + 9 * 3600_000),
        total_units: 1000,
        program_unit_count: 600,
        non_program_unit_count: 400,
      },
    });
    await db.processedUnitsDaily.create({
      data: {
        site_id: SITE2,
        production_date: dayKeyUTCFromISO('2026-09-17'),
        stripped_program: new D(975),
        stripped_non_program: new D(513),
        source: 'import',
      },
    });
    // TODAY: the intake posts (385 program) before the day's processed figure exists.
    await db.inboundLoad.create({
      data: {
        site_id: SITE2,
        status: 'verified',
        load_source_type: 'mymrc_haul',
        arrived_at: new Date(Date.now() - 1000),
        total_units: 385,
        program_unit_count: 385,
        non_program_unit_count: 0,
      },
    });
    await guard.runPoolCheck(SITE2, 'sweep');

    const live = await rb.computePoolBalance(db, SITE2, { lte: new Date() });
    expect(live.program.toString()).toBe('138'); // what the first version of the script read, and refused on
    const closed = await readLastClosedDay(db, SITE2);
    expect([closed.program, closed.nonProgram, closed.total]).toEqual(['-247', '644', '397']);

    const plan = await proposeRepair(db, {
      apply: false,
      siteCode: CODE2,
      day: '2026-10-08',
      expectUnits: 247,
    });
    expect(plan).toMatchObject({
      units: 247,
      measuredOnClosedDay: closed.day,
      after: { program: 0, total: 397 },
    });
  });

  it('refuses on stale positions instead of guessing', async () => {
    const later = new Date(Date.now() + 2 * 3600_000);
    await expect(readLastClosedDay(db, SITE2, later)).rejects.toThrowError(
      /positions are \d+ min old/,
    );
  });
});
