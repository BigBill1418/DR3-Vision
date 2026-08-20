// ADR-0120 — the promotion lock and the import-anchor index, against a REAL
// Postgres. Nothing here is expressible against a mocked client: an advisory
// lock IS a Postgres object, and a partial unique index IS a Postgres
// constraint. A fake has neither.
//
// Three claims:
//
//   1. THE LOCK ACTUALLY SERIALISES. A held site lock blocks a concurrent floor
//      write at that site. Asserted by watching `pg_stat_activity` for the
//      blocked backend, not by a `setTimeout` that might merely have been slow.
//   2. IT IS SCOPED TO THE SITE. A write at a DIFFERENT site is not blocked.
//      Without this, a lock that serialised everything would pass claim 1 while
//      quietly turning the whole fleet's floor into a single queue — and CLAUDE.md
//      hard rule #2 makes Eugene and Woodland independent by design.
//   3. THE INDEX REFUSES A SECOND IMPORT ANCHOR, AND ONLY AN IMPORT ANCHOR. Two
//      live `source = 'import'` physical anchors at one site-instant collide;
//      two live MANUAL ones at the same instant do NOT — which is the ADR-0078 D1
//      same-day-count invariant the unscoped version of this index would have
//      broken.
//
// ── FALSIFIED BY HAND (2026-08-20) ───────────────────────────────────────────
//
// Claim 1: removing `lockSiteAgainstPromotion` from `createLandfilledUnit`
// (the shape on `main`) means the write never blocks:
//     → timed out waiting for the floor write to block on the site lock
//
// Claim 3, second half: widening the migration's index to drop
// `AND "source" = 'import'` — the shape originally specified — makes the manual
// same-day pair collide, and takes ADR-0078 D1's own suite red with
// `Key (site_id, snapshot_at)=… already exists`. That falsification is what
// narrowed the index; it is recorded in the migration and in ADR-0120.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'promotion-lock.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0120-promlock';
const SITE_A = `${NS}-site-a`;
const SITE_B = `${NS}-site-b`;
const ACTOR = `${NS}-actor`;
const DAY = new Date(Date.UTC(2026, 6, 20));
/** Pacific midnight — the instant every floor count is anchored at. */
const INSTANT = new Date('2026-07-20T07:00:00.000Z');

const siteFields = (code: string, name: string) => ({
  code,
  name,
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
});

async function cleanup(d: any): Promise<void> {
  for (const s of [SITE_A, SITE_B]) {
    await d.$executeRawUnsafe(`DELETE FROM "landfilled_units" WHERE "site_id" = '${s}'`);
    await d.$executeRawUnsafe(`DELETE FROM "site_inventory_snapshots" WHERE "site_id" = '${s}'`);
  }
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({
    where: { id: SITE_A },
    update: {},
    create: { id: SITE_A, ...siteFields(`${NS}a`, 'Promo Lock Probe A') },
  });
  await d.site.upsert({
    where: { id: SITE_B },
    update: {},
    create: { id: SITE_B, ...siteFields(`${NS}b`, 'Promo Lock Probe B') },
  });
  // Hard rule #6 — audit rows are never deleted and FK the actor, so it stays.
  await d.user.upsert({
    where: { id: ACTOR },
    update: {},
    create: { id: ACTOR, name: 'Promo Lock Probe', role: 'admin', primary_site_id: SITE_A },
  });
}

/**
 * Poll `cond` until true, or fail loudly NAMING what we were waiting for.
 *
 * The default budget is deliberately well under vitest's 5 s per-test timeout.
 * A falsification run must fail with "timed out waiting for the floor write to
 * block on the site lock" — a message that says what was actually wrong — not
 * with a bare `Test timed out in 5000ms`, which is the same red for a hung
 * database, a slow CI box, or a genuine missing lock.
 */
async function waitFor(cond: () => Promise<boolean>, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Backends waiting on an ADVISORY lock specifically — not any lock. */
const advisoryWaiters = async (d: any): Promise<number> => {
  const rows = (await d.$queryRawUnsafe(
    `SELECT count(*)::bigint AS n FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted`,
  )) as { n: bigint }[];
  return Number(rows[0]?.n ?? 0);
};

const landfilled = (siteId: string) => ({
  siteId,
  disposalDate: DAY,
  units: 10,
  programUnits: 10,
  nonProgramUnits: 0,
  reason: 'soiled' as const,
  actorUserId: ACTOR,
});

/** Insert a physical snapshot directly, so the INDEX is what is under test. */
async function insertSnapshot(d: any, siteId: string, source: string): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "site_inventory_snapshots"
      ("id","site_id","snapshot_at","units_total","units_in_processing",
       "snapshot_kind","source","pool_attribution","created_at")
    VALUES (gen_random_uuid()::text,'${siteId}','${INSTANT.toISOString()}',100,0,
            'physical','${source}','measured', now())
  `);
}

describe.skipIf(!REAL_DB)('ADR-0120 — promotion lock + import-anchor uniqueness', () => {
  beforeEach(async () => {
    if (!db) {
      const { PrismaClient: PC } = (await import('@prisma/client')) as {
        PrismaClient: typeof PrismaClient;
      };
      db = new PC({ datasources: { db: { url: REAL_DB! } } });
    }
    await seed(db);
  });

  afterAll(async () => {
    if (db) {
      await cleanup(db);
      await db.$disconnect();
    }
  });

  it('a held site lock BLOCKS a floor write at that site, and releases it', async () => {
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    const holder = new PC({ datasources: { db: { url: REAL_DB! } } });
    // Warm the connection before the timed section — a cold client spends its
    // first query connecting, and the ordering below must not depend on that.
    await holder.$queryRawUnsafe('SELECT 1');

    const { lockSiteAgainstPromotion } = await import('./promotion-lock');
    const { createLandfilledUnit } = await import('@/lib/loads/landfilled');

    let release!: () => void;
    const mayCommit = new Promise<void>((r) => {
      release = r;
    });

    // Stands in for the promotion transaction: takes the site lock and holds it.
    const held = holder.$transaction(
      async (tx: any) => {
        await lockSiteAgainstPromotion(tx, SITE_A);
        await mayCommit;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await waitFor(async () => (await advisoryWaiters(db)) === 0, 'the holder to settle');

    const write = createLandfilledUnit(landfilled(SITE_A));

    // THE ASSERTION. The floor write must be WAITING on an advisory lock. If the
    // writer did not take the lock, nothing ever waits and this times out —
    // which is exactly what the falsification produces.
    await waitFor(
      async () => (await advisoryWaiters(db)) >= 1,
      'the floor write to block on the site lock',
    );

    // Nothing landed while it was blocked.
    expect(await db.landfilledUnit.count({ where: { site_id: SITE_A } })).toBe(0);

    release();
    await held;

    // And it completes once the lock is free — a guard that blocked forever
    // would also pass the assertion above.
    await write;
    expect(await db.landfilledUnit.count({ where: { site_id: SITE_A } })).toBe(1);

    await holder.$disconnect();
  });

  it('does NOT block a write at a DIFFERENT site', async () => {
    // CLAUDE.md hard rule #2 — Eugene and Woodland are strictly separated. A
    // lock that serialised every site would pass the test above while turning
    // both floors into one queue, so this is not a nicety.
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    const holder = new PC({ datasources: { db: { url: REAL_DB! } } });
    await holder.$queryRawUnsafe('SELECT 1');

    const { lockSiteAgainstPromotion } = await import('./promotion-lock');
    const { createLandfilledUnit } = await import('@/lib/loads/landfilled');

    let release!: () => void;
    const mayCommit = new Promise<void>((r) => {
      release = r;
    });
    const held = holder.$transaction(
      async (tx: any) => {
        await lockSiteAgainstPromotion(tx, SITE_A);
        await mayCommit;
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await waitFor(async () => (await advisoryWaiters(db)) === 0, 'the holder to settle');

    // Site B, while site A's lock is held. This must simply complete.
    await createLandfilledUnit(landfilled(SITE_B));
    expect(await db.landfilledUnit.count({ where: { site_id: SITE_B } })).toBe(1);

    release();
    await held;
    await holder.$disconnect();
  });

  it('refuses a SECOND live import anchor at one site-instant', async () => {
    await insertSnapshot(db, SITE_A, 'import');
    await expect(
      insertSnapshot(db, SITE_A, 'import'),
      'two promotions must not both anchor one site-instant',
    ).rejects.toThrow();
    expect(await db.siteInventorySnapshot.count({ where: { site_id: SITE_A } })).toBe(1);
  });

  it('still permits TWO live MANUAL counts at one instant (ADR-0078 D1)', async () => {
    // The invariant the unscoped version of this index would have broken. The
    // floor anchors every count at Pacific midnight of its day, so two counts
    // on one day share an instant BY CONSTRUCTION — ADR-0078 D1 added the
    // `created_at DESC` tiebreak precisely to make that deterministic, and its
    // suite header records both rows sitting on 07:00:00 UTC in production.
    await insertSnapshot(db, SITE_A, 'manual');
    await insertSnapshot(db, SITE_A, 'manual');
    expect(
      await db.siteInventorySnapshot.count({ where: { site_id: SITE_A } }),
      'a second same-day physical count must still be accepted',
    ).toBe(2);

    // And a voided import anchor does not block a fresh one — the index is
    // partial on `voided_at IS NULL` so a withdrawn promotion can be re-run.
    await insertSnapshot(db, SITE_B, 'import');
    await db.$executeRawUnsafe(
      `UPDATE "site_inventory_snapshots" SET "voided_at" = now() WHERE "site_id" = '${SITE_B}'`,
    );
    await insertSnapshot(db, SITE_B, 'import');
    expect(await db.siteInventorySnapshot.count({ where: { site_id: SITE_B } })).toBe(2);
  });
});
