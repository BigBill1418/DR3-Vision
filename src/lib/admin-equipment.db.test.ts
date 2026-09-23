// ADR-0135 — the equipment registry's guarantees, against REAL Postgres.
//
// What only a real database can prove, and why each matters:
//   1. The merge covers EVERY foreign key into `equipment`. The latent defect
//      ADR-0135 §2 found was two FKs (ADR-0079 throughput, ADR-0088 gap alerts)
//      added after ADR-0075's merge was written and silently left on the loser.
//      This reads the live `pg_constraint` set and asserts it equals
//      MERGE_REPOINTED_REFERENCES ∪ MERGE_EXEMPT_REFERENCES — a new FK fails CI
//      until someone decides what a merge does with it.
//   2. The merge really moves throughput + gap-alert rows (an in-memory fake
//      would only restate its own fixture), including across sites into a
//      fleet-wide survivor, in one transaction.
//   3. `equipment_live_name_ci_key` refuses a case/whitespace-only duplicate
//      among LIVE rows and ignores merged losers.
//   4. The create gate refuses `161053.` next to `161053 — Freightliner …` and
//      the audited override lands a `equipment_distinct_pairs` row.
//
// Skips when `DR3_TEST_DATABASE_URL` is unset (the build host default). CI's
// `migrations` job runs it against a clean PG16 with the full chain applied.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  MERGE_EXEMPT_REFERENCES,
  MERGE_REPOINTED_REFERENCES,
  createEquipment,
  mergeEquipment,
} from './admin-equipment';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'admin-equipment.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
      'otherwise the writes and the assertions address different databases.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;
async function connect(): Promise<any> {
  if (db) return db;
  const { PrismaClient: PC } = (await import('@prisma/client')) as {
    PrismaClient: typeof PrismaClient;
  };
  db = new PC({ datasources: { db: { url: REAL_DB! } } });
  return db;
}

const EUG = 'eqdb-site-eugene';
const WDL = 'eqdb-site-woodland';
/** Every row this file writes carries this prefix, so cleanup never touches another suite. */
const P = 'eqdb-';
const ACTOR = { actorUserId: 'eqdb-admin', ip: null, userAgent: 'vitest' };

async function site(d: any, id: string, code: string): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${id}','${code}','${code}','oregon','OR-${code}','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
}

async function equip(
  d: any,
  id: string,
  name: string,
  siteId: string | null,
  extra: { merged_into_id?: string; category?: string } = {},
): Promise<void> {
  await d.equipment.create({
    data: {
      id,
      site_id: siteId,
      display_name: name,
      category: extra.category ?? 'vehicle',
      ...(extra.merged_into_id ? { merged_into_id: extra.merged_into_id, is_active: false } : {}),
    },
  });
}

async function clean(d: any): Promise<void> {
  const like = `'${P}%'`;
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment_distinct_pairs" WHERE "equipment_a_id" LIKE ${like} OR "equipment_b_id" LIKE ${like}`,
  );
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment_throughput_gap_alerts" WHERE "equipment_id" LIKE ${like}`,
  );
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment_daily_throughput" WHERE "equipment_id" LIKE ${like}`,
  );
  // Created-by-the-gate rows get uuid ids; find them by their generated names.
  const created = (await d.$queryRawUnsafe(
    `SELECT id FROM "equipment" WHERE "display_name" LIKE 'EQDB%' AND id NOT LIKE ${like}`,
  )) as { id: string }[];
  const ids = created.map((r) => `'${r.id}'`).join(',');
  if (ids) {
    await d.$executeRawUnsafe(
      `DELETE FROM "equipment_distinct_pairs" WHERE "equipment_a_id" IN (${ids}) OR "equipment_b_id" IN (${ids})`,
    );
  }
  // Losers first (un-merging them would make two live rows share a name and trip
  // `equipment_live_name_ci_key`), then the survivors.
  const mine = `(id LIKE ${like} OR "display_name" LIKE 'EQDB%')`;
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment" WHERE ${mine} AND "merged_into_id" IS NOT NULL`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "equipment" WHERE ${mine}`);
}

describe.skipIf(!REAL_DB)('ADR-0135 — equipment registry against real Postgres', () => {
  beforeEach(async () => {
    const d = await connect();
    await clean(d);
    await site(d, EUG, 'eqdb-eug');
    await site(d, WDL, 'eqdb-wdl');
    // audit_log.actor_user_id is a real FK → users.id.
    await d.$executeRawUnsafe(`
      INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
      VALUES ('${ACTOR.actorUserId}','EQDB Admin','admin','${EUG}',true,CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`);
  });

  afterAll(async () => {
    if (!db) return;
    await clean(db);
    await db.$disconnect();
  });

  it('the merge accounts for EVERY foreign key into `equipment` (pg_constraint is the source)', async () => {
    const d = await connect();
    const rows = (await d.$queryRawUnsafe(`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.contype = 'f' AND c.confrelid = 'equipment'::regclass`)) as {
      tbl: string;
      col: string;
    }[];
    const live = rows
      .map((r) => `${r.tbl.replace(/^public\./, '').replace(/"/g, '')}.${r.col}`)
      .sort();
    expect(live).toEqual([...MERGE_REPOINTED_REFERENCES, ...MERGE_EXEMPT_REFERENCES].sort());
  });

  it('merge repoints throughput + gap alerts, across sites, into a FLEET-WIDE survivor', async () => {
    const d = await connect();
    await equip(d, `${P}w`, 'EQDB 281577 — Great Dane', WDL);
    await equip(d, `${P}l`, 'EQDB Trailer 281577', EUG);
    await d.equipmentDailyThroughput.create({
      data: {
        id: `${P}day1`,
        site_id: EUG,
        equipment_id: `${P}l`,
        throughput_date: new Date('2026-09-01'),
        units_processed: 10,
        run_hours: 2,
      },
    });
    await d.equipmentThroughputGapAlert.create({
      data: {
        id: `${P}gap1`,
        site_id: EUG,
        gap_date: new Date('2026-09-02'),
        equipment_id: `${P}l`,
        scanned_on: new Date('2026-09-03'),
        notify_mode: 'pilot',
        recipient_count: 0,
        delivered_count: 0,
      },
    });

    expect(await mergeEquipment(`${P}w`, `${P}l`, ACTOR)).toEqual({
      ok: false,
      reason: 'cross_site',
    });
    const res = await mergeEquipment(`${P}w`, `${P}l`, ACTOR, { survivorSiteId: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repointed).toMatchObject({ throughput: 1, gapAlerts: 1 });

    const day = await d.equipmentDailyThroughput.findUnique({ where: { id: `${P}day1` } });
    const gap = await d.equipmentThroughputGapAlert.findUnique({ where: { id: `${P}gap1` } });
    expect(day.equipment_id).toBe(`${P}w`);
    expect(gap.equipment_id).toBe(`${P}w`);
    const [w, l] = await Promise.all([
      d.equipment.findUnique({ where: { id: `${P}w` } }),
      d.equipment.findUnique({ where: { id: `${P}l` } }),
    ]);
    expect(w.site_id).toBeNull();
    expect(l).toMatchObject({ merged_into_id: `${P}w`, is_active: false });
  });

  it('a same-day throughput reading on both machines refuses the merge and moves nothing', async () => {
    const d = await connect();
    await equip(d, `${P}a`, 'EQDB Shear A', WDL, { category: 'terex' });
    await equip(d, `${P}b`, 'EQDB Shear B', WDL, { category: 'terex' });
    for (const id of ['a', 'b']) {
      await d.equipmentDailyThroughput.create({
        data: {
          id: `${P}day-${id}`,
          site_id: WDL,
          equipment_id: `${P}${id}`,
          throughput_date: new Date('2026-09-05'),
          units_processed: 5,
          run_hours: 1,
        },
      });
    }
    const res = await mergeEquipment(`${P}a`, `${P}b`, ACTOR);
    expect(res).toEqual({
      ok: false,
      reason: 'throughput_conflict',
      conflictDates: ['2026-09-05'],
    });
    const b = await d.equipmentDailyThroughput.findUnique({ where: { id: `${P}day-b` } });
    expect(b.equipment_id).toBe(`${P}b`);
  });

  it('the database refuses a live name differing only by case/whitespace — and ignores merged losers', async () => {
    const d = await connect();
    await equip(d, `${P}t1`, 'EQDB Terex', WDL);
    await expect(equip(d, `${P}t2`, 'eqdb   terex', EUG)).rejects.toMatchObject({ code: 'P2002' });
    // A merged loser keeps its old spelling by design (ADR-0075) — allowed.
    await equip(d, `${P}t3`, 'eqdb terex', EUG, { merged_into_id: `${P}t1` });
  });

  it('the create gate refuses `161053.` next to `161053 — Freightliner …`; the override is recorded', async () => {
    const d = await connect();
    await equip(d, `${P}fl`, 'EQDB161053 — Freightliner Semi Truck', WDL);

    const refused = await createEquipment(
      { site_id: EUG, asset_type: 'semi_truck', unit_number: 'EQDB161053.' },
      ACTOR,
    );
    expect(refused).toMatchObject({ ok: false, reason: 'probable_duplicate' });
    expect(refused.ok ? [] : refused.existing?.map((e) => e.id)).toEqual([`${P}fl`]);

    const made = await createEquipment(
      {
        site_id: EUG,
        asset_type: 'semi_truck',
        unit_number: 'EQDB161053',
        make: 'Kenworth',
        confirm_distinct: {
          reason: 'Different truck: Kenworth, VIN on the invoice',
          distinct_from_ids: [`${P}fl`],
        },
      },
      ACTOR,
    );
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(made.equipment.display_name).toBe('EQDB161053 — Kenworth Semi Truck');
    const pairs = await d.equipmentDistinctPair.findMany({
      where: { OR: [{ equipment_a_id: made.equipment.id }, { equipment_b_id: made.equipment.id }] },
    });
    expect(pairs).toHaveLength(1);
    const audit = await d.auditLog.findFirst({
      where: { table_name: 'equipment', row_id: made.equipment.id, action: 'insert' },
    });
    expect(audit.after.duplicate_override.reason).toBe(
      'Different truck: Kenworth, VIN on the invoice',
    );
    expect(audit.actor_user_id).toBe('eqdb-admin');
  });
});
