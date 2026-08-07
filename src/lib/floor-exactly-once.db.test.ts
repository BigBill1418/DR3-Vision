// ADR-0078 D2/D3/D6 — exactly-once for the dock writes, against real Postgres.
//
// Three defects converge on the same fixture, so they share one:
//
//   D2  a queued stack replayed twice must add ONE stack, and `finishUnload`'s
//       total — which is billed — must reflect that.
//   D3  a photo confirm whose response was lost must, on replay, produce ONE
//       `load_photos` row even though the replay re-mints a different R2 key.
//   D6  a double-tap on the same stack index must be a SUCCESS, not a failure
//       message for a write that landed.
//
// Real database, for the same reason as `idempotency.db.test.ts`: every claim
// here is about a constraint or a transaction. `@@unique(load_id, stack_index)`
// raising P2002, a claim rolling back with its write — a fake prisma can only be
// written to agree with those, which would make the test a restatement of the
// fixture rather than a check on the system.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// `load-service` writes through the `@/lib/prisma` singleton, which reads
// DATABASE_URL — while the assertions below read `DR3_TEST_DATABASE_URL`. If
// those two point at different databases the suite would write to one and check
// the other, and "0 duplicate rows" would be true for the boring reason. Both
// must name the same database or the suite does not run at all.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'floor-exactly-once.db.test.ts: set DATABASE_URL to the same value as DR3_TEST_DATABASE_URL — ' +
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

const SITE = 'xo-site';
const OP = 'xo-operator';
const LOAD = 'xo-load';

let seq = 1000;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

async function seed(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "load_photos" WHERE "load_id" = '${LOAD}'`);
  await d.$executeRawUnsafe(`DELETE FROM "load_stacks" WHERE "load_id" = '${LOAD}'`);
  await d.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "row_id" = '${LOAD}'`);
  // Scoped to this file's actor — see the note in idempotency.db.test.ts. A
  // blanket truncate here raced the other real-DB suite.
  await d.$executeRawUnsafe(`DELETE FROM "idempotency_keys" WHERE "actor_user_id" = '${OP}'`);
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${SITE}','xo','XO','oregon','OR-X','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","primary_site_id","updated_at")
    VALUES ('${OP}','XO Operator','operator','${SITE}',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","assigned_operator_id",
      "unload_started_at","arrived_at","updated_at")
    VALUES ('${LOAD}','${SITE}','in_progress','${OP}',
      CURRENT_TIMESTAMP - INTERVAL '10 minutes', CURRENT_TIMESTAMP - INTERVAL '30 minutes',
      CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "status" = 'in_progress'`);
}

describe.skipIf(!SAME_DB)('ADR-0078 — dock writes land exactly once', () => {
  beforeEach(async () => {
    const d = await connect();
    await seed(d);
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ── FALSIFICATION 5: replay.exactly-once ────────────────────────────────
  //
  // A stack queued offline, then replayed TWICE (the sweep runs, its response is
  // lost, the sweep runs again). One row, and the billed total is right.
  //
  // FALSIFIED BY HAND: passing `idempotencyKey: null` — the pre-ADR-0078 call —
  // makes the second replay raise P2002 on `@@unique(load_id, stack_index)`, and
  // removing that unique index as well produces the true defect: TWO stacks and
  // `total_units` of 20 for ten mattresses.
  it('a queued stack replayed twice adds ONE stack and one correct total', async () => {
    const d = await connect();
    const { addStack, finishUnload } = await import('./load-service');
    const k = key();

    const call = () =>
      addStack({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        stackIndex: 1,
        unitCount: 10,
        countMode: 'multiplier',
        idempotencyKey: k,
      });

    await call();
    await call(); // the replay

    const stacks = await d.loadStack.findMany({ where: { load_id: LOAD } });
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.unit_count).toBe(10);

    await finishUnload({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      countMode: 'multiplier',
      idempotencyKey: key(),
    });
    const load = await d.inboundLoad.findUnique({ where: { id: LOAD } });
    // Ten mattresses were unloaded. The billed figure must say ten.
    expect(load.total_units).toBe(10);
    expect(load.status).toBe('finished');
  });

  // ── FALSIFICATION 9: stacks.double-tap-not-false-failure ────────────────
  //
  // FALSIFIED BY HAND: deleting the `if (duplicate && args.idempotencyKey) return;`
  // branch in `addStack` makes this reject with P2002 — the false failure an
  // operator answers by re-entering a count that is already recorded.
  it('a double-tap on the same index is a success, with one row and no error', async () => {
    const d = await connect();
    const { addStack } = await import('./load-service');

    // TWO DIFFERENT KEYS, and that is the whole point of this test.
    //
    // A real double-tap mints a key per tap, so the two calls do NOT share one.
    // `nextIndex` is derived from state the first response has not yet updated,
    // so both taps claim index 1 and the second reaches the insert — which is
    // where `@@unique(load_id, stack_index)` refuses it with P2002.
    //
    // Written with a single shared key first, this test passed with the
    // tolerance branch deleted: `withIdempotency` short-circuits on the second
    // call and never reaches the insert, so the assertion was measuring the
    // idempotency path and not the P2002 path it names. The falsification
    // staying green is what exposed that — recorded here because a guard that
    // cannot go red is worse than no guard.
    const first = key();
    const second = key();

    await addStack({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 1,
      unitCount: 4,
      countMode: 'ledger',
      idempotencyKey: first,
    });
    await expect(
      addStack({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        stackIndex: 1,
        unitCount: 4,
        countMode: 'ledger',
        idempotencyKey: second,
      }),
    ).resolves.toBeUndefined();

    expect(await d.loadStack.count({ where: { load_id: LOAD } })).toBe(1);
  });

  // ── REGRESSION (adversarial review, BLOCKER 1) ──────────────────────────
  //
  // The P2002 tolerance must absorb a DOUBLE-TAP and refuse a COLLISION, and
  // the only thing separating those is whether the existing row is this write.
  //
  // How this gets reached with no concurrency at all: a stack fails offline and
  // is queued at index 3, the optimistic render is lost to a reload, the server
  // still shows [1,2] so `nextIndex` recomputes to 3, and the operator's NEXT
  // stack is written at index 3. The queued entry then replays into an index
  // that is occupied by a different stack. Absorbing that returns 201, the
  // replay loop deletes the queued row, and a stack of mattresses disappears
  // from a billed total with no record anywhere.
  //
  // The first version of the double-tap test above used the same `unitCount`
  // for both calls and so could not tell these apart — it passed either way.
  it('refuses a DIFFERENT stack colliding on an occupied index (does not absorb it)', async () => {
    const d = await connect();
    const { addStack } = await import('./load-service');

    await addStack({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 3,
      unitCount: 9,
      countMode: 'multiplier',
      idempotencyKey: key(),
    });

    // A genuinely different stack (12, not 9) arriving at the same index.
    await expect(
      addStack({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        stackIndex: 3,
        unitCount: 12,
        countMode: 'multiplier',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ status: 409, reason: 'stack_index_conflict' });

    // The 12 was NOT silently dropped into the 9's row, and NOT absorbed.
    const rows = await d.loadStack.findMany({ where: { load_id: LOAD } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unit_count).toBe(9);
  });

  // ── REGRESSION (adversarial review, BLOCKER 2) ──────────────────────────
  //
  // A stack replayed AFTER the load finished must not leave `total_units`
  // stale. Two guards cover it: `addStack` refuses a load that is no longer
  // unloading, and a replayed `finishUnload` recomputes rather than returning
  // blind. Both are asserted, because either alone leaves the total wrong.
  it('a stack cannot land after finish, and a replayed finish recomputes', async () => {
    const d = await connect();
    const { addStack, finishUnload } = await import('./load-service');

    await addStack({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 1,
      unitCount: 5,
      countMode: 'ledger',
      idempotencyKey: key(),
    });
    await finishUnload({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      countMode: 'ledger',
      idempotencyKey: key(),
    });
    expect((await d.inboundLoad.findUnique({ where: { id: LOAD } })).total_units).toBe(5);

    // The late stack is REFUSED rather than written into a finished load.
    await expect(
      addStack({
        loadId: LOAD,
        operatorUserId: OP,
        siteId: SITE,
        stackIndex: 2,
        unitCount: 11,
        countMode: 'ledger',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ status: 409, reason: 'load_not_unloading' });

    // And if a row ever DID arrive late by another route, a replayed finish
    // reconciles the billed total instead of trusting the stored one.
    await d.loadStack.create({
      data: { load_id: LOAD, stack_index: 2, unit_count: 11, count_mode: 'ledger' },
    });
    await finishUnload({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      countMode: 'ledger',
      idempotencyKey: key(),
    });
    expect((await d.inboundLoad.findUnique({ where: { id: LOAD } })).total_units).toBe(16);
  });

  // D7 — the retry-after-commit false failure on Finish.
  it('finishing an already-finished load is a replay, not an illegal transition', async () => {
    const { addStack, finishUnload } = await import('./load-service');
    await addStack({
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 1,
      unitCount: 3,
      countMode: 'ledger',
      idempotencyKey: key(),
    });
    const args = {
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      countMode: 'ledger' as const,
      idempotencyKey: key(),
    };
    await finishUnload(args);
    // The response was lost; the operator's device retries.
    await expect(finishUnload(args)).resolves.toBeUndefined();
  });

  // Without a key we keep the STRICT behaviour. Asserted so the tolerance above
  // cannot quietly widen into "any duplicate is fine", which would hide a real
  // double-count behind the fix for a false failure.
  it('without a key, a duplicate stack index still raises', async () => {
    const { addStack } = await import('./load-service');
    const base = {
      loadId: LOAD,
      operatorUserId: OP,
      siteId: SITE,
      stackIndex: 1,
      unitCount: 4,
      countMode: 'ledger' as const,
      idempotencyKey: null,
    };
    await addStack(base);
    await expect(addStack(base)).rejects.toThrow();
  });

  // ── FALSIFICATION 7: photo.replay-no-duplicate ──────────────────────────
  //
  // The confirm succeeds, its response is lost, and the queue replays. Critically
  // the replay carries a DIFFERENT `storage_key`, because `replayUpload` re-mints
  // one — which is why there is no natural key to dedupe on and why the request
  // hash deliberately covers only `load_id` + `kind`.
  //
  // FALSIFIED BY HAND: removing `withIdempotency` from
  // `/api/photos/confirm` yields TWO `load_photos` rows — the exact defect, and
  // the one about to be exercised at volume as a device with 99 queued photos
  // drains. Including `storage_key` in the hash instead yields a 409, which is
  // the same bug wearing a fix's clothing.
  it('a replayed photo confirm with a re-minted key writes ONE row', async () => {
    const d = await connect();
    const { withIdempotency } = await import('./idempotency');
    const k = key();

    // Mirrors the route body exactly: same scope, same hashed payload, same
    // single-transaction claim. Only the storage_key differs between attempts.
    const confirm = (storageKey: string) =>
      d.$transaction((tx: any) =>
        withIdempotency(
          {
            key: k,
            scope: 'operator.photo.confirm',
            actorUserId: OP,
            siteId: SITE,
            payload: { load_id: LOAD, kind: 'bol' },
            tx,
            statusCode: 200,
          },
          async () => {
            const created = await tx.loadPhoto.create({
              data: {
                load_id: LOAD,
                kind: 'bol',
                storage_key: storageKey,
                captured_at: new Date(),
              },
              select: { id: true },
            });
            return { id: created.id };
          },
        ),
      );

    const first = await confirm('loads/xo-load/bol/FIRST.jpg');
    const replay = await confirm('loads/xo-load/bol/RE-MINTED-DIFFERENT.jpg');

    const photos = await d.loadPhoto.findMany({ where: { load_id: LOAD } });
    expect(photos, 'a re-minted replay must not create a second photo row').toHaveLength(1);
    // The stored key is the FIRST one — the replay wrote nothing at all.
    expect(photos[0]!.storage_key).toBe('loads/xo-load/bol/FIRST.jpg');
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
  });
});
