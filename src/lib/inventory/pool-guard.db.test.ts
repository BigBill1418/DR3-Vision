// ADR-0143 — the pool guard, the three tables and the D3 trigger against a REAL
// Postgres 16 (CI DB lane: `npx vitest run --no-file-parallelism db.test.ts`).
//
// Tests T5–T11 of docs/plans/2026-10-29-inventory-negative-permanent-fix.md §4.
// Every test uses its OWN site id: the exception and adjustment tables are
// append-only (a trigger refuses DELETE), so isolation is by namespace, not cleanup.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { dayKeyUTCFromISO, pacificMidnightInstantOfDayISO } from '@/lib/time';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error('pool-guard.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL');
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
let guard: typeof import('./pool-guard');
let rb: typeof import('./running-balance');
let upsert: typeof import('@/lib/workbook-sync/upsert');

const NS = `adr0143-${Date.now().toString(36)}`;
const D = Prisma.Decimal;
let seq = 0;
const PROPOSER = `${NS}-mgr`;
const APPROVER = `${NS}-bill`;

/** Pacific day → the instant the guard uses as "now" (noon PT that day). */
const noonPT = (day: string) =>
  new Date(pacificMidnightInstantOfDayISO(day).getTime() + 12 * 3600_000);

async function newSite(): Promise<string> {
  seq += 1;
  const id = `${NS}-site-${seq}`;
  await db.site.create({
    data: {
      id,
      code: `${NS}-${seq}`,
      name: `ADR-0143 probe ${seq}`,
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
  return id;
}

/** The measured Woodland anchor shape: 2026-09-14, 885 = 128 program / 757 non-program. */
async function anchor(site: string, day = '2026-09-14', program = 128, nonProgram = 757) {
  await db.siteInventorySnapshot.create({
    data: {
      site_id: site,
      snapshot_at: pacificMidnightInstantOfDayISO(day),
      snapshot_kind: 'physical',
      source: 'manual',
      units_total: program + nonProgram,
      units_in_processing: 0,
      program_units: program,
      non_program_units: nonProgram,
      pool_attribution: 'measured',
    },
  });
}

async function inbound(site: string, day: string, program: number, nonProgram: number) {
  await db.inboundLoad.create({
    data: {
      site_id: site,
      status: 'verified',
      load_source_type: 'paper_bulk',
      arrived_at: new Date(pacificMidnightInstantOfDayISO(day).getTime() + 9 * 3600_000),
      total_units: program + nonProgram,
      program_unit_count: program,
      non_program_unit_count: nonProgram,
    },
  });
}

async function dropoff(site: string, day: string, units: number) {
  await db.consumerDropoff.create({
    data: {
      site_id: site,
      dropoff_date: dayKeyUTCFromISO(day),
      kind: 'unpaid',
      units,
      person_name: 'Test Probe',
    },
  });
}

/** The real Woodland door: the workbook sync's guarded write, in one transaction. */
async function workbookDay(
  site: string,
  day: string,
  program: number,
  nonProgram: number,
  now: Date,
) {
  return db
    .$transaction((tx: any) =>
      upsert.upsertDailyProductionGuarded({
        db: tx,
        siteId: site,
        syncRunId: `${NS}-run`,
        rows: [
          {
            productionDate: day,
            strippedProgram: program,
            strippedNonProgram: nonProgram,
            materialTicketNumber: null,
            savedUnits: null,
          } as any,
        ],
      }),
    )
    .then((r: any) => {
      void now;
      return r;
    });
}

/** Woodland 09-15 → 09-17, rebuilt from the ADR-0143 trajectory: program < 0 on 09-17. */
async function woodlandSeptember(site: string) {
  await anchor(site);
  await inbound(site, '2026-09-15', 800, 50);
  await inbound(site, '2026-09-16', 700, 60);
  await inbound(site, '2026-09-17', 769, 216);
  await dropoff(site, '2026-09-17', 14);
}

describe.skipIf(!REAL_DB)('ADR-0143 pool guard — real Postgres', () => {
  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    db = new PrismaClient({ datasources: { db: { url: REAL_DB as string } } });
    guard = await import('./pool-guard');
    rb = await import('./running-balance');
    upsert = await import('@/lib/workbook-sync/upsert');
    for (const id of [PROPOSER, APPROVER]) {
      await db.user.upsert({
        where: { id },
        update: {},
        create: { id, name: id, role: 'manager' },
      });
    }
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ── T5 — the database refuses a silent negative ───────────────────────────
  describe('T5 — inventory_position_daily trigger', () => {
    const row = (site: string, closing: number, exception_id: string | null = null) => ({
      site_id: site,
      day: dayKeyUTCFromISO('2026-10-01'),
      pool: 'program',
      opening: new D(closing),
      inbound: new D(0),
      dropoffs: new D(0),
      stripped: new D(0),
      sold: new D(0),
      landfilled: new D(0),
      adjustments: new D(0),
      closing: new D(closing),
      exception_id,
      inputs_hash: 'h',
      computed_at: new Date(),
    });

    it('refuses closing = -1 with no exception, at commit', async () => {
      const site = await newSite();
      await expect(db.inventoryPositionDaily.create({ data: row(site, -1) })).rejects.toThrow(
        /negative with no inventory exception/,
      );
      expect(await db.inventoryPositionDaily.count({ where: { site_id: site } })).toBe(0);
    });

    it('accepts closing = -1 that names an exception of the same site and pool', async () => {
      const site = await newSite();
      const ex = await db.inventoryException.create({
        data: {
          site_id: site,
          pool: 'program',
          first_negative_day: dayKeyUTCFromISO('2026-10-01'),
          opened_by_writer: 'sweep',
          shortfall: new D(1),
          legs: {},
        },
      });
      await db.inventoryPositionDaily.create({ data: row(site, -1, ex.id) });
      expect(await db.inventoryPositionDaily.count({ where: { site_id: site } })).toBe(1);
    });

    it("refuses an exception from ANOTHER pool (the explanation must be this pool's)", async () => {
      const site = await newSite();
      const ex = await db.inventoryException.create({
        data: {
          site_id: site,
          pool: 'non_program',
          first_negative_day: dayKeyUTCFromISO('2026-10-01'),
          opened_by_writer: 'sweep',
          shortfall: new D(1),
          legs: {},
        },
      });
      await expect(
        db.inventoryPositionDaily.create({ data: row(site, -1, ex.id) }),
      ).rejects.toThrow(/does not belong to this site and pool/);
    });

    it('refuses a row whose closing does not follow from its legs', async () => {
      const site = await newSite();
      await expect(
        db.inventoryPositionDaily.create({ data: { ...row(site, 5), opening: new D(4) } }),
      ).rejects.toThrow(/arith_chk/);
    });

    it('an exception cannot be deleted, and its opening facts cannot change', async () => {
      const site = await newSite();
      const ex = await db.inventoryException.create({
        data: {
          site_id: site,
          pool: 'program',
          first_negative_day: dayKeyUTCFromISO('2026-10-01'),
          opened_by_writer: 'sweep',
          shortfall: new D(3),
          legs: {},
        },
      });
      await expect(db.inventoryException.delete({ where: { id: ex.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        db.inventoryException.update({ where: { id: ex.id }, data: { shortfall: new D(1) } }),
      ).rejects.toThrow(/immutable/);
      // A second OPEN exception for the same site + pool is refused (one open per pool).
      await expect(
        db.inventoryException.create({
          data: {
            site_id: site,
            pool: 'program',
            first_negative_day: dayKeyUTCFromISO('2026-10-02'),
            opened_by_writer: 'sweep',
            shortfall: new D(1),
            legs: {},
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ── T6 — an adjustment moves the split, never the total ──────────────────
  describe('T6 — inventory_pool_adjustments', () => {
    const adj = (site: string, over: Record<string, unknown> = {}) => ({
      site_id: site,
      day: dayKeyUTCFromISO('2026-10-08'),
      from_pool: 'non_program',
      to_pool: 'program',
      units: new D(247),
      reason: 'ADR-0143 test: non-program processed as program',
      proposed_by: PROPOSER,
      ...over,
    });

    it('CHECKs: same pool, zero units, empty reason, self-approval are all refused', async () => {
      const site = await newSite();
      await expect(
        db.inventoryPoolAdjustment.create({ data: adj(site, { to_pool: 'non_program' }) }),
      ).rejects.toThrow(/pools_chk/);
      await expect(
        db.inventoryPoolAdjustment.create({ data: adj(site, { units: new D(0) }) }),
      ).rejects.toThrow(/units_chk/);
      await expect(
        db.inventoryPoolAdjustment.create({ data: adj(site, { reason: '   ' }) }),
      ).rejects.toThrow(/reason_chk/);
      const a = await db.inventoryPoolAdjustment.create({ data: adj(site) });
      await expect(
        db.inventoryPoolAdjustment.update({
          where: { id: a.id },
          data: { status: 'approved', approved_by: PROPOSER, approved_at: new Date() },
        }),
      ).rejects.toThrow(/four_eyes_chk/);
    });

    it('append-only: no delete, no edit of the amount, a decided row is final', async () => {
      const site = await newSite();
      const a = await db.inventoryPoolAdjustment.create({ data: adj(site) });
      await expect(db.inventoryPoolAdjustment.delete({ where: { id: a.id } })).rejects.toThrow(
        /append-only/,
      );
      await expect(
        db.inventoryPoolAdjustment.update({ where: { id: a.id }, data: { units: new D(1) } }),
      ).rejects.toThrow(/only the decision may change/);
      await db.inventoryPoolAdjustment.update({
        where: { id: a.id },
        data: { status: 'approved', approved_by: APPROVER, approved_at: new Date() },
      });
      await expect(
        db.inventoryPoolAdjustment.update({
          where: { id: a.id },
          data: {
            status: 'rejected',
            approved_by: null,
            approved_at: null,
            rejected_by: APPROVER,
            rejected_at: new Date(),
          },
        }),
      ).rejects.toThrow(/final/);
    });

    it('Woodland -247 → 0: an approved adjustment moves the pools, the total is unchanged to the unit', async () => {
      const site = await newSite();
      await woodlandSeptember(site);
      for (const [day, p] of [
        ['2026-09-15', 800],
        ['2026-09-16', 690],
        ['2026-09-17', 1172],
      ] as const) {
        await db.processedUnitsDaily.create({
          data: {
            site_id: site,
            production_date: dayKeyUTCFromISO(day),
            stripped_program: new D(p),
            stripped_non_program: new D(0),
            source: 'import',
          },
        });
      }
      const asOf = noonPT('2026-10-29');
      const before = await rb.computePoolBalance(db, site, { lte: asOf });
      // A PROPOSED adjustment moves nothing.
      const a = await db.inventoryPoolAdjustment.create({
        data: adj(site, { units: before.program.negated() }),
      });
      const proposed = await rb.computePoolBalance(db, site, { lte: asOf });
      expect(proposed.program.toString()).toBe(before.program.toString());
      await db.inventoryPoolAdjustment.update({
        where: { id: a.id },
        data: { status: 'approved', approved_by: APPROVER, approved_at: new Date() },
      });
      const after = await rb.computePoolBalance(db, site, { lte: asOf });
      expect(before.program.isNegative()).toBe(true);
      expect(after.program.toString()).toBe('0');
      expect(after.total.toString()).toBe(before.total.toString());
      expect(after.nonProgram.toString()).toBe(before.nonProgram.plus(before.program).toString());
    });

    it('an adjustment dated on/before the anchor day is inside the count and does not move the floor', async () => {
      const site = await newSite();
      await anchor(site, '2026-10-10', 10, 10);
      await db.inventoryPoolAdjustment.create({
        data: {
          ...adj(site, { day: dayKeyUTCFromISO('2026-10-10'), units: new D(5) }),
          status: 'approved',
          approved_by: APPROVER,
          approved_at: new Date(),
        },
      });
      const b = await rb.computePoolBalance(db, site, { lte: noonPT('2026-10-20') });
      expect(b.program.toString()).toBe('10');
    });
  });

  // ── T7 — ONE computation: the positions end where computePoolBalance is ──
  it('T7 — the last daily closing equals computePoolBalance, adjustment present', async () => {
    const site = await newSite();
    await woodlandSeptember(site);
    for (const [day, p, np] of [
      ['2026-09-15', 800, 0],
      ['2026-09-16', 690, 0],
      ['2026-09-17', 1172, 0],
      ['2026-09-20', 300, 40.5],
    ] as const) {
      await db.processedUnitsDaily.create({
        data: {
          site_id: site,
          production_date: dayKeyUTCFromISO(day),
          stripped_program: new D(p),
          stripped_non_program: new D(np),
          source: 'import',
        },
      });
    }
    await db.inventoryPoolAdjustment.create({
      data: {
        site_id: site,
        day: dayKeyUTCFromISO('2026-09-25'),
        from_pool: 'non_program',
        to_pool: 'program',
        units: new D(600),
        reason: 'ADR-0143 T7 equivalence',
        proposed_by: PROPOSER,
        status: 'approved',
        approved_by: APPROVER,
        approved_at: new Date(),
      },
    });
    const now = noonPT('2026-10-01');
    const win = await guard.computePositionWindow(db, site, now);
    const live = await rb.computePoolBalance(db, site, { lte: now });
    const last = (pool: string) =>
      win.rows
        .filter((r) => r.pool === pool)
        .at(-1)!
        .closing.toString();
    expect(win.startDay).toBe('2026-09-15');
    expect(win.endDay).toBe('2026-10-01');
    expect(last('program')).toBe(live.program.toString());
    expect(last('non_program')).toBe(live.nonProgram.toString());
  });

  // ── T8 — the Woodland 09-17 day through the workbook sync ────────────────
  it('T8 — workbook sync drives program < 0 on 09-17: exception opened in the same transaction', async () => {
    const site = await newSite();
    await woodlandSeptember(site);
    const r1 = await workbookDay(site, '2026-09-15', 800, 0, noonPT('2026-09-15'));
    expect(r1.guard.opened).toEqual([]);
    await workbookDay(site, '2026-09-16', 690, 0, noonPT('2026-09-16'));
    const r3 = await workbookDay(site, '2026-09-17', 1172, 0, noonPT('2026-09-17'));
    expect(r3.guard.opened).toHaveLength(1);
    expect(r3.guard.opened[0]).toMatchObject({ pool: 'program', firstNegativeDay: '2026-09-17' });

    const ex = await db.inventoryException.findMany({ where: { site_id: site } });
    expect(ex).toHaveLength(1);
    expect(ex[0]).toMatchObject({
      pool: 'program',
      status: 'open',
      opened_by_writer: 'workbook-sync',
    });
    expect(ex[0].first_negative_day.toISOString().slice(0, 10)).toBe('2026-09-17');
    // 128+800-800 = 128; +700-690 = 138; +769+14-1172 = -251.
    expect(ex[0].shortfall.toString()).toBe('251');
    expect(ex[0].legs).toMatchObject({
      day: '2026-09-17',
      opening: '138',
      inbound: '769',
      dropoffs: '14',
      stripped: '1172',
      closing: '-251',
    });

    const neg = await db.inventoryPositionDaily.findMany({
      where: { site_id: site, pool: 'program', closing: { lt: 0 } },
    });
    expect(neg.length).toBeGreaterThan(0);
    expect(neg.every((p: any) => p.exception_id === ex[0].id)).toBe(true);
    // The audit trail names the opening.
    expect(
      await db.auditLog.count({ where: { table_name: 'inventory_exceptions', row_id: ex[0].id } }),
    ).toBe(1);
  });

  // ── T9 — the MyMRC processed bridge, including a backdated correction ────
  it('T9 — a backdated MyMRC correction (20 days back) is caught by the sweep with the TRUE first day and its door', async () => {
    const site = await newSite();
    await anchor(site, '2026-09-01', 100, 100);
    await inbound(site, '2026-09-05', 50, 0);
    // The bridge writes `source='mymrc'` rows on its own transaction (it is compiled
    // standalone and cannot import the guard); the scrape tick then calls the
    // pool-check route, which is `runPoolCheck(site, 'mymrc-processed-bridge')`.
    await db.$executeRawUnsafe(
      `INSERT INTO processed_units_daily (id, site_id, production_date, stripped_program, stripped_non_program, source, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, '2026-09-06'::date, 200, 0, 'mymrc', now(), now())`,
      site,
    );
    // The scraper cannot reach the guard (and is deliberately NOT given the internal
    // cron token: it is the hardened Chromium container, ADR-0053 addendum), so the
    // 10-minute sweep finds it and names the door from the day's own rows.
    const r = await guard.runPoolCheck(site, 'sweep', noonPT('2026-09-26'));
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatchObject({
      pool: 'program',
      firstNegativeDay: '2026-09-06',
      shortfall: '50',
    });
    const ex = await db.inventoryException.findFirst({ where: { site_id: site } });
    expect(ex.opened_by_writer).toBe('sweep:processed=mymrc');
  });

  // ── T10 — idempotency ────────────────────────────────────────────────────
  it('T10 — replaying the same write (and the same check) does not open a second exception', async () => {
    const site = await newSite();
    await woodlandSeptember(site);
    await workbookDay(site, '2026-09-15', 800, 0, noonPT('2026-09-15'));
    await workbookDay(site, '2026-09-16', 690, 0, noonPT('2026-09-16'));
    await workbookDay(site, '2026-09-17', 1172, 0, noonPT('2026-09-17'));
    // The same workbook bytes again: the upsert is a no-op and opens nothing.
    const replay = await workbookDay(site, '2026-09-17', 1172, 0, noonPT('2026-09-17'));
    expect(replay.upserted).toBe(0);
    // A changed figure for the same day re-runs the guard: still one exception.
    await workbookDay(site, '2026-09-17', 1173, 0, noonPT('2026-09-17'));
    const again = await guard.runPoolCheck(site, 'sweep', noonPT('2026-09-18'));
    expect(again.opened).toEqual([]);
    expect(await db.inventoryException.count({ where: { site_id: site } })).toBe(1);
  });

  // ── T11 — concurrency (precondition: no negative exists beforehand) ──────
  it('T11 — two writers on one site, started together, are serialised: one exception', async () => {
    const site = await newSite();
    await anchor(site, '2026-09-01', 100, 100);
    expect(await db.inventoryException.count({ where: { site_id: site } })).toBe(0);
    const write = (day: string) =>
      db.$transaction(async (tx: any) => {
        await tx.processedUnitsDaily.create({
          data: {
            site_id: site,
            production_date: dayKeyUTCFromISO(day),
            stripped_program: new D(80),
            stripped_non_program: new D(0),
            source: 'manual',
          },
        });
        return guard.guardPoolsInTx(tx, site, 'processed-units-entry', noonPT('2026-09-10'));
      });
    const results = await Promise.all([write('2026-09-03'), write('2026-09-04')]);
    expect(results.every((r: any) => r !== null)).toBe(true);
    expect(await db.inventoryException.count({ where: { site_id: site } })).toBe(1);
    const ex = await db.inventoryException.findFirst({ where: { site_id: site } });
    expect(ex.first_negative_day.toISOString().slice(0, 10)).toBe('2026-09-04');
  });

  it('a resolved exception keeps explaining its own days; a NEW negative opens a new one', async () => {
    const site = await newSite();
    await anchor(site, '2026-09-01', 10, 10);
    await db.processedUnitsDaily.create({
      data: {
        site_id: site,
        production_date: dayKeyUTCFromISO('2026-09-02'),
        stripped_program: new D(15),
        stripped_non_program: new D(0),
        source: 'manual',
      },
    });
    const first = await guard.runPoolCheck(site, 'sweep', noonPT('2026-09-03'));
    const exId = first.opened[0]!.id;
    // Repair dated 09-03 and resolve: 09-02 stays negative, explained by the resolved row.
    await db.inventoryPoolAdjustment.create({
      data: {
        site_id: site,
        day: dayKeyUTCFromISO('2026-09-03'),
        from_pool: 'non_program',
        to_pool: 'program',
        units: new D(5),
        reason: 'ADR-0143 resolved coverage test',
        proposed_by: PROPOSER,
        status: 'approved',
        approved_by: APPROVER,
        approved_at: new Date(),
        exception_id: exId,
      },
    });
    await db.inventoryException.update({
      where: { id: exId },
      data: {
        status: 'resolved',
        resolved_by: APPROVER,
        resolved_at: new Date(),
        resolution: 'adjustment',
        last_negative_day: dayKeyUTCFromISO('2026-09-02'),
      },
    });
    const again = await guard.runPoolCheck(site, 'sweep', noonPT('2026-09-05'));
    expect(again.opened).toEqual([]);
    // A later, unrelated negative opens a NEW exception.
    await db.processedUnitsDaily.create({
      data: {
        site_id: site,
        production_date: dayKeyUTCFromISO('2026-09-06'),
        stripped_program: new D(3),
        stripped_non_program: new D(0),
        source: 'manual',
      },
    });
    const later = await guard.runPoolCheck(site, 'sweep', noonPT('2026-09-07'));
    expect(later.opened).toHaveLength(1);
    expect(later.opened[0]!.firstNegativeDay).toBe('2026-09-06');
  });
});
