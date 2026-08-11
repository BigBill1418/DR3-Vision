// ADR-0090 Amendment 1 (B) — going back, against real Postgres.
//
// ## Why this suite refuses a mocked Prisma
//
// Every load-bearing claim in this file is a claim about POSTGRES, not about our
// TypeScript:
//
//   - `unload_duration_seconds` is frozen by a conditional UPDATE whose WHERE is
//     `unload_duration_seconds IS NULL`. A fake client can be written to agree
//     that the second write "did nothing"; only the database can demonstrate it.
//   - both `finishUnload` sum sites filtering `voided_at IS NULL` is a claim
//     about what a SELECT returns, and the dangerous one (the ADR-0078 D7 late
//     recompute) only runs on a row that is already `finished`.
//   - the `addStack` P2002 convergence check refusing a VOIDED row depends on
//     the real UNIQUE index raising the real error code.
//
// A fake prisma cannot exhibit any of those; it can only be written to agree
// with them, which makes the test a restatement of the fixture. Same discipline
// as `load-claim.db.test.ts` beside it.
//
// ## The freeze is the product decision, so it gets the strictest test
//
// Bill, 2026-08-10: a reopened load keeps the duration computed at the FIRST
// finish; a re-finish must not recompute it. `unload_duration_seconds` feeds
// throughput and productivity surfaces, so a re-finish that recomputed would add
// the entire reopen gap — an operator who went back to fix a count would look
// like an operator who took twenty minutes longer to unload the truck. The test
// therefore reopens with a MEASURABLE gap and asserts the stored integer is
// byte-identical, not merely "close".
//
// Local run:
//   docker run --rm -e POSTGRES_PASSWORD=dr3 -e POSTGRES_USER=dr3 \
//     -e POSTGRES_DB=dr3_test -p 55437:5432 postgres:16-alpine
//   DATABASE_URL=… npx prisma migrate deploy
//   DR3_TEST_DATABASE_URL=$DATABASE_URL DATABASE_URL=$DATABASE_URL \
//     npx vitest run back-navigation.db.test.ts

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  addStack,
  beginUnload,
  correctWeight,
  finishUnload,
  reopenLoad,
  voidLoad,
  voidStack,
} from '@/lib/load-service';
import { OPEN_DOCK_STATUSES } from '@/lib/loads/open-loads';
import { toConsumedLoad } from '@/lib/loads/consumed-slot';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The service under test writes through the `@/lib/prisma` singleton
// (DATABASE_URL) while the assertions read their own client
// (DR3_TEST_DATABASE_URL). If those pointed at different databases the suite
// would write to one and check the other, and every assertion would be true for
// the boring reason.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'back-navigation.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
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

// Fixture ids are file-scoped (`bn-`) so cleanup never touches rows another
// real-DB suite is mid-way through relying on — vitest runs files in parallel
// against one database.
const SITE = 'bn-site';
const OP = 'bn-op';
const OTHER = 'bn-op-other';
const LOAD = 'bn-load';

let seq = 9000;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

/**
 * The load, mid-count, with its unload started a known number of seconds ago.
 *
 * `unload_started_at` is pinned relative to `CURRENT_TIMESTAMP` so the first
 * finish produces a duration this suite can predict to the second, which is what
 * makes "the second finish did not change it" a real assertion rather than a
 * comparison of two numbers nobody knows.
 */
const STARTED_SECONDS_AGO = 600;

async function seed(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "row_id" LIKE 'bn-%'`);
  await d.$executeRawUnsafe(`DELETE FROM "load_stacks" WHERE "load_id" LIKE 'bn-%'`);
  await d.$executeRawUnsafe(
    `DELETE FROM "idempotency_keys" WHERE "actor_user_id" IN ('${OP}','${OTHER}')`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "id" LIKE 'bn-%'`);
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${SITE}','bn','BN','oregon','OR-bn','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  for (const [id, name] of [
    [OP, 'Janette Tomas'],
    [OTHER, 'Marisol Reyes'],
  ]) {
    await d.$executeRawUnsafe(`
      INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
      VALUES ('${id}','${name}','operator','${SITE}',true,CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`);
  }
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","load_source_type","assigned_operator_id",
      "assigned_at","arrived_at","unload_started_at","updated_at")
    VALUES ('${LOAD}','${SITE}','in_progress','b2b_haul','${OP}',
      CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '3 hours',
      CURRENT_TIMESTAMP - INTERVAL '${STARTED_SECONDS_AGO} seconds', CURRENT_TIMESTAMP)`);
}

const own = { loadId: LOAD, operatorUserId: OP, siteId: SITE } as const;

async function load(d: any): Promise<any> {
  return d.inboundLoad.findUnique({ where: { id: LOAD } });
}

async function auditFor(d: any, table: string, rowId: string): Promise<any[]> {
  return d.auditLog.findMany({
    where: { table_name: table, row_id: rowId },
    orderBy: { created_at: 'asc' },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SAME_DB)('ADR-0090 Am.1 — the duration is frozen at the FIRST finish', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('the first finish computes the duration from `unload_started_at`', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 40, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });

    const row = await load(await connect());
    expect(row.status).toBe('finished');
    expect(row.total_units).toBe(40);
    // Wall-clock tolerance of a couple of seconds; the point is that it is
    // ~STARTED_SECONDS_AGO and not zero.
    expect(row.unload_duration_seconds).toBeGreaterThanOrEqual(STARTED_SECONDS_AGO - 5);
    expect(row.unload_duration_seconds).toBeLessThanOrEqual(STARTED_SECONDS_AGO + 5);
  });

  it('THE DECISION: reopen + re-finish after a gap does NOT inflate the duration', async () => {
    // Bill, 2026-08-10. `unload_duration_seconds` feeds throughput and
    // productivity surfaces; recomputing on a re-finish would charge the
    // operator for the time they spent CORRECTING the record, which is the
    // opposite of what the number is read as.
    await addStack({ ...own, stackIndex: 1, unitCount: 47, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });

    const d = await connect();
    const first = await load(d);
    const frozen = first.unload_duration_seconds;
    const frozenFinishedAt = first.unload_finished_at.toISOString();

    await reopenLoad(own);
    // A MEASURABLE gap. Without the freeze the re-finish adds this to the
    // duration, so an assertion of strict equality can only pass if the second
    // write genuinely did not touch the column.
    await sleep(1200);
    await finishUnload({ ...own, countMode: 'ledger' });

    const after = await load(d);
    expect(after.status).toBe('finished');
    expect(after.unload_duration_seconds).toBe(frozen);
    // The paired timestamp is frozen too. Freezing the duration while advancing
    // `unload_finished_at` would leave the two disagreeing, and the schema
    // comment on the column says it is `unload_started_at -> unload_finished_at`.
    expect(after.unload_finished_at.toISOString()).toBe(frozenFinishedAt);
  });

  it('the re-finish still RECOUNTS: a stack voided during the reopen leaves the total', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 30, countMode: 'ledger' });
    await addStack({ ...own, stackIndex: 2, unitCount: 17, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });

    const d = await connect();
    expect((await load(d)).total_units).toBe(47);

    await reopenLoad(own);
    const stack2 = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 2 } },
    });
    await voidStack({ ...own, stackId: stack2.id });
    await finishUnload({ ...own, countMode: 'ledger' });

    // 47 was wrong; 30 is the corrected count. This is the whole point of the
    // reopen — the duration is frozen, the COUNT is not.
    expect((await load(d)).total_units).toBe(30);
  });

  it('the reopen is audited: actor, instant, from and to', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 12, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });
    await reopenLoad(own);

    const d = await connect();
    const rows = await auditFor(d, 'inbound_loads', LOAD);
    const reopen = rows.filter((r) => r.after?.reason === 'reopened_for_correction');
    expect(reopen).toHaveLength(1);
    expect(reopen[0]!.actor_user_id).toBe(OP);
    expect(reopen[0]!.before).toMatchObject({ status: 'finished' });
    expect(reopen[0]!.after).toMatchObject({ status: 'in_progress' });
    expect(reopen[0]!.created_at).toBeInstanceOf(Date);
  });

  it('THE WIDENING GUARD: `beginUnload` still refuses a finished load', async () => {
    // ADR-0090 Am.1 added `finished` to `ALLOWED_PRIOR.in_progress` so the
    // reopen edge is declared in the one table that states the machine. That
    // widening must not hand the edge to the OTHER writer that lands on
    // `in_progress`: a hand-crafted POST to `beginUnloadAction` would otherwise
    // reopen a finished load through the door-open path, with no reopen reason
    // on the audit row and no operator intent behind it. `beginUnload` narrows
    // with `allowedFrom: ['unload_started']`.
    await addStack({ ...own, stackIndex: 1, unitCount: 8, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });

    await expect(beginUnload(own)).rejects.toMatchObject({ status: 409 });
    expect((await load(await connect())).status).toBe('finished');
  });

  it('a reopened load still CONSUMES its haul slot — it is live work again', async () => {
    // The opposite of the void, which severs the slot precisely because the load
    // was never real. A reopened load is being worked, so the real truck must
    // not be able to check in underneath it and mint a second child.
    await addStack({ ...own, stackIndex: 1, unitCount: 8, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });
    await reopenLoad(own);

    const d = await connect();
    const row = await load(d);
    expect(OPEN_DOCK_STATUSES).toContain(row.status);
    expect(
      toConsumedLoad({
        status: row.status,
        total_units: row.total_units,
        submitted_at: row.submitted_at,
      })?.open,
    ).toBe(true);
  });

  it('the void stays reachable across a reopen', async () => {
    // `ALLOWED_PRIOR.voided` lists both `in_progress` and `finished`, so the
    // reopen moves the load between two equally voidable states and changes
    // nothing about that set. Asserted through the service rather than by
    // reading the table, because the table is not exported and a restatement of
    // a constant is not a test.
    await addStack({ ...own, stackIndex: 1, unitCount: 8, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });
    await reopenLoad(own);
    await voidLoad({ ...own, reason: 'wrong_haul', note: null });

    expect((await load(await connect())).status).toBe('voided');
  });

  it('reopen is the HOLDER only, and only from `finished`', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 5, countMode: 'ledger' });

    // Still `in_progress` — there is nothing to reopen.
    await expect(reopenLoad(own)).rejects.toMatchObject({ status: 409 });

    await finishUnload({ ...own, countMode: 'ledger' });
    await expect(
      reopenLoad({ loadId: LOAD, operatorUserId: OTHER, siteId: SITE }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe.skipIf(!SAME_DB)('ADR-0090 Am.1 — a voided stack leaves BOTH billed sums', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  it('the primary sum excludes it', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 20, countMode: 'ledger' });
    await addStack({ ...own, stackIndex: 2, unitCount: 9, countMode: 'ledger' });

    const d = await connect();
    const two = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 2 } },
    });
    await voidStack({ ...own, stackId: two.id });
    await finishUnload({ ...own, countMode: 'ledger' });

    expect((await load(d)).total_units).toBe(20);
  });

  it('THE REPLAY PATH: the ADR-0078 D7 late recompute excludes it too', async () => {
    // The dangerous one. `finishUnload`'s replay branch runs on an ALREADY
    // finished load and rewrites `total_units` from a fresh sum. Filtering the
    // primary sum and not this one would let any keyed retry — a dropped
    // response on a flaky dock connection is the ordinary case — silently
    // RESTORE the voided units into a billed total, with the load looking
    // perfectly healthy afterwards.
    await addStack({ ...own, stackIndex: 1, unitCount: 20, countMode: 'ledger' });
    await addStack({ ...own, stackIndex: 2, unitCount: 9, countMode: 'ledger' });
    await finishUnload({ ...own, countMode: 'ledger' });

    const d = await connect();
    await reopenLoad(own);
    const two = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 2 } },
    });
    await voidStack({ ...own, stackId: two.id });
    await finishUnload({ ...own, countMode: 'ledger' });
    expect((await load(d)).total_units).toBe(20);

    // Now the replay: same load, already `finished`, called WITH a key.
    await finishUnload({ ...own, countMode: 'ledger', idempotencyKey: key() });
    expect((await load(d)).total_units).toBe(20);
  });

  it('the void is audited against the STACK row, and the row survives', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 11, countMode: 'ledger' });
    const d = await connect();
    const one = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 1 } },
    });
    await voidStack({ ...own, stackId: one.id });

    // Soft, never a delete: the operator DID count it, and the audit row has to
    // point at something that still exists.
    const still = await d.loadStack.findUnique({ where: { id: one.id } });
    expect(still).not.toBeNull();
    expect(still.unit_count).toBe(11);
    expect(still.voided_at).toBeInstanceOf(Date);
    expect(still.voided_by).toBe(OP);

    const rows = await auditFor(d, 'load_stacks', one.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_user_id).toBe(OP);
    expect(rows[0]!.before).toMatchObject({ unit_count: 11 });
  });

  it('a second void of the same stack is a no-op, not an error or a second audit row', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 11, countMode: 'ledger' });
    const d = await connect();
    const one = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 1 } },
    });
    await voidStack({ ...own, stackId: one.id });
    const firstAt = (await d.loadStack.findUnique({ where: { id: one.id } })).voided_at;

    await voidStack({ ...own, stackId: one.id });

    // The FIRST void is the one that happened — same shape as `voidLoad`.
    expect((await d.loadStack.findUnique({ where: { id: one.id } })).voided_at).toEqual(firstAt);
    expect(await auditFor(d, 'load_stacks', one.id)).toHaveLength(1);
  });

  it('a stack belonging to someone else’s load cannot be voided', async () => {
    await addStack({ ...own, stackIndex: 1, unitCount: 11, countMode: 'ledger' });
    const d = await connect();
    const one = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 1 } },
    });
    await expect(
      voidStack({ loadId: LOAD, operatorUserId: OTHER, siteId: SITE, stackId: one.id }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('a stackId from a DIFFERENT load is refused, not voided', async () => {
    // The id comes from the client. Without this check an operator holding load
    // A could name a stack on load B and silently remove units from a load they
    // do not hold — and both loads would look healthy afterwards.
    await addStack({ ...own, stackIndex: 1, unitCount: 11, countMode: 'ledger' });
    const d = await connect();
    await d.$executeRawUnsafe(`
      INSERT INTO "inbound_loads" ("id","site_id","status","load_source_type",
        "assigned_operator_id","assigned_at","arrived_at","unload_started_at","updated_at")
      VALUES ('bn-load-2','${SITE}','in_progress','b2b_haul','${OP}',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
    await addStack({
      loadId: 'bn-load-2',
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 1,
      unitCount: 3,
      countMode: 'ledger',
    });
    const foreign = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: 'bn-load-2', stack_index: 1 } },
    });

    await expect(voidStack({ ...own, stackId: foreign.id })).rejects.toMatchObject({ status: 404 });
    expect((await d.loadStack.findUnique({ where: { id: foreign.id } })).voided_at).toBeNull();
  });
});

describe.skipIf(!SAME_DB)('ADR-0090 Am.1 — the replay cannot resurrect a voided stack', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  it('THE CONVERGENCE TRAP: a keyed replay onto a voided index is a 409, not a false 201', async () => {
    // The sequence: a stack lands, its response is lost so the queue entry is
    // retained, the operator voids the stack, and the queue replays. The
    // byte-for-byte convergence check would find a matching row and report
    // success — the replay loop then deletes the entry, and a stack of
    // mattresses is gone from a billed total with no record anywhere that the
    // replay ever happened. The honest outcome is a hard 4xx, which parks the
    // entry as a conflict with its payload intact for a person.
    const k = key();
    await addStack({ ...own, stackIndex: 1, unitCount: 25, countMode: 'ledger' });
    const d = await connect();
    const one = await d.loadStack.findUnique({
      where: { load_id_stack_index: { load_id: LOAD, stack_index: 1 } },
    });
    await voidStack({ ...own, stackId: one.id });

    await expect(
      addStack({ ...own, stackIndex: 1, unitCount: 25, countMode: 'ledger', idempotencyKey: k }),
    ).rejects.toMatchObject({ status: 409, reason: 'stack_index_conflict' });

    // And the void stands.
    expect((await d.loadStack.findUnique({ where: { id: one.id } })).voided_at).not.toBeNull();
  });

  it('an ordinary keyed replay onto a LIVE identical row still converges silently', async () => {
    // The behaviour ADR-0078 D6 added must survive this change: a genuine
    // double-tap on a live row is still success, not a new 409.
    await addStack({ ...own, stackIndex: 1, unitCount: 25, countMode: 'ledger' });
    await expect(
      addStack({
        ...own,
        stackIndex: 1,
        unitCount: 25,
        countMode: 'ledger',
        idempotencyKey: key(),
      }),
    ).resolves.toBeUndefined();
  });

  it('OPEN-ITEMS 0.AX: a replay cannot DOUBLE a total — it converges or it refuses', async () => {
    // Filed 2026-08-10: six loads carry exactly 2.000x MRC's unit count, with the
    // hypothesis that it is "the finishUnload/replay double-add". This pins the
    // half of that a test can settle, and it settles it NEGATIVE — the replay
    // path cannot produce a doubled total by either of its two routes:
    //
    //   - `addStack` — a queued entry carries its ORIGINAL `stackIndex` in the
    //     payload (see `persistStack` in stage-stacks.tsx), so a replay always
    //     targets the row it was for. It converges on it or it 409s; it can never
    //     land at a fresh index and add a second row.
    //   - `finishUnload` — the ADR-0078 D7 branch RECOMPUTES `total_units` from a
    //     fresh sum. Recomputing is idempotent by construction; there is no
    //     accumulation anywhere in it.
    //
    // What that leaves as the live hypothesis is a genuine DOUBLE-ENTRY: two taps
    // that mint two different keys with two different indexes — trivially easy in
    // `total` count mode, where re-typing a total the operator believes did not
    // save produces exactly 2.000x and nothing else. Until this branch the floor
    // had no way to take one back; `voidStack` and the review panel's stack list
    // are that way. Confirming the mechanism needs the six loads' `load_stacks`
    // rows, which this test cannot reach.
    await addStack({ ...own, stackIndex: 1, unitCount: 25, countMode: 'total' });
    await addStack({
      ...own,
      stackIndex: 1,
      unitCount: 25,
      countMode: 'total',
      idempotencyKey: key(),
    });
    await finishUnload({ ...own, countMode: 'total' });
    await finishUnload({ ...own, countMode: 'total', idempotencyKey: key() });

    const d = await connect();
    expect(await d.loadStack.count({ where: { load_id: LOAD } })).toBe(1);
    expect((await load(d)).total_units).toBe(25);
  });
});

describe.skipIf(!SAME_DB)('ADR-0090 Am.1 — the weight is correctable in place', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  it('overwrites the value and APPENDS an audit row — never mutates the first', async () => {
    const d = await connect();
    await d.$executeRawUnsafe(
      `UPDATE "inbound_loads" SET "weight_lbs" = 12000, "status" = 'weight_captured' WHERE "id" = '${LOAD}'`,
    );

    await correctWeight({ ...own, weightLbs: 21000 });

    const row = await load(d);
    expect(row.weight_lbs).toBe(21000);
    // NO status transition. A correction is not a stage move; changing the
    // status would send the operator back through the door-open stage.
    expect(row.status).toBe('weight_captured');

    const rows = await auditFor(d, 'inbound_loads', LOAD);
    const corrections = rows.filter((r) => r.after?.reason === 'weight_corrected');
    expect(corrections).toHaveLength(1);
    expect(corrections[0]!.before).toMatchObject({ weight_lbs: 12000 });
    expect(corrections[0]!.after).toMatchObject({ weight_lbs: 21000 });

    // A second correction appends a SECOND row. The first record of the first
    // value is never rewritten — CLAUDE.md hard rule #6.
    await correctWeight({ ...own, weightLbs: 19500 });
    const after = await auditFor(d, 'inbound_loads', LOAD);
    expect(after.filter((r) => r.after?.reason === 'weight_corrected')).toHaveLength(2);
  });

  it('is refused once the load has left the floor’s hands', async () => {
    const d = await connect();
    await d.$executeRawUnsafe(
      `UPDATE "inbound_loads" SET "status" = 'submitted' WHERE "id" = '${LOAD}'`,
    );
    await expect(correctWeight({ ...own, weightLbs: 21000 })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('holds the same 1..100,000 lb range as the capture', async () => {
    await expect(correctWeight({ ...own, weightLbs: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(correctWeight({ ...own, weightLbs: 100_001 })).rejects.toMatchObject({
      status: 422,
    });
    await expect(correctWeight({ ...own, weightLbs: 1.5 })).rejects.toMatchObject({ status: 422 });
  });
});
