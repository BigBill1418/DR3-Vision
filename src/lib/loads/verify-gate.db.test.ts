// ADR-0118 — the DR3 number is not burned twice, against a REAL Postgres.
//
// `document_sequences` already guarantees that two concurrent issuers get
// DIFFERENT numbers: `issueDocumentNumber` is one `UPDATE … RETURNING`, which
// row-locks for its transaction (`sequences.ts`). What it cannot guarantee is
// that only ONE of them was asked. Before this change, `verifyLoad` decided
// whether to issue from a read taken on the shared client outside its
// transaction, and then wrote with an unguarded `update({ where: { id } })` —
// which succeeds whatever the row's state. Two managers verifying the same
// submitted load both read `status: 'submitted', dr3_number: null`, both drew a
// number, and both wrote.
//
// ## Why this cannot be a mocked-prisma test
//
// Every claim here is about what Postgres does under contention:
//
//   - that the counter row serialises two concurrent `UPDATE … RETURNING`s;
//   - that a guarded `updateMany` matches zero rows for the loser;
//   - and — the one that matters most — that the loser's throw ROLLS THE
//     COUNTER INCREMENT BACK. `sequences.ts:11-14` states that as the reason
//     issuance takes an executor at all: "if that transaction rolls back, the
//     counter increment rolls back with it — a rejected/failed verify never
//     burns a DR3 number." A fake cannot roll back, because it never committed.
//
// So the decisive assertion is arithmetic on a real row: **`next_value`
// advances by exactly 1** across two racing verifies. Pre-fix it advances by 2
// and one of those numbers is attached to nothing.
//
// ── FALSIFIED BY HAND (2026-08-19) ───────────────────────────────────────────
//
// Restoring the unguarded write — `tx.inboundLoad.update({ where: { id } })`
// with no `count === 0` throw, which is the shape on `main` — makes both
// verifies succeed and the counter advance by 2:
//     → exactly one verify may succeed: expected [ … ] to have a length of 1 but got 2
//     → the loser's DR3 number must roll back into the sequence: expected 2 to be 1
//
// Both are reported in the SAME run because the two headline claims use
// `expect.soft`. A hard assertion on the first would abort before the counter
// arithmetic — the very thing this suite exists to measure — was ever read.
//
// Runs in the ADR-0078 real-database CI lane (`db.test.ts` path filter).

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// `verifyLoad` writes through the `@/lib/prisma` singleton (DATABASE_URL) while
// the assertions below read their own client (DR3_TEST_DATABASE_URL). The CI
// lane sets both to the same value on purpose; if they diverged, the service
// would write one database and this suite would check another, and "exactly one
// number was issued" would be true for the boring reason.
if (REAL_DB && process.env['DATABASE_URL'] !== REAL_DB) {
  throw new Error(
    'verify-gate.db.test.ts requires DATABASE_URL === DR3_TEST_DATABASE_URL — ' +
      'otherwise the service writes one database and the assertions read another.',
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let db: any;

const NS = 'adr0119-dr3num';
const SITE = `${NS}-site`;
const MANAGER = `${NS}-manager`;
const SOURCE = `${NS}-source`;
// A FRESH load id per test. `audit_log` is append-only (hard rule #6) and this
// suite must never delete from it, so audit rows for earlier runs of the same
// fixture survive in a shared CI database. Asserting "exactly one audit row"
// against a FIXED id would count every previous run's rows and fail on the
// second execution — a suite that only passes once is not a guard.
let LOAD = '';

// CALIFORNIA — `siteGetsVisionDr3Number` issues only for CA sites. An Oregon
// fixture would make every assertion below vacuously true.
const SITE_FIELDS = {
  code: NS,
  name: 'DR3 Number Race Probe',
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

const FIRST_NUMBER = 5000;

async function cleanup(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "site_id" = '${SITE}'`);
  await d.$executeRawUnsafe(`DELETE FROM "document_sequences" WHERE "site_id" = '${SITE}'`);
}

async function seed(d: any): Promise<void> {
  await cleanup(d);
  LOAD = `${NS}-load-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
  await d.site.upsert({ where: { id: SITE }, update: {}, create: { id: SITE, ...SITE_FIELDS } });
  // Hard rule #6 — the audit log is append-only and `actor_user_id` FKs to
  // `users`, so the actor row is left standing across teardown.
  await d.user.upsert({
    where: { id: MANAGER },
    update: {},
    create: { id: MANAGER, name: 'DR3 Race Probe Manager', role: 'manager', primary_site_id: SITE },
  });
  await d.source.upsert({
    where: { id: SOURCE },
    update: {},
    create: { id: SOURCE, site_id: SITE, name: 'DR3 Race Probe Yard' },
  });
  await d.documentSequence.create({
    data: { site_id: SITE, sequence_code: 'dr3_number', next_value: FIRST_NUMBER },
  });
  await d.inboundLoad.create({
    data: {
      id: LOAD,
      site_id: SITE,
      source_id: SOURCE,
      status: 'submitted',
      arrived_at: new Date('2026-08-07T15:00:00.000Z'),
      total_units: 40,
    },
  });
}

const nextValue = async (d: any): Promise<number> =>
  (
    await d.documentSequence.findUniqueOrThrow({
      where: { site_id_sequence_code: { site_id: SITE, sequence_code: 'dr3_number' } },
      select: { next_value: true },
    })
  ).next_value;

describe.skipIf(!REAL_DB)('ADR-0118 — a raced verify burns exactly one DR3 number', () => {
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

  it('two managers verifying one load: one wins, one number issued, the loser rolls back', async () => {
    expect(await nextValue(db)).toBe(FIRST_NUMBER);

    const { verifyLoad, VerifyGateError } = await import('./verify-gate');

    const settled = await Promise.allSettled([
      verifyLoad({ loadId: LOAD, siteId: SITE, verifierUserId: MANAGER }),
      verifyLoad({ loadId: LOAD, siteId: SITE, verifierUserId: MANAGER }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // `expect.soft` on the two headline claims: a falsification run must report
    // BOTH the double-success and the double-burn, not abort on the first and
    // leave the counter arithmetic — the assertion this suite exists for —
    // unevaluated.
    expect.soft(fulfilled, 'exactly one verify may succeed').toHaveLength(1);
    if (rejected.length !== 1) {
      // Pre-fix there is no rejection to inspect; skip the error-shape checks
      // rather than throwing a TypeError that would mask the counter result.
      expect.soft(rejected, 'exactly one verify must be refused').toHaveLength(1);
      expect.soft(
        (await nextValue(db)) - FIRST_NUMBER,
        "the loser's DR3 number must roll back into the sequence",
      ).toBe(1);
      return;
    }

    // A translatable reason and a 409, not a raw enum or a leaked message —
    // `loadsErrorResponse` renders `{ error: reason }` at `e.status`.
    const err = rejected[0]!.reason as InstanceType<typeof VerifyGateError>;
    expect(err).toBeInstanceOf(VerifyGateError);
    expect(err.reason).toBe('concurrent_verify');
    expect(err.status).toBe(409);

    // THE ASSERTION. `document_sequences` guarantees the two issuers would get
    // DIFFERENT numbers; it cannot stop both from asking. The loser's ask is
    // undone by its own rollback, which is the property `sequences.ts:11-14`
    // says the executor parameter exists for. Pre-fix this reads 2.
    expect.soft(
      (await nextValue(db)) - FIRST_NUMBER,
      "the loser's DR3 number must roll back into the sequence",
    ).toBe(1);

    // The number the load carries is the FIRST one off the counter — nothing
    // was skipped, and the load is not holding a number the sequence never
    // recorded handing out.
    const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: LOAD } });
    expect(row.status).toBe('verified');
    expect(row.dr3_number).toBe(String(FIRST_NUMBER));
    expect(row.program_unit_count).toBe(40);
    expect(row.non_program_unit_count).toBe(0);

    // Hard rule #6 — one verify, one audit row. Two would mean the losing
    // transaction left a record of a decision it did not make.
    const audits = await db.auditLog.findMany({
      where: { table_name: 'inbound_loads', row_id: LOAD, action: 'update' },
    });
    expect(audits).toHaveLength(1);
  });

  it('a load that already carries a DR3 number verifies without being refused', async () => {
    // The guard adds `dr3_number: null` ONLY when issuing. A load that arrived
    // with a number from another path (a MyMRC import) is verified without
    // issuing one, and must not be refused for holding it — a guard that always
    // demanded `dr3_number: null` would 409 every one of them.
    await db.inboundLoad.update({ where: { id: LOAD }, data: { dr3_number: 'MYMRC-77' } });

    const { verifyLoad } = await import('./verify-gate');
    await verifyLoad({ loadId: LOAD, siteId: SITE, verifierUserId: MANAGER });

    const row = await db.inboundLoad.findUniqueOrThrow({ where: { id: LOAD } });
    expect(row.status).toBe('verified');
    expect(row.dr3_number, 'the existing number must survive the verify').toBe('MYMRC-77');
    // No number was drawn, so the counter has not moved at all.
    expect(await nextValue(db)).toBe(FIRST_NUMBER);
  });
});
