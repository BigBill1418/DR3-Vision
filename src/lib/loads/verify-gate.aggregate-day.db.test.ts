// ADR-0142 — the verify gate refuses a per-load (dock) verify on a Pacific day that
// already holds a VERIFIED aggregate inbound row, against a REAL Postgres.
//
// ADR-0060 D5: `onHand` sums every verified inbound row for a day whatever its
// `load_source_type`, so an aggregate row (`mymrc_haul` / `paper_bulk` / `ipad_floor`)
// plus a verified per-load `b2b_haul` row for the same day count the same mattresses
// twice. `confirmFloorInboundDay` and the MyMRC bridge both refuse to ADD an aggregate
// to a day that holds verified per-load rows. Before this change `verifyLoad` — the
// other direction, adding a verified per-load row to a day that holds an aggregate —
// checked state and site only. Woodland has 374 `b2b_haul` dock loads at `submitted`
// whose days are already counted by the `mymrc_haul` aggregate; one verify on any of
// them would have double-counted that truck in on-hand.
//
// Why a real database: the race claim is about Postgres — that the verify takes the
// same site advisory lock every aggregate writer takes, and so cannot read "no
// aggregate" while an aggregate write is holding that lock uncommitted.
//
// ── FALSIFIED (2026-10-08) ─────────────────────────────────────────────────────
// Against f32a067 `verify-gate.ts` (no aggregate check, no lock) the refusal cases
// fail with "promise resolved … instead of rejecting" and the race case fails on
// "the verify must wait for the aggregate writer's lock" (it resolved at once).
// Removing ONLY the `lockSiteAgainstPromotion` line from the fixed gate (keeping the
// aggregate check) turns the race case alone red, the same way — the check without the
// lock reads "no aggregate" while the writer holds it uncommitted.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'verify-gate.aggregate-day.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0142-aggday';
const SITE = `${NS}-site`;
const MANAGER = `${NS}-manager`;
const SOURCE = `${NS}-source`;
const FIRST_NUMBER = 7000;

// California, so a wrongly-allowed verify would also burn a DR3 number — the refusal
// must leave the counter untouched.
const SITE_FIELDS = {
  code: NS,
  name: 'Aggregate Day Guard Probe',
  jurisdiction: 'california' as const,
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
  billing_cadence: 'end_of_month_only' as const,
};

// Pacific day 2026-08-07 (PDT, UTC-7): midnight is 07:00Z.
const AUG7_PACIFIC_MIDNIGHT = new Date('2026-08-07T07:00:00.000Z');
const AUG6_PACIFIC_MIDNIGHT = new Date('2026-08-06T07:00:00.000Z');

const uid = (tag: string) =>
  `${NS}-${tag}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "document_sequences" WHERE "site_id" = '${SITE}'`);
}

async function seedBase(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  await d.user.upsert({
    where: { id: MANAGER },
    update: {},
    create: {
      id: MANAGER,
      name: 'Aggregate Guard Manager',
      role: 'manager',
      primary_site_id: SITE,
    },
  });
  await d.source.upsert({
    where: { id: SOURCE },
    update: {},
    create: { id: SOURCE, site_id: SITE, name: 'Aggregate Guard Yard' },
  });
  await d.documentSequence.create({
    data: { site_id: SITE, sequence_code: 'dr3_number', next_value: FIRST_NUMBER },
  });
}

async function seedDockLoad(d: any, arrivedAt: Date): Promise<string> {
  const id = uid('dock');
  await d.inboundLoad.create({
    data: {
      id,
      site_id: SITE,
      source_id: SOURCE,
      load_source_type: 'b2b_haul',
      status: 'submitted',
      arrived_at: arrivedAt,
      total_units: 40,
    },
  });
  return id;
}

function aggregateRow(arrivedAt: Date, type = 'mymrc_haul') {
  return {
    id: uid('agg'),
    site_id: SITE,
    load_source_type: type,
    status: 'verified',
    arrived_at: arrivedAt,
    total_units: 900,
    program_unit_count: 900,
    non_program_unit_count: 0,
  };
}

const nextValue = async (d: any): Promise<number> =>
  (
    await d.documentSequence.findUniqueOrThrow({
      where: { site_id_sequence_code: { site_id: SITE, sequence_code: 'dr3_number' } },
      select: { next_value: true },
    })
  ).next_value;

describe.skipIf(!REAL_DB)(
  'ADR-0142 — verify refuses a dock load on an aggregate-counted day',
  () => {
    beforeEach(async () => {
      if (!db) {
        const { PrismaClient: PC } = (await import('@prisma/client')) as {
          PrismaClient: typeof PrismaClient;
        };
        db = new PC({ datasources: { db: { url: REAL_DB! } } });
      }
      await seedBase(db);
    });

    afterAll(async () => {
      if (db) {
        await cleanup(db);
        await db.$disconnect();
      }
    });

    for (const type of ['mymrc_haul', 'paper_bulk', 'ipad_floor']) {
      it(`refuses (409 aggregate_day_exists) when a verified ${type} row owns the Pacific day`, async () => {
        await db.inboundLoad.create({ data: aggregateRow(AUG7_PACIFIC_MIDNIGHT, type) });
        const load = await seedDockLoad(db, new Date('2026-08-07T15:00:00.000Z'));
        const { verifyLoad, VerifyGateError } = await import('./verify-gate');

        const err = await verifyLoad({ loadId: load, siteId: SITE, verifierUserId: MANAGER }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(err, 'verify must be refused').toBeInstanceOf(VerifyGateError);
        expect((err as InstanceType<typeof VerifyGateError>).reason).toBe('aggregate_day_exists');
        expect((err as InstanceType<typeof VerifyGateError>).status).toBe(409);

        const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: load } });
        expect(row.status, 'the dock load is left exactly as it was').toBe('submitted');
        expect(row.dr3_number).toBeNull();
        expect(await nextValue(db), 'no DR3 number may be burned by a refusal').toBe(FIRST_NUMBER);
        const audits = await db.auditLog.count({
          where: { table_name: 'inbound_loads', row_id: load },
        });
        expect(audits).toBe(0);
      });
    }

    it('buckets on the PACIFIC day, not the UTC date (20:00 PDT = 03:00Z next day)', async () => {
      await db.inboundLoad.create({ data: aggregateRow(AUG7_PACIFIC_MIDNIGHT) });
      // 2026-08-08T03:00Z is 2026-08-07 20:00 PDT — the aggregate's day.
      const load = await seedDockLoad(db, new Date('2026-08-08T03:00:00.000Z'));
      const { verifyLoad } = await import('./verify-gate');
      await expect(
        verifyLoad({ loadId: load, siteId: SITE, verifierUserId: MANAGER }),
      ).rejects.toMatchObject({ reason: 'aggregate_day_exists', status: 409 });
    });

    it('allows the verify on a day with no aggregate row (an aggregate on the day before is irrelevant)', async () => {
      await db.inboundLoad.create({ data: aggregateRow(AUG6_PACIFIC_MIDNIGHT) });
      const load = await seedDockLoad(db, new Date('2026-08-07T15:00:00.000Z'));
      const { verifyLoad } = await import('./verify-gate');
      await verifyLoad({ loadId: load, siteId: SITE, verifierUserId: MANAGER });
      const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: load } });
      expect(row.status).toBe('verified');
      expect(row.dr3_number).toBe(String(FIRST_NUMBER));
    });

    it('an UNVERIFIED aggregate (voided) does not block — only the D5 verified set counts', async () => {
      await db.inboundLoad.create({
        data: {
          ...aggregateRow(AUG7_PACIFIC_MIDNIGHT),
          status: 'voided',
          voided_at: new Date(),
          voided_by_label: 'adr0142-test',
        },
      });
      const load = await seedDockLoad(db, new Date('2026-08-07T15:00:00.000Z'));
      const { verifyLoad } = await import('./verify-gate');
      await verifyLoad({ loadId: load, siteId: SITE, verifierUserId: MANAGER });
      expect((await db.inboundLoad.findUniqueOrThrow({ where: { id: load } })).status).toBe(
        'verified',
      );
    });

    it('race: a verify that starts while an aggregate writer holds the site lock sees its commit', async () => {
      const load = await seedDockLoad(db, new Date('2026-08-07T15:00:00.000Z'));
      const { lockSiteAgainstPromotion } = await import('@/lib/audit/promotion-lock');
      const { verifyLoad } = await import('./verify-gate');

      // A stand-in for any aggregate writer (bridge / floor confirm / paper bulk): it
      // takes the site promotion lock FIRST, as all three do, then — while the verify is
      // in flight — inserts the day's aggregate and commits.
      let lockHeld!: () => void;
      const held = new Promise<void>((r) => (lockHeld = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const writer = db.$transaction(
        async (tx: any) => {
          await lockSiteAgainstPromotion(tx, SITE);
          lockHeld();
          await gate;
          await tx.inboundLoad.create({ data: aggregateRow(AUG7_PACIFIC_MIDNIGHT) });
        },
        { timeout: 20_000 },
      );
      await held;

      let settled = false;
      const verify = verifyLoad({ loadId: load, siteId: SITE, verifierUserId: MANAGER }).finally(
        () => (settled = true),
      );
      verify.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 750));
      expect.soft(settled, "the verify must wait for the aggregate writer's lock").toBe(false);

      release();
      await writer;
      await expect(verify).rejects.toMatchObject({ reason: 'aggregate_day_exists', status: 409 });
      expect((await db.inboundLoad.findUniqueOrThrow({ where: { id: load } })).status).toBe(
        'submitted',
      );
      expect(await nextValue(db)).toBe(FIRST_NUMBER);
    });
  },
);
