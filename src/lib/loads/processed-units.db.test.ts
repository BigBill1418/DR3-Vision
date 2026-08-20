// ADR-0119 — the manual processed-units correction, against a REAL Postgres.
//
// Two claims. Both are about the interaction between a human correction and the
// MyMRC bridge, and neither is expressible against a mocked client.
//
//   1. A CORRECTION TAKES OWNERSHIP OF THE ROW. The bridge's upsert is
//      precedence-guarded by `WHERE … source = 'mymrc'` — that guard IS the
//      ownership mechanism, and it keys on a column the correction never set on
//      its update path. So this test does not assert "the column now says
//      manual" and call it proven; it runs THE REAL BRIDGE afterwards and
//      asserts the human's number survived. A mocked bridge would agree with
//      whatever the fixture said.
//
//   2. THE CLOSED-DAY CHECK IS A GUARD, NOT A PRIOR READ. The refusal now rides
//      on the statement (`ON CONFLICT … DO UPDATE … WHERE closed_at IS NULL`),
//      so a day closed AFTER the caller's read is still refused. Proving that
//      means closing the day between the read and the write, which requires a
//      real database — a fake has no read to interleave with.
//
// ── FALSIFIED BY HAND (2026-08-19) ───────────────────────────────────────────
//
// Test 1: removing `"source" = 'manual'` from the ON CONFLICT DO UPDATE SET
// list — the shape on `main`, where `source` was set only on insert — lets the
// next bridge tick overwrite the correction:
//     → the human's correction must survive the next MyMRC tick: expected '900' to be '1234'
//
// Test 2: restoring the pre-read + unguarded `upsert` lets the write land on a
// closed day and report success:
//     → writing a closed day must be refused: promise resolved instead of rejecting
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// `upsertProcessedUnits` writes through the `@/lib/prisma` singleton
// (DATABASE_URL) while the assertions read their own client
// (DR3_TEST_DATABASE_URL). The CI lane sets both to the same value on purpose.
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'processed-units.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0119-procunits';
const SITE = `${NS}-site`;
const OFFICE = `${NS}-office`;
const DAY = new Date(Date.UTC(2026, 6, 15));
const DAY_ISO = '2026-07-15';

const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Processed Units Probe',
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

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "processed_units_daily" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "mymrc_processed_mirror" WHERE "site_id" = '${SITE}'`);
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  // Hard rule #6 — `audit_log.actor_user_id` FKs to `users`, and audit rows are
  // never deleted, so the actor row stays standing across teardown.
  await d.user.upsert({
    where: { id: OFFICE },
    update: {},
    create: { id: OFFICE, name: 'Processed Units Office', role: 'admin', primary_site_id: SITE },
  });
}

/** The MyMRC-owned row the bridge would have created for this day. */
async function seedMymrcRow(d: any, strippedProgram: number): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "processed_units_daily"
      ("id","site_id","production_date","stripped_program","stripped_non_program",
       "source","created_at","updated_at")
    VALUES ('${NS}-mymrc-row','${SITE}','${DAY_ISO}',${strippedProgram},0,'mymrc',now(),now())
  `);
}

/** The portal mirror row the bridge reads from. */
async function seedMirror(d: any, units: number): Promise<void> {
  await d.$executeRawUnsafe(`
    INSERT INTO "mymrc_processed_mirror"
      ("id","site_id","type","processed_date","program_unit_count","non_program_unit_count",
       "units","payload","first_seen_at","last_seen_at","created_at","updated_at")
    VALUES ('${NS}-mirror-1','${SITE}','Processing','${DAY_ISO}',${units},0,${units},
            '{}'::jsonb, now(), now(), now(), now())
  `);
}


/** Poll `cond` until true, or fail loudly naming what we were waiting for. */
async function waitFor(cond: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Backends currently WAITING on a lock — i.e. the blocked correction. */
const blockedCount = async (d: any): Promise<number> => {
  const rows = (await d.$queryRawUnsafe(
    `SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database()`,
  )) as { n: bigint }[];
  return Number(rows[0]?.n ?? 0);
};

/** Rows of this fixture currently holding an uncommitted row lock. */
const lockedRowCount = async (d: any): Promise<number> => {
  const rows = (await d.$queryRawUnsafe(
    `SELECT count(*)::bigint AS n FROM pg_locks l
       JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'transactionid' AND l.mode = 'ExclusiveLock'
        AND a.datname = current_database() AND a.state = 'idle in transaction'`,
  )) as { n: bigint }[];
  return Number(rows[0]?.n ?? 0);
};

const rowForDay = async (d: any): Promise<any> =>
  d.processedUnitsDaily.findUnique({
    where: { site_id_production_date: { site_id: SITE, production_date: DAY } },
  });

describe.skipIf(!REAL_DB)('ADR-0119 — a manual processed-units correction', () => {
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

  it('takes ownership, so the next MyMRC tick does not overwrite the human', async () => {
    // The portal said 900. The office corrects it to 1234.
    await seedMymrcRow(db, 900);
    await seedMirror(db, 900);

    const { upsertProcessedUnits } = await import('./processed-units');
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 1234,
      strippedNonProgram: 0,
      actorUserId: OFFICE,
    });

    const corrected = await rowForDay(db);
    expect(corrected.stripped_program.toString()).toBe('1234');
    // `expect.soft`: a falsification run must still reach the bridge assertion
    // below, which is the one that measures behaviour rather than a column we
    // just wrote. A hard assertion here would abort first and hide it.
    expect.soft(corrected.source, 'the correction must claim the row').toBe('manual');

    // THE ASSERTION THAT MATTERS. Asserting `source === 'manual'` alone would
    // only be re-reading what we just wrote. The claim is about what the BRIDGE
    // does with it, so the real bridge is run — its `WHERE … source = 'mymrc'`
    // precedence guard must now decline this row.
    const { bridgeProcessedToInventory } = await import('@/lib/mymrc/processed-bridge');
    await bridgeProcessedToInventory({ prisma: db, siteIds: [SITE] });

    const afterTick = await rowForDay(db);
    expect(
      afterTick.stripped_program.toString(),
      "the human's correction must survive the next MyMRC tick",
    ).toBe('1234');
    expect(afterTick.source).toBe('manual');
  });

  it('refuses a day closed by a transaction that commits mid-write', async () => {
    const { upsertProcessedUnits, ProcessedUnitsError } = await import('./processed-units');

    // An open day accepts the entry, as it always did.
    await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 500,
      strippedNonProgram: 0,
      actorUserId: OFFICE,
    });
    expect((await rowForDay(db)).stripped_program.toString()).toBe('500');

    // ── The race, forced deterministically ───────────────────────────────────
    //
    // Closing the day BEFORE calling would not falsify anything: the pre-fix
    // code read `closed_at` as its first statement, so it would see the close
    // and refuse correctly. The defect is the WINDOW — a close that commits
    // between that read and the write — and reproducing it needs the two
    // interleaved, not merely ordered.
    //
    // Postgres gives us the interleaving for free. An uncommitted `UPDATE`
    // holds a row lock, and under READ COMMITTED its change is INVISIBLE to
    // other transactions until it commits. So:
    //
    //   1. `closer` locks the row and stamps `closed_at`, without committing.
    //   2. The correction starts. Its pre-fix read sees `closed_at IS NULL` —
    //      truthfully, at that instant — and proceeds. Its write then blocks on
    //      the lock. The fixed version has no pre-read; its guarded statement
    //      blocks on the same lock.
    //   3. `closer` commits.
    //   4. The write unblocks and re-evaluates against the NEW row version.
    //      The guarded `ON CONFLICT … DO UPDATE … WHERE closed_at IS NULL` now
    //      matches nothing and throws. The pre-fix unguarded `upsert` overwrites
    //      the closed day and resolves.
    const { PrismaClient: PC } = (await import('@prisma/client')) as {
      PrismaClient: typeof PrismaClient;
    };
    const closer = new PC({ datasources: { db: { url: REAL_DB! } } });
    // Warm the connection BEFORE the timed section. A cold Prisma client spends
    // its first query connecting, and a `setTimeout` tuned against a warm client
    // silently lets the correction run before the closer has taken the lock —
    // which is a test that passes for the wrong reason.
    await closer.$queryRawUnsafe('SELECT 1');

    let releaseCloser!: () => void;
    const closerMayCommit = new Promise<void>((r) => {
      releaseCloser = r;
    });

    const closerTx = closer.$transaction(
      async (tx: any) => {
        await tx.$executeRawUnsafe(
          `UPDATE "processed_units_daily" SET "closed_at" = now() WHERE "site_id" = '${SITE}'`,
        );
        await closerMayCommit; // hold the lock, uncommitted
      },
      { timeout: 20_000, maxWait: 10_000 },
    );

    // Wait for the lock to actually be HELD, rather than guessing with a sleep.
    await waitFor(async () => (await lockedRowCount(db)) === 1, 'closer to take the row lock');

    const correction = upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 999,
      strippedNonProgram: 0,
      actorUserId: OFFICE,
    });

    // Wait for the correction to actually be BLOCKED on that lock. This is the
    // interleaving the defect needs, and asserting it happened is what stops
    // this test from silently degrading into "close, then write" — which the
    // pre-fix code also refuses, and which therefore proves nothing.
    await waitFor(async () => (await blockedCount(db)) >= 1, 'correction to block on the lock');

    releaseCloser();
    await closerTx;

    await expect(
      correction,
      'a close committing mid-write must still refuse the correction',
    ).rejects.toBeInstanceOf(ProcessedUnitsError);

    // And nothing moved. A refusal that still changed the number would be the
    // defect wearing an error message.
    const after = await rowForDay(db);
    expect(after.stripped_program.toString(), 'a closed day must not move').toBe('500');
    expect(after.closed_at).not.toBeNull();

    await closer.$disconnect();
  });

  it('still creates a brand-new open day, and marks it manual', async () => {
    const { upsertProcessedUnits } = await import('./processed-units');
    const view = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 42.5,
      strippedNonProgram: 7.5,
      savedUnits: 3,
      materialTicketNumber: 'M-000123',
      employeesCount: 4,
      processorsCount: 2,
      actorUserId: OFFICE,
      notes: 'first entry',
    });

    // The view is built from a re-read of the row that actually committed, so
    // these assertions are about the database, not about the arguments.
    expect(view.strippedProgram).toBe('42.5');
    expect(view.strippedNonProgram).toBe('7.5');
    expect(view.totalStripped).toBe('50');
    expect(view.savedUnits).toBe('3');
    expect(view.materialTicketNumber).toBe('M-000123');
    expect(view.employeesCount).toBe(4);
    expect(view.processorsCount).toBe(2);
    expect(view.source).toBe('manual');
    expect(view.notes).toBe('first entry');
    expect(view.closedAt).toBeNull();

    // The insert path must be audited as an INSERT, not an update — the
    // `(xmax = 0)` discriminator is what tells them apart, and getting it
    // backwards would mislabel every first entry in the audit trail.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'processed_units_daily', row_id: view.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('insert');
  });
});
