// ADR-0109 — three photos, replayed idempotently, against REAL Postgres.
//
// ## Why this cannot be a mock
//
// The property under test is an INTERACTION between two mechanisms:
//
//   1. `withIdempotency` claims the key with `INSERT ... ON CONFLICT DO NOTHING`
//      in the same transaction as the insert, so a replay never runs the
//      callback at all; and
//   2. the ADR-0109 ceiling lives INSIDE that callback.
//
// Together they give the one property that matters on a floor iPad: **a photo
// whose confirm already landed still drains, even when the load is now full.**
// No fake reproduces that. A stub written to return "already claimed" on the
// second call is a restatement of the fixture, and it would stay green through
// exactly the refactor that breaks this — hoisting the count above the claim to
// "fail faster". Same reasoning as `photo-grant-redemption.db.test.ts` beside it.
//
// ## Naive-first, and the recorded failure
//
// The ceiling half was falsified against the pre-change route (see
// `photo-limit.route.test.ts` for that transcript). The REPLAY half — the half
// only a real database can judge — was falsified here on 2026-08-18 by hoisting
// the count out of the `withIdempotency` callback to just above it, which is the
// tempting "check before you do work" refactor and the single most likely way a
// future session breaks this. VERBATIM:
//
//     × ADR-0109 — the queue replays three photos idempotently > a double flush of three queued photos writes THREE rows, not six
//       → Error: photo_limit_reached
//     × ADR-0109 — the queue replays three photos idempotently > a full load still replays a photo that already landed
//       → Error: photo_limit_reached
//
//     Tests  2 failed | 3 passed (5)
//
// Note WHICH tests survived the hoist: `accepts three photos of one kind` and
// `refuses the fourth` both stayed green. A suite that only asserted the ceiling
// would have certified the broken arrangement.
//
// That is a fourth-photo guard eating a FIRST photo's replay: the row is already
// in the database, the device's queue entry can never clear, and the conflicts
// screen accumulates a photo that is not actually missing. The check belongs
// where the replay short-circuits above it.
//
// Skips when `DR3_TEST_DATABASE_URL` is unset (the default on the build host).
// It has NOT been left un-executed on that account — see the CHANGELOG entry for
// 2026-08-18 for the run against an ephemeral `postgres:16-alpine` with the full
// migration chain applied by `prisma migrate deploy`.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withIdempotency } from '@/lib/idempotency';
import { MAX_PHOTOS_PER_KIND, canAddPhoto } from './photo-limit';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The writes and the assertions must address the SAME database, or "three rows"
// would be true for the boring reason. Mirrors the sibling db suites.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'photo-limit.db.test.ts: set DATABASE_URL to the same value as ' +
      'DR3_TEST_DATABASE_URL — otherwise the writes and the assertions address ' +
      'different databases.',
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

const SITE = 'lim-site';
const OP = 'lim-operator';
const LOAD = 'lim-load';

let seq = 9000;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

async function seed(d: any): Promise<void> {
  await d.$executeRawUnsafe(`DELETE FROM "load_photos" WHERE "load_id" = '${LOAD}'`);
  // Scoped to this file's actor — a blanket truncate races the other real-DB
  // suites, which share the one CI database.
  await d.$executeRawUnsafe(`DELETE FROM "idempotency_keys" WHERE "actor_user_id" = '${OP}'`);
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" ("id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at")
    VALUES ('${SITE}','lim','LIM','oregon','OR-LIM','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
    VALUES ('${OP}','LIM Operator','operator','${SITE}',true,CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "is_active" = true`);
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","assigned_operator_id",
      "arrived_at","updated_at")
    VALUES ('${LOAD}','${SITE}','in_progress','${OP}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "site_id" = '${SITE}'`);
}

class PhotoLimitReached extends Error {}

/**
 * `/api/photos/confirm`'s transaction body, reproduced faithfully: advisory
 * lock, count, ceiling, insert — all inside the `withIdempotency` callback, and
 * the whole thing inside one `$transaction`.
 *
 * `storageKey` varies per call on purpose. `replayUpload` re-mints a fresh R2
 * key before every replay, so a test that replayed the SAME key would be testing
 * a request the client never sends (ADR-0078 D3).
 */
async function confirm(d: any, idempotencyKey: string, storageKey: string): Promise<unknown> {
  return d.$transaction((tx: any) =>
    withIdempotency(
      {
        key: idempotencyKey,
        scope: 'operator.photo.confirm',
        actorUserId: OP,
        siteId: SITE,
        payload: { load_id: LOAD, kind: 'bol' },
        tx,
        statusCode: 200,
      },
      async () => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`load-photo:${LOAD}:bol`})::bigint)`;
        const held = await tx.loadPhoto.count({ where: { load_id: LOAD, kind: 'bol' } });
        if (!canAddPhoto(held)) throw new PhotoLimitReached('photo_limit_reached');
        const created = await tx.loadPhoto.create({
          data: {
            load_id: LOAD,
            kind: 'bol',
            storage_key: storageKey,
            captured_at: new Date(),
            uploaded_by: OP,
          },
          select: { id: true },
        });
        return { id: created.id };
      },
    ),
  );
}

const countPhotos = async (d: any): Promise<number> =>
  d.loadPhoto.count({ where: { load_id: LOAD, kind: 'bol' } });

describe.skipIf(!SAME_DB)('ADR-0109 — three photos, and the fourth is refused', () => {
  beforeEach(async () => {
    await seed(await connect());
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('accepts three photos of one kind', async () => {
    const d = await connect();
    for (let i = 0; i < MAX_PHOTOS_PER_KIND; i += 1) {
      await confirm(d, key(), `loads/${LOAD}/bol/${i}.jpg`);
    }
    expect(await countPhotos(d)).toBe(MAX_PHOTOS_PER_KIND);
  });

  it('refuses the fourth photo of a kind', async () => {
    const d = await connect();
    for (let i = 0; i < MAX_PHOTOS_PER_KIND; i += 1) {
      await confirm(d, key(), `loads/${LOAD}/bol/${i}.jpg`);
    }
    await expect(confirm(d, key(), `loads/${LOAD}/bol/4.jpg`)).rejects.toBeInstanceOf(
      PhotoLimitReached,
    );
    expect(await countPhotos(d), 'the load took a fourth photo').toBe(MAX_PHOTOS_PER_KIND);
  });

  it("leaves the refused photo's key UNCLAIMED, so nothing replays a 200 it never earned", async () => {
    const d = await connect();
    for (let i = 0; i < MAX_PHOTOS_PER_KIND; i += 1) {
      await confirm(d, key(), `loads/${LOAD}/bol/${i}.jpg`);
    }
    const refused = key();
    await expect(confirm(d, refused, `loads/${LOAD}/bol/4.jpg`)).rejects.toThrow();

    // The rollback has to take the claim with it. Were the key left claimed with
    // a success body, the queue's next sweep would replay a stored 200, delete
    // its own row, and the photo would be gone with nothing recording that it
    // was ever refused.
    const claimed = await d.idempotencyKey.findUnique({ where: { key: refused } });
    expect(claimed, 'a refused write left its idempotency key claimed').toBeNull();
  });
});

describe.skipIf(!SAME_DB)('ADR-0109 — the queue replays three photos idempotently', () => {
  beforeEach(async () => {
    await seed(await connect());
  });

  it('a double flush of three queued photos writes THREE rows, not six', async () => {
    // The literal scenario: an iPad comes back online holding three captures,
    // the sweep confirms all three, the responses are lost, and the next sweep
    // replays all three with re-minted storage keys.
    const d = await connect();
    const keys = [key(), key(), key()];
    for (const [i, k] of keys.entries()) await confirm(d, k, `loads/${LOAD}/bol/a${i}.jpg`);
    for (const [i, k] of keys.entries()) await confirm(d, k, `loads/${LOAD}/bol/b${i}.jpg`);

    expect(await countPhotos(d), 'a replay wrote duplicate photo rows').toBe(3);
  });

  it('a full load still replays a photo that already landed', async () => {
    // THE test. The load is at the ceiling — because of these very photos — and
    // the third one's response was lost. Its replay must return the stored
    // response, not be refused by the ceiling its own row helped reach.
    const d = await connect();
    const keys = [key(), key(), key()];
    for (const [i, k] of keys.entries()) await confirm(d, k, `loads/${LOAD}/bol/a${i}.jpg`);
    expect(await countPhotos(d)).toBe(MAX_PHOTOS_PER_KIND);

    const replay = (await confirm(d, keys[2]!, `loads/${LOAD}/bol/reminted.jpg`)) as {
      replayed: boolean;
      statusCode: number;
    };
    expect(replay.replayed, 'the ceiling refused a replay of an already-written photo').toBe(true);
    expect(replay.statusCode).toBe(200);
    expect(await countPhotos(d)).toBe(MAX_PHOTOS_PER_KIND);
  });
});
