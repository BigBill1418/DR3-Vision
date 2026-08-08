// ADR-0082 — the claim, the takeover and the audit, against real Postgres.
//
// ## Why this suite refuses a mocked Prisma
//
// Every load-bearing claim in this file is a claim about POSTGRES, not about our
// TypeScript:
//
//   - the UNIQUE index on `inbound_loads.expected_load_id` refusing a second
//     claim on the same haul,
//   - an UPDATE's WHERE being RE-EVALUATED against the newly committed row after
//     it unblocks (the compare-and-swap that makes takeover atomic),
//   - a row lock actually serialising two transactions that both read the same
//     pre-state.
//
// A fake prisma cannot exhibit any of those; it can only be written to agree
// with them, which makes the test a restatement of the fixture. This codebase
// has shipped "green because the mock lied" more than once, and a claim is the
// record of who is answerable for a truck's count.
//
// ## The two race tests are DETERMINISTIC, not hopeful
//
// A bare `Promise.all([takeover(B), takeover(C)])` is not a race test. If the two
// transactions happen to serialise, B takes it from A and C takes it from B and
// BOTH legitimately succeed — so the suite passes while never exercising the
// window it names, and passes just as happily with the guard deleted. That is the
// shape of a falsification that measures nothing.
//
// So both race tests force the interleaving with a third transaction that holds
// `SELECT … FOR UPDATE` on the contested row while the two contenders complete
// their READS and block on their WRITES. Releasing it guarantees both wrote
// against the same observed pre-state, which is exactly the concurrent window.
//
// Local run:
//   docker run --rm -e POSTGRES_PASSWORD=dr3 -e POSTGRES_USER=dr3 \
//     -e POSTGRES_DB=dr3_test -p 55433:5432 postgres:16-alpine
//   DATABASE_URL=… npx prisma migrate deploy
//   DR3_TEST_DATABASE_URL=$DATABASE_URL npx vitest run load-claim.db.test.ts

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The services under test write through the `@/lib/prisma` singleton
// (DATABASE_URL) while the assertions read their own client
// (DR3_TEST_DATABASE_URL). If those pointed at different databases the suite
// would write to one and check the other, and "one takeover row" would be true
// for the boring reason. Same discipline as `floor-exactly-once.db.test.ts`.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'load-claim.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
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

// Fixture ids are file-scoped (`tk-`) so cleanup never touches rows another
// real-DB suite is mid-way through relying on — vitest runs files in parallel
// against one database.
const SITE = 'tk-site';
const OTHER_SITE = 'tk-site-2';
const A = 'tk-op-a';
const B = 'tk-op-b';
const C = 'tk-op-c';
const CROSS = 'tk-op-cross'; // active operator, but at OTHER_SITE
const INACTIVE = 'tk-op-inactive'; // at SITE, is_active = false
const LOAD = 'tk-load';
const AGG = 'tk-load-agg';
const EXPECTED = 'tk-expected';
const SOURCE = 'tk-source';

let seq = 5000;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

function site(id: string, code: string): string {
  return `
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${id}','${code}','${code.toUpperCase()}','oregon','OR-${code}','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`;
}

function user(id: string, name: string, siteId: string, active = true): string {
  return `
    INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
    VALUES ('${id}','${name}','operator','${siteId}',${active},CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "is_active" = ${active}, "primary_site_id" = '${siteId}'`;
}

/** Wipe the fixture's rows, then rebuild them. Scoped, never a blanket truncate. */
async function seed(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "row_id" LIKE 'tk-%'`);
  await d.$executeRawUnsafe(`DELETE FROM "load_stacks" WHERE "load_id" LIKE 'tk-%'`);
  await d.$executeRawUnsafe(
    `DELETE FROM "idempotency_keys" WHERE "actor_user_id" IN ('${A}','${B}','${C}','${CROSS}','${INACTIVE}')`,
  );
  await d.$executeRawUnsafe(`DELETE FROM "inbound_loads" WHERE "id" LIKE 'tk-%'`);
  await d.$executeRawUnsafe(`DELETE FROM "expected_loads" WHERE "id" LIKE 'tk-%'`);
  await d.$executeRawUnsafe(site(SITE, 'tk'));
  await d.$executeRawUnsafe(site(OTHER_SITE, 'tk2'));
  await d.$executeRawUnsafe(user(A, 'Alma Ruiz', SITE));
  await d.$executeRawUnsafe(user(B, 'Bruno Vega', SITE));
  await d.$executeRawUnsafe(user(C, 'Cira Lopez', SITE));
  await d.$executeRawUnsafe(user(CROSS, 'Cross Site', OTHER_SITE));
  await d.$executeRawUnsafe(user(INACTIVE, 'Retired Operator', SITE, false));
  await d.$executeRawUnsafe(`
    INSERT INTO "sources" ("id","site_id","name","is_active","updated_at")
    VALUES ('${SOURCE}','${SITE}','Kiefer Landfill',true,CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "expected_loads" ("id","site_id","external_mymrc_haul_id","expected_arrival_at",
      "source_id","source_name_at_sync","last_synced_at")
    VALUES ('${EXPECTED}','${SITE}','tk-haul-1',CURRENT_TIMESTAMP,'${SOURCE}','Kiefer Landfill',
      CURRENT_TIMESTAMP)`);
  // A load already claimed by A, mid-count.
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","load_source_type","assigned_operator_id",
      "assigned_at","arrived_at","unload_started_at","updated_at")
    VALUES ('${LOAD}','${SITE}','in_progress','b2b_haul','${A}',
      CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '3 hours',
      CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP)`);
  // An AGGREGATE row — synthesized, not a dock capture. Forced to `arrived` on
  // purpose: in production every aggregate is `verified` and would fail the
  // status gate, so a fixture that mirrored production could not tell whether
  // the source-type gate does anything at all.
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","load_source_type","assigned_operator_id",
      "assigned_at","arrived_at","updated_at")
    VALUES ('${AGG}','${SITE}','arrived','ipad_floor','${A}',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`);
}

/** Audit rows for a load, oldest first. */
async function auditFor(d: any, loadId: string): Promise<any[]> {
  return d.auditLog.findMany({
    where: { table_name: 'inbound_loads', row_id: loadId },
    orderBy: { created_at: 'asc' },
  });
}

/** The takeover rows only — an `insert` row is the original claim, not a handover. */
function takeovers(rows: any[]): any[] {
  return rows.filter((r) => r.action === 'update' && r.after?.reason?.startsWith?.('takeover'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hold a row lock on `inbound_loads.<id>` until the returned `release()` is
 * called. Everything that tries to UPDATE that row queues behind it — which is
 * how both contenders are guaranteed to have finished READING before either
 * WRITES.
 */
async function holdRowLock(
  d: any,
  table: string,
  id: string,
): Promise<{ release: () => void; done: Promise<unknown> }> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let locked!: () => void;
  const acquired = new Promise<void>((r) => {
    locked = r;
  });
  const done = d.$transaction(
    async (tx: any) => {
      await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE "id" = '${id}' FOR UPDATE`);
      locked();
      await gate;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
  await acquired;
  return { release, done };
}

describe.skipIf(!SAME_DB)('ADR-0082 — load claim, takeover and honest attribution', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ── THE HANDOFF'S OWN ACCEPTANCE CRITERION, END TO END ──────────────────
  //
  // "operator A starts a load (claimed by A); operator B takes it over (audit
  // shows B took it from A); B closes it (close attributed to B); no false claim
  // written; the original claim history survives in the audit log."
  it('A starts → B takes over → B closes, and every attribution is truthful', async () => {
    const d = await connect();
    const { startInboundLoad, submitLoad } = await import('@/lib/load-service');
    const { takeOverLoad } = await import('./load-claim');

    // A starts it. The claim is made here, not by a separate call.
    const started = await startInboundLoad({
      expectedLoadId: EXPECTED,
      siteId: SITE,
      operatorUserId: A,
    });
    expect(started.claimed).toBe(true);
    let row = await d.inboundLoad.findUnique({ where: { id: started.id } });
    expect(row.assigned_operator_id).toBe(A);
    expect(row.assigned_at).not.toBeNull();
    const originalClaimAt = row.assigned_at;

    // A goes to lunch. B takes it over.
    const result = await takeOverLoad({
      loadId: started.id,
      operatorUserId: B,
      siteId: SITE,
      idempotencyKey: key(),
      ip: '10.0.0.9',
      userAgent: 'iPad',
    });
    expect(result.outcome).toBe('taken');
    expect(result).toMatchObject({ previousHolder: { userId: A, name: 'Alma Ruiz' } });

    row = await d.inboundLoad.findUnique({ where: { id: started.id } });
    expect(row.assigned_operator_id).toBe(B);
    expect(row.assigned_at.getTime()).toBeGreaterThan(originalClaimAt.getTime());

    // The audit row names B as the ACTOR and A as the outgoing holder. Not a
    // system label: a person pressed the button.
    const rows = await auditFor(d, started.id);
    const handovers = takeovers(rows);
    expect(handovers).toHaveLength(1);
    expect(handovers[0].actor_user_id).toBe(B);
    expect(handovers[0].actor_label).toBeNull();
    expect(handovers[0].before.assigned_operator_id).toBe(A);
    expect(handovers[0].after.assigned_operator_id).toBe(B);
    expect(handovers[0].ip).toBe('10.0.0.9');

    // THE ORIGINAL CLAIM SURVIVES. The row itself only holds the current holder,
    // so if the insert row were missing the chain of custody would begin at B and
    // A's two hours on the dock would have happened to nobody.
    const claim = rows.find((r) => r.action === 'insert');
    expect(claim, "A's original claim is missing from the audit log").toBeTruthy();
    expect(claim.actor_user_id).toBe(A);
    expect(claim.after.assigned_operator_id).toBe(A);

    // B closes it. `submitted_by_id` must be B — the person who actually closed
    // it — even though A started it.
    await d.inboundLoad.update({ where: { id: started.id }, data: { status: 'finished' } });
    await submitLoad({ loadId: started.id, operatorUserId: B, siteId: SITE });
    row = await d.inboundLoad.findUnique({ where: { id: started.id } });
    expect(row.status).toBe('submitted');
    expect(row.submitted_by_id, 'the close must be attributed to the CLOSER').toBe(B);
    expect(row.assigned_operator_id).toBe(B);
  });

  // ── CLOSE ATTRIBUTION, PINNED ON ITS OWN ────────────────────────────────
  //
  // Production 2026-08-08: across 40 submitted loads, `submitted_by_id <>
  // assigned_operator_id` ZERO times. That was not evidence that handoffs do not
  // happen — `assertOwn` refused the submit, so the closer could only ever be the
  // claimer. This test is the thing that keeps the column able to disagree.
  it('the pre-takeover closer can no longer submit — attribution cannot be faked', async () => {
    const { submitLoad } = await import('@/lib/load-service');
    const { takeOverLoad } = await import('./load-claim');
    const d = await connect();

    await takeOverLoad({ loadId: LOAD, operatorUserId: B, siteId: SITE, idempotencyKey: key() });
    await d.inboundLoad.update({ where: { id: LOAD }, data: { status: 'finished' } });

    // A no longer holds it, so A cannot submit it — and therefore cannot be
    // recorded as the closer of a load B closed.
    await expect(
      submitLoad({ loadId: LOAD, operatorUserId: A, siteId: SITE }),
    ).rejects.toMatchObject({ status: 403, reason: 'load_not_assigned_to_operator' });

    const row = await d.inboundLoad.findUnique({ where: { id: LOAD } });
    expect(row.submitted_by_id).toBeNull();
    expect(row.status).toBe('finished');
  });

  // ── FALSIFICATION 1: the takeover compare-and-swap ──────────────────────
  //
  // Two operators tap Take over on the same load at the same instant. Exactly one
  // may win, and — the part that matters for an append-only table — exactly one
  // audit row may claim to have taken it from A.
  //
  // FALSIFIED BY HAND: delete `assigned_operator_id: load.assigned_operator_id`
  // from the `updateMany` WHERE in `takeOverLoad`. Both calls then resolve with
  // `restamped: true`, `audit_log` holds TWO handover rows whose `before` both
  // read `tk-op-a`, and the load's history says A handed it to two different
  // people. Restored after.
  it('two SIMULTANEOUS takeovers: one wins, and only one claims to have taken it from A', async () => {
    const d = await connect();
    const { takeOverLoad } = await import('./load-claim');

    // Force the overlap. Both contenders read (holder = A) and then queue on this
    // lock at their UPDATE, so neither can observe the other's write.
    const lock = await holdRowLock(d, 'inbound_loads', LOAD);

    const bothStarted = Promise.allSettled([
      takeOverLoad({ loadId: LOAD, operatorUserId: B, siteId: SITE, idempotencyKey: key() }),
      takeOverLoad({ loadId: LOAD, operatorUserId: C, siteId: SITE, idempotencyKey: key() }),
    ]);
    await sleep(700); // both are now blocked on the row lock, past their reads
    lock.release();
    await lock.done;
    const [first, second] = await bothStarted;

    // Am.1 — BOTH calls now RESOLVE; the loser reports its outcome as DATA
    // rather than throwing, because a throw is redacted before it reaches the
    // operator. So the winner is counted by outcome, not by promise state.
    for (const r of [first, second]) {
      expect(r.status, `takeover rejected with ${String((r as any).reason)}`).toBe('fulfilled');
    }
    const outcomes = [first, second].map((r) => (r as PromiseFulfilledResult<any>).value);
    const won = outcomes.filter((o) => o.outcome === 'taken');
    const lost = outcomes.filter((o) => o.outcome === 'claim_moved');
    expect(won, 'exactly one taker may win a simultaneous takeover').toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is told WHO holds it, not merely that they lost — "someone else
    // got there first" with no name is the dead end this ADR removes, one level
    // down. The NAME is the thing the redacted-throw version could never deliver.
    expect(lost[0].currentHolder?.name, 'the loser must be able to name the winner').toBeTruthy();
    expect([won[0].loadId, lost[0].loadId]).toEqual([LOAD, LOAD]);

    const handovers = takeovers(await auditFor(d, LOAD));
    expect(handovers, 'two audit rows for one handover is a false history').toHaveLength(1);
    expect(handovers[0].before.assigned_operator_id).toBe(A);

    const row = await d.inboundLoad.findUnique({ where: { id: LOAD } });
    expect([B, C]).toContain(row.assigned_operator_id);
    expect(row.assigned_operator_id).toBe(handovers[0].after.assigned_operator_id);
  });

  // ── FALSIFICATION 2: the atomic claim ───────────────────────────────────
  //
  // Two operators tap the SAME queue row at the same instant. One `inbound_loads`
  // row, one id handed to both, and the loser gets an answer rather than a
  // Postgres error code.
  //
  // FALSIFIED BY HAND: remove the `isExpectedLoadClaimCollision` catch in
  // `startInboundLoad` and the loser rejects with
  // `PrismaClientKnownRequestError { code: 'P2002' }` — which reaches a server
  // action as an opaque digest and the operator as a crash. Removing the
  // in-transaction re-read INSTEAD leaves this test green (the unique index still
  // holds) but reopens the far more common sequential window, which is why
  // `claims the load once when the taps are seconds apart` below exists as a
  // separate test rather than being folded into this one.
  it('two SIMULTANEOUS starts on one haul: one load row, one id, no P2002 escaping', async () => {
    const d = await connect();
    const { startInboundLoad } = await import('@/lib/load-service');

    // The FK insert into `inbound_loads` takes a key-share lock on this parent
    // row, so `FOR UPDATE` here queues both creates after both reads.
    const lock = await holdRowLock(d, 'expected_loads', EXPECTED);

    const both = Promise.allSettled([
      startInboundLoad({ expectedLoadId: EXPECTED, siteId: SITE, operatorUserId: A }),
      startInboundLoad({ expectedLoadId: EXPECTED, siteId: SITE, operatorUserId: B }),
    ]);
    await sleep(700);
    lock.release();
    await lock.done;
    const results = await both;

    for (const r of results) {
      // The specific defect: a raw P2002 out of the loser. Named in the failure
      // message so a red here reads as the real wrong value.
      expect(
        r.status,
        r.status === 'rejected' ? `start rejected with ${String((r as any).reason)}` : '',
      ).toBe('fulfilled');
    }
    const ids = results.map((r) => (r as PromiseFulfilledResult<any>).value.id);
    expect(new Set(ids).size, 'both operators must be sent to the SAME load').toBe(1);
    expect(
      results.filter((r) => (r as PromiseFulfilledResult<any>).value.claimed),
      'exactly one call may report that it made the claim',
    ).toHaveLength(1);

    expect(await d.inboundLoad.count({ where: { expected_load_id: EXPECTED } })).toBe(1);
    // And exactly one claim audit row — two would mean two people are recorded as
    // having started the same truck.
    const claims = (await auditFor(d, ids[0]!)).filter((r) => r.action === 'insert');
    expect(claims).toHaveLength(1);
  });

  it('claims the load once when the taps are SECONDS apart (the in-transaction re-read)', async () => {
    const d = await connect();
    const { startInboundLoad } = await import('@/lib/load-service');

    const first = await startInboundLoad({
      expectedLoadId: EXPECTED,
      siteId: SITE,
      operatorUserId: A,
    });
    // B's queue page has not re-rendered; B taps the same row.
    const second = await startInboundLoad({
      expectedLoadId: EXPECTED,
      siteId: SITE,
      operatorUserId: B,
    });

    expect(second.id).toBe(first.id);
    expect(second.claimed).toBe(false);
    // B did NOT become the assignee by tapping Start. Taking it over is a
    // deliberate, audited act; walking into it by tapping the queue would be the
    // silent overwrite the handoff forbids.
    const row = await d.inboundLoad.findUnique({ where: { id: first.id } });
    expect(row.assigned_operator_id).toBe(A);
    expect(await d.inboundLoad.count({ where: { expected_load_id: EXPECTED } })).toBe(1);
  });

  // ── IDEMPOTENCY: the double-tap ─────────────────────────────────────────
  it('a double-tap with the SAME key re-stamps once and audits once', async () => {
    const d = await connect();
    const { takeOverLoad } = await import('./load-claim');
    const k = key();

    const args = { loadId: LOAD, operatorUserId: B, siteId: SITE, idempotencyKey: k };
    const first = await takeOverLoad(args);
    const row1 = await d.inboundLoad.findUnique({ where: { id: LOAD } });

    // The response was lost; the device retries with the same key.
    const replay = await takeOverLoad(args);
    const row2 = await d.inboundLoad.findUnique({ where: { id: LOAD } });

    expect(first.outcome).toBe('taken');
    expect(takeovers(await auditFor(d, LOAD))).toHaveLength(1);
    // `assigned_at` did not move on the replay — a second re-stamp would rewrite
    // when B took the load over, for an action that changed nothing.
    expect(row2.assigned_at.toISOString()).toBe(row1.assigned_at.toISOString());
    expect(row2.assigned_operator_id).toBe(B);
    // Second call short-circuits on the holder check rather than the idempotency
    // store, because B already holds it by then — either way, one re-stamp.
    expect(replay.outcome).toBe('already_yours');
  });

  it('taking over a load you ALREADY hold writes nothing at all', async () => {
    const d = await connect();
    const { takeOverLoad } = await import('./load-claim');
    const before = await d.inboundLoad.findUnique({ where: { id: LOAD } });

    const result = await takeOverLoad({
      loadId: LOAD,
      operatorUserId: A,
      siteId: SITE,
      idempotencyKey: key(),
    });

    expect(result.outcome).toBe('already_yours');
    const after = await d.inboundLoad.findUnique({ where: { id: LOAD } });
    expect(after.assigned_at.toISOString()).toBe(before.assigned_at.toISOString());
    // An A→A row in an append-only log reads like a handover that never happened.
    expect(takeovers(await auditFor(d, LOAD))).toHaveLength(0);
  });

  // ── REFUSALS ────────────────────────────────────────────────────────────
  describe('who and what may be taken over', () => {
    it('refuses a taker whose site is not the LOAD’s site', async () => {
      const { takeOverLoad } = await import('./load-claim');
      // Woodland and Eugene are strictly separated (CLAUDE.md hard rule #2).
      await expect(
        takeOverLoad({ loadId: LOAD, operatorUserId: CROSS, siteId: OTHER_SITE }),
      ).rejects.toMatchObject({ status: 403, reason: 'load_not_at_this_site' });
    });

    it('refuses a cross-site operator even when the SITE argument is right', async () => {
      const d = await connect();
      const { takeOverLoad } = await import('./load-claim');
      // The dangerous variant: the site argument names the load's site correctly,
      // so the first guard passes — and only the taker's OWN `primary_site_id`
      // stands between an operator at tk2 and a claim at tk. Without this check a
      // caller that resolved the site from the load rather than the session would
      // write a cross-site name into the claim.
      await expect(
        takeOverLoad({ loadId: LOAD, operatorUserId: CROSS, siteId: SITE }),
      ).rejects.toMatchObject({ status: 403, reason: 'taker_not_active_operator_at_site' });
      const row = await d.inboundLoad.findUnique({ where: { id: LOAD } });
      expect(row.assigned_operator_id, 'the claim must be untouched').toBe(A);
    });

    it('refuses a DEACTIVATED operator', async () => {
      const { takeOverLoad } = await import('./load-claim');
      await expect(
        takeOverLoad({ loadId: LOAD, operatorUserId: INACTIVE, siteId: SITE }),
      ).rejects.toMatchObject({ status: 403, reason: 'taker_not_active_operator_at_site' });
    });

    it('refuses a load that has left the dock (submitted)', async () => {
      const d = await connect();
      const { takeOverLoad } = await import('./load-claim');
      await d.inboundLoad.update({ where: { id: LOAD }, data: { status: 'submitted' } });
      // Am.1 — RETURNED, not thrown: reachable without any concurrency (the
      // holder submits while a second operator reads the panel), so it must be
      // able to carry named copy to the screen.
      const r = await takeOverLoad({ loadId: LOAD, operatorUserId: B, siteId: SITE });
      expect(r).toMatchObject({ outcome: 'not_open' });
      expect((r as { currentHolder?: { name: string } }).currentHolder?.name).toBe('Alma Ruiz');
    });

    it('refuses an AGGREGATE row even when its status would otherwise allow it', async () => {
      const { takeOverLoad } = await import('./load-claim');
      // `tk-load-agg` is `ipad_floor` at `arrived`. Nobody stood at a door and
      // counted it, so there is no claim to hand on.
      expect(await takeOverLoad({ loadId: AGG, operatorUserId: B, siteId: SITE })).toMatchObject({
        outcome: 'not_takeable',
      });
    });

    it('allows takeover at EVERY open dock status, including `finished`', async () => {
      const d = await connect();
      const { takeOverLoad } = await import('./load-claim');
      const { TAKEOVER_STATUSES } = await import('./load-claim');
      // `finished` is the worst status to strand — counted, one tap from
      // submission, not yet in inventory or billing. Production is holding one.
      for (const status of TAKEOVER_STATUSES) {
        await d.inboundLoad.update({
          where: { id: LOAD },
          data: { status, assigned_operator_id: A },
        });
        const r = await takeOverLoad({
          loadId: LOAD,
          operatorUserId: B,
          siteId: SITE,
          idempotencyKey: key(),
        });
        expect(r.outcome, `takeover refused at status ${status}`).toBe('taken');
      }
    });
  });
});
