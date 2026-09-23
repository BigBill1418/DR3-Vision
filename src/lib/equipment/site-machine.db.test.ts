// BX-12 (ADR-0137) — the throughput-machine designation against REAL Postgres.
//
// What only a real database can prove:
//   1. The production regression shape: at one site, an OLDER `terex`-category
//      shear WITH an invoice link, next to the newer Terex. The old resolver
//      ("oldest terex row with any link") picked the shear; the designation
//      must pick the Terex, and a real `upsertDailyThroughput` must write there.
//   2. The guarantees are DDL, not convention: one designation per site (PK), one
//      site per machine (unique), both FKs live.
//   3. A site with no designation fails loudly through the real read path.
//   4. A merge of the designated machine carries the designation to the survivor
//      (the FK is in MERGE_REPOINTED_REFERENCES — `admin-equipment.db.test.ts`
//      asserts that list against pg_constraint).
//
// Skips when `DR3_TEST_DATABASE_URL` is unset. CI's `migrations` job runs it
// against a clean PG16 with the full chain applied.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { mergeEquipment } from '@/lib/admin-equipment';
import { upsertDailyThroughput } from './daily-throughput';
import { ThroughputMachineNotConfiguredError, resolveSiteThroughputMachine } from './site-machine';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'site-machine.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
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

/** Every row this file writes carries this prefix, so cleanup never touches another suite. */
const P = 'bx12db-';
const WDL = `${P}site-wdl`;
const EUG = `${P}site-eug`;
const SHEAR = `${P}eq24`;
const TEREX = `${P}terex`;
const ACTOR = { actorUserId: `${P}mgr`, ip: null, userAgent: 'vitest' };

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

async function clean(d: any): Promise<void> {
  const like = `'${P}%'`;
  await d.$executeRawUnsafe(`DELETE FROM "site_throughput_machines" WHERE "site_id" LIKE ${like}`);
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment_daily_throughput" WHERE "equipment_id" LIKE ${like}`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "ap_equipment_links" WHERE "id" LIKE ${like}`);
  await d.$executeRawUnsafe(`DELETE FROM "ap_requests" WHERE "id" LIKE ${like}`);
  await d.$executeRawUnsafe(
    `DELETE FROM "equipment" WHERE "id" LIKE ${like} AND "merged_into_id" IS NOT NULL`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "equipment" WHERE "id" LIKE ${like}`);
}

/** Production's shape: EQ24 seeded 07-28 and invoiced 09-02; the Terex seeded 07-30. */
async function productionShape(d: any): Promise<void> {
  await d.equipment.create({
    data: {
      id: SHEAR,
      site_id: WDL,
      display_name: `${P}EQ24 — Shear Machine`,
      category: 'terex',
      created_at: new Date('2026-07-29T02:46:44Z'),
    },
  });
  await d.equipment.create({
    data: {
      id: TEREX,
      site_id: WDL,
      display_name: `${P}Terex`,
      category: 'terex',
      created_at: new Date('2026-07-31T03:28:23Z'),
    },
  });
  for (const [n, equipmentId] of [
    ['a', SHEAR],
    ['b', TEREX],
  ] as const) {
    await d.$executeRawUnsafe(`
      INSERT INTO "ap_requests" ("id","internet_message_id","received_at","sender_address",
        "sender_validated","updated_at")
      VALUES ('${P}req-${n}','<${P}${n}@test>',CURRENT_TIMESTAMP,'ap@test',true,CURRENT_TIMESTAMP)`);
    await d.$executeRawUnsafe(`
      INSERT INTO "ap_equipment_links" ("id","request_id","equipment_id")
      VALUES ('${P}link-${n}','${P}req-${n}','${equipmentId}')`);
  }
}

describe.skipIf(!REAL_DB)('BX-12 — designated throughput machine against real Postgres', () => {
  beforeEach(async () => {
    const d = await connect();
    await clean(d);
    await site(d, WDL, `${P}wdl`);
    await site(d, EUG, `${P}eug`);
    await d.$executeRawUnsafe(`
      INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
      VALUES ('${ACTOR.actorUserId}','BX12 Manager','admin','${WDL}',true,CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`);
    await productionShape(d);
  });

  afterAll(async () => {
    if (!db) return;
    await clean(db);
    await db.$disconnect();
  });

  it('picks the DESIGNATED Terex, not the older invoiced shear — and a real write lands there', async () => {
    const d = await connect();
    // The inference this replaced, run against the same rows, to prove the
    // fixture really is the trap: it answers the SHEAR.
    const inferred = await d.equipment.findFirst({
      where: { site_id: WDL, category: 'terex', is_active: true, links: { some: {} } },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    expect(inferred.id).toBe(SHEAR);

    await d.siteThroughputMachine.create({
      data: { site_id: WDL, equipment_id: TEREX, reason: 'test', set_label: 'system:test' },
    });
    expect(await resolveSiteThroughputMachine(WDL)).toEqual({
      id: TEREX,
      displayName: `${P}Terex`,
    });

    const today = new Date(Date.UTC(2026, 8, 23));
    const row = await upsertDailyThroughput({
      siteId: WDL,
      throughputDate: today,
      unitsProcessed: 150,
      startHours: 3030.85,
      endHours: 3039.85,
      notes: null,
      reason: null,
      today,
      actor: ACTOR,
    });
    expect(row.equipmentId).toBe(TEREX);
    expect(await d.equipmentDailyThroughput.count({ where: { equipment_id: SHEAR } })).toBe(0);
  });

  it('FAILS LOUDLY — no designation throws, and the form write refuses (no row written)', async () => {
    const d = await connect();
    await expect(resolveSiteThroughputMachine(WDL)).rejects.toBeInstanceOf(
      ThroughputMachineNotConfiguredError,
    );
    const today = new Date(Date.UTC(2026, 8, 23));
    await expect(
      upsertDailyThroughput({
        siteId: WDL,
        throughputDate: today,
        unitsProcessed: 150,
        startHours: 1,
        endHours: 2,
        notes: null,
        reason: null,
        today,
        actor: ACTOR,
      }),
    ).rejects.toBeInstanceOf(ThroughputMachineNotConfiguredError);
    expect(await d.equipmentDailyThroughput.count({ where: { site_id: WDL } })).toBe(0);
  });

  it('an explicit NONE designation is null (Eugene), not an error', async () => {
    const d = await connect();
    await d.siteThroughputMachine.create({
      data: { site_id: EUG, equipment_id: null, reason: 'test', set_label: 'system:test' },
    });
    expect(await resolveSiteThroughputMachine(EUG)).toBeNull();
  });

  it('the database enforces one designation per site and one site per machine', async () => {
    const d = await connect();
    await d.siteThroughputMachine.create({
      data: { site_id: WDL, equipment_id: TEREX, reason: 'test', set_label: 'system:test' },
    });
    await expect(
      d.siteThroughputMachine.create({
        data: { site_id: WDL, equipment_id: SHEAR, reason: 'second', set_label: 'system:test' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      d.siteThroughputMachine.create({
        data: { site_id: EUG, equipment_id: TEREX, reason: 'shared', set_label: 'system:test' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Neither actor column set → the actor CHECK refuses it.
    await expect(
      d.$executeRawUnsafe(
        `INSERT INTO "site_throughput_machines" ("site_id","equipment_id","reason") VALUES ('${EUG}',NULL,'x')`,
      ),
    ).rejects.toThrow(/site_throughput_machines_actor/);
    // A designation naming a row that does not exist → the FK refuses it.
    await expect(
      d.$executeRawUnsafe(
        `INSERT INTO "site_throughput_machines" ("site_id","equipment_id","reason","set_label") VALUES ('${EUG}','${P}nope','x','t')`,
      ),
    ).rejects.toThrow(/site_throughput_machines_equipment_id_fkey/);
  });

  it('a merge of the designated machine carries the designation to the survivor', async () => {
    const d = await connect();
    await d.equipment.create({
      data: {
        id: `${P}terex-dup`,
        site_id: WDL,
        display_name: `${P}Terex Machine`,
        category: 'terex',
      },
    });
    await d.siteThroughputMachine.create({
      data: {
        site_id: WDL,
        equipment_id: `${P}terex-dup`,
        reason: 'test',
        set_label: 'system:test',
      },
    });
    const res = await mergeEquipment(TEREX, `${P}terex-dup`, ACTOR);
    expect(res.ok && res.repointed.throughputMachine).toBe(1);
    expect(await resolveSiteThroughputMachine(WDL)).toEqual({
      id: TEREX,
      displayName: `${P}Terex`,
    });
  });
});
