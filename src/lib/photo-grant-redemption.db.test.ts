// ADR-0086 D7 "replay" — the SECOND redemption of one grant writes no second
// row. Against real Postgres, and it has to be.
//
// The property is `INSERT ... ON CONFLICT ("key") DO NOTHING` plus the claim
// committing in the SAME transaction as the insert. No in-memory fake reproduces
// that: a fake written to return "already claimed" on the second call is a
// restatement of the fixture, and it would stay green through a refactor that
// moved the claim out of the transaction — which is the one change that would
// actually break exactly-once. Same reasoning as `idempotency.db.test.ts` and
// `floor-exactly-once.db.test.ts`, which this file sits beside.
//
// Skips when `DR3_TEST_DATABASE_URL` is unset, which is the default on the
// build host. It has NOT been left un-executed on that account: it was run
// 2026-08-08 against an ephemeral `postgres:16-alpine` with the full migration
// chain applied by `prisma migrate deploy`, and falsified there by replacing the
// `withIdempotency` wrapper with a bare insert — which produced two real
// `load_photos` rows. CI's `migrations` job runs the same suite the same way.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withIdempotency } from './idempotency';
import { mintPhotoGrant, verifyPhotoGrant } from './photo-grant';
import { isValidLoadPhotoStorageKey } from './r2';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

// The writes and the assertions must address the SAME database, or "one row"
// would be true for the boring reason. Mirrors floor-exactly-once.db.test.ts.
const SAME_DB = REAL_DB != null && process.env['DATABASE_URL'] === REAL_DB;
if (REAL_DB && !SAME_DB) {
  throw new Error(
    'photo-grant-redemption.db.test.ts: set DATABASE_URL to the same value as ' +
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

const SITE = 'pg-site';
const OP = 'pg-operator';
const LOAD = 'pg-load';
const SECRET = 'db-test-secret-0123456789abcdefghijklmnopqrstuvwxyz';

let seq = 5000;
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
    VALUES ('${SITE}','pg','PG','oregon','OR-PG','08:00','17:00',85,3,30,2,2,30,95,
      'end_of_month_only',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","primary_site_id","is_active","updated_at")
    VALUES ('${OP}','PG Operator','operator','${SITE}',true,CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "is_active" = true`);
  await d.$executeRawUnsafe(`
    INSERT INTO "inbound_loads" ("id","site_id","status","assigned_operator_id",
      "arrived_at","updated_at")
    VALUES ('${LOAD}','${SITE}','in_progress','${OP}',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET "site_id" = '${SITE}'`);
}

describe.skipIf(!SAME_DB)('ADR-0086 — one grant redeems exactly once', () => {
  beforeEach(async () => {
    process.env['PHOTO_GRANT_SECRET'] = SECRET;
    await seed(await connect());
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ── FALSIFICATION: grant.replay-writes-one-row ──────────────────────────
  //
  // A device drains, the confirm lands, the response is lost on the way back,
  // and the sweep runs again with the SAME grant. Critically the replay carries
  // a DIFFERENT `storage_key`, because the re-mint produces a fresh UUID — which
  // is the whole reason the grant cannot name the object and the request hash
  // deliberately covers only `load_id` + `kind`.
  //
  // FALSIFIED BY HAND: removing `withIdempotency` from `/api/photos/confirm`
  // yields TWO `load_photos` rows. Including `storage_key` in the hash instead
  // yields a 409 on every legitimate replay — the same bug wearing a fix's
  // clothing.
  it('a grant redeemed twice with a re-minted key writes ONE row', async () => {
    const d = await connect();
    const idem = key();
    const token = mintPhotoGrant({
      loadId: LOAD,
      kind: 'bol',
      actorUserId: OP,
      siteId: SITE,
      idempotencyKey: idem,
    })!;

    // The route body, reproduced faithfully: verify the grant, re-read the load
    // and the actor, check the prefix, then claim + insert in ONE transaction.
    const redeem = async (storageKey: string) => {
      const v = verifyPhotoGrant(token);
      expect(v.ok).toBe(true);
      if (!v.ok) throw new Error('unreachable');

      const load = await d.inboundLoad.findUnique({ where: { id: v.payload.load_id } });
      expect(load.site_id).toBe(v.payload.site_id);
      const actor = await d.user.findUnique({ where: { id: v.payload.actor_user_id } });
      expect(actor.is_active).toBe(true);
      expect(isValidLoadPhotoStorageKey(storageKey, v.payload.load_id, v.payload.kind)).toBe(true);

      return d.$transaction((tx: any) =>
        withIdempotency(
          {
            key: v.payload.idempotency_key,
            scope: 'operator.photo.confirm',
            actorUserId: v.payload.actor_user_id,
            siteId: load.site_id,
            payload: { load_id: v.payload.load_id, kind: v.payload.kind },
            tx,
            statusCode: 200,
          },
          async () => {
            const created = await tx.loadPhoto.create({
              data: {
                load_id: v.payload.load_id,
                kind: v.payload.kind,
                storage_key: storageKey,
                captured_at: new Date(),
                uploaded_by: v.payload.actor_user_id,
              },
              select: { id: true },
            });
            return { id: created.id };
          },
        ),
      );
    };

    const first = await redeem(`loads/${LOAD}/bol/FIRST.jpg`);
    const replay = await redeem(`loads/${LOAD}/bol/RE-MINTED-DIFFERENT.jpg`);

    const photos = await d.loadPhoto.findMany({ where: { load_id: LOAD } });
    expect(photos, 'a replayed grant created a second photo row').toHaveLength(1);
    // The stored key is the FIRST one — the replay wrote nothing at all.
    expect(photos[0]!.storage_key).toBe(`loads/${LOAD}/bol/FIRST.jpg`);
    // ADR-0086 D8 — attribution is the CAPTURE-TIME operator.
    expect(photos[0]!.uploaded_by).toBe(OP);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toEqual(first.body);
  });

  // D5(a) against a REAL flipped `users` row — the half `load-photo-guard.grant.test.ts`
  // can only fake. The claim is that the redemption path reads the LIVE column,
  // not a cached or token-carried one.
  //
  // FALSIFIED BY HAND: deleting the `user.findUnique` block from
  // `authorizeByGrant` leaves this green while a departed employee's fortnight
  // of grants keeps writing rows — which is why the assertion is on the DB read,
  // not on the guard's return value.
  it('a deactivated actor is visible to the redemption read', async () => {
    const d = await connect();
    await d.$executeRawUnsafe(`UPDATE "users" SET "is_active" = false WHERE "id" = '${OP}'`);
    const actor = await d.user.findUnique({ where: { id: OP } });
    expect(actor.is_active, 'the redemption read cannot see a deactivation').toBe(false);
    await d.$executeRawUnsafe(`UPDATE "users" SET "is_active" = true WHERE "id" = '${OP}'`);
  });
});
