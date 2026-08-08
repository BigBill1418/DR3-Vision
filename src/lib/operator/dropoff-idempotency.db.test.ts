// ADR-0085 — a double-tapped drop-off lands ONCE, against a real Postgres.
//
// ## Why this exercises the shipped `dropoffCreate` and not a re-implementation
//
// The guarantee is a property of `INSERT ... ON CONFLICT (key) DO NOTHING`
// running inside the SAME transaction as the row it guards. A test that rebuilt
// that arrangement out of `withIdempotency` + `createFloorDropoff` by hand would
// be asserting that the test author can wire it correctly — which is not the
// question. So `DATABASE_URL` is pointed at the test database BEFORE the module
// graph is imported, and the real handler runs.
//
// Postgres does not skip a conflicting row that is still UNCOMMITTED: it blocks
// until the holding transaction resolves, then does nothing if that transaction
// committed. That is precisely the serialisation a double-tap needs, it cannot
// be exhibited by a mocked prisma, and it is why this file refuses one.
//
// ## The re-mint case is the one that would have been missed
//
// A drop-off queued offline re-mints a FRESH R2 key before replaying, because
// the presign expired. If the request hash covered `photoStorageKey`, that
// replay would look like key reuse and answer 409 — turning an exactly-once fix
// into a louder bug. `/api/photos/confirm` documents having been bitten by the
// identical trap. Pinned below.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
if (REAL_DB) process.env['DATABASE_URL'] = REAL_DB;

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

const SITE = 'site-adr0085-idem';
const USER = 'user-adr0085-idem';
const DAY = '2026-08-08';

const ctx = { siteId: SITE, siteCode: 'adr0085idem', siteName: 'ADR-0085', userId: USER } as any;

function payload(photoKey: string) {
  return {
    dropoffDate: DAY,
    kind: 'floor_public' as const,
    units: 5,
    photoStorageKey: photoKey,
    photoContentType: 'image/jpeg',
    photoByteSize: 100,
  };
}

async function seed(): Promise<void> {
  const d = await connect();
  await d.$executeRawUnsafe(`
    INSERT INTO "sites" (
      "id","code","name","jurisdiction","mrc_program_code",
      "customer_service_open","customer_service_close","recycling_rate_target_pct",
      "records_retention_years","inbound_processing_deadline_days",
      "mymrc_inbound_submission_business_days","mymrc_processed_submission_business_days",
      "dock_sla_minutes","reconciliation_target_pct","billing_cadence","updated_at"
    ) VALUES (
      '${SITE}','adr0085idem','ADR-0085 Idem','oregon','TEST2',
      '08:00','17:00',75.00,3,30,2,2,60,98.00,'end_of_month_only',CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING`);
  await d.$executeRawUnsafe(`
    INSERT INTO "users" ("id","name","role","updated_at")
    VALUES ('${USER}','ADR-0085 Idem Operator','operator',CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING`);
}

const suite = REAL_DB ? describe : describe.skip;

suite('ADR-0085 — drop-off idempotency (real Postgres)', () => {
  let dropoffCreate: (input: any) => Promise<{ status: number; body: unknown }>;

  beforeEach(async () => {
    await seed();
    await db.$executeRawUnsafe(`DELETE FROM "audit_log" WHERE "table_name" = 'consumer_dropoffs'`);
    await db.$executeRawUnsafe(`DELETE FROM "consumer_dropoffs" WHERE "site_id" = '${SITE}'`);
    await db.$executeRawUnsafe(`DELETE FROM "idempotency_keys" WHERE "site_id" = '${SITE}'`);
    ({ dropoffCreate } = await import('./floor-writes'));
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  it('DOUBLE-TAP — the same key twice writes ONE row and replays the response', async () => {
    const key = 'idem-double-tap';
    const a = await dropoffCreate({
      ctx,
      payload: payload(`dropoffs/${SITE}/one.jpg`),
      idempotencyKey: key,
    });
    const b = await dropoffCreate({
      ctx,
      payload: payload(`dropoffs/${SITE}/one.jpg`),
      idempotencyKey: key,
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    // The SAME row id comes back, so the iPad's second tap shows the operator the
    // drop-off they already made rather than a new one.
    expect((b.body as any).id).toBe((a.body as any).id);

    const rows = await db.consumerDropoff.findMany({ where: { site_id: SITE } });
    expect(
      rows.length,
      `a double-tapped drop-off wrote ${rows.length} rows — ${rows.reduce(
        (n: number, r: any) => n + r.units,
        0,
      )} units of phantom inventory`,
    ).toBe(1);
    expect(rows[0].units).toBe(5);
  });

  it('CONCURRENT double-tap — two in flight at once still write ONE row', async () => {
    // The serialisation that only Postgres can demonstrate: the second INSERT
    // blocks on the first transaction's uncommitted claim row rather than
    // skipping it, then finds the committed key and replays.
    const key = 'idem-concurrent';
    const [a, b] = await Promise.all([
      dropoffCreate({ ctx, payload: payload(`dropoffs/${SITE}/c.jpg`), idempotencyKey: key }),
      dropoffCreate({ ctx, payload: payload(`dropoffs/${SITE}/c.jpg`), idempotencyKey: key }),
    ]);
    expect((a.body as any).id).toBe((b.body as any).id);
    expect(await db.consumerDropoff.count({ where: { site_id: SITE } })).toBe(1);
  });

  it('RE-MINT — a replay whose photo key changed is NOT treated as key reuse', async () => {
    // The offline path: the presign expired, the queue re-minted, so the second
    // attempt legitimately carries a different `photoStorageKey`. If that key were
    // part of the request hash this would 409 `idempotency_key_reused` and the
    // entry would park as a permanent conflict holding the only copy of the photo.
    const key = 'idem-remint';
    const first = await dropoffCreate({
      ctx,
      payload: payload(`dropoffs/${SITE}/mint-a.jpg`),
      idempotencyKey: key,
    });
    const replay = await dropoffCreate({
      ctx,
      payload: payload(`dropoffs/${SITE}/mint-b.jpg`),
      idempotencyKey: key,
    });

    expect(
      replay.status,
      'a re-minted photo key was read as key reuse — the queued drop-off can never drain',
    ).toBe(201);
    expect((replay.body as any).id).toBe((first.body as any).id);
    expect(await db.consumerDropoff.count({ where: { site_id: SITE } })).toBe(1);

    // The ORIGINAL key is what the row keeps. The re-minted object is orphaned —
    // the same accepted trade `/api/photos/confirm` documents: an unreferenced
    // object costs bytes, a duplicate row costs the floor's inventory being wrong.
    const row = await db.consumerDropoff.findFirst({ where: { site_id: SITE } });
    expect(row.photo_storage_key).toBe(`dropoffs/${SITE}/mint-a.jpg`);
  });

  it('a genuinely DIFFERENT drop-off under the same key is refused, not merged', async () => {
    // The other direction. Two walk-ups of different sizes are two drop-offs; if
    // the key were honoured blindly the second would silently vanish. 409 is the
    // correct answer — the queue parks it as a visible conflict.
    const key = 'idem-different';
    await dropoffCreate({ ctx, payload: payload(`dropoffs/${SITE}/x.jpg`), idempotencyKey: key });
    await expect(
      dropoffCreate({
        ctx,
        payload: { ...payload(`dropoffs/${SITE}/x.jpg`), units: 99 },
        idempotencyKey: key,
      }),
    ).rejects.toThrow(/reuse/i);
    expect(await db.consumerDropoff.count({ where: { site_id: SITE } })).toBe(1);
  });

  it('two SEPARATE walk-ups with distinct keys both land — dedupe is not over-eager', async () => {
    // Guarding the guard. A drop-off has no natural key: two identical captures on
    // one day are an ordinary Tuesday. A mechanism that collapsed them would lose
    // real inventory, which is the failure mode opposite to the double-tap and is
    // just as expensive.
    await dropoffCreate({ ctx, payload: payload(`dropoffs/${SITE}/1.jpg`), idempotencyKey: 'k1' });
    await dropoffCreate({ ctx, payload: payload(`dropoffs/${SITE}/2.jpg`), idempotencyKey: 'k2' });
    const agg = await db.consumerDropoff.aggregate({
      _sum: { units: true },
      where: { site_id: SITE },
    });
    expect(agg._sum.units, 'two distinct walk-ups were collapsed into one').toBe(10);
  });

  it('an out-of-site photo key is refused before any row is written', async () => {
    const res = await dropoffCreate({
      ctx,
      payload: payload('dropoffs/some-other-site/stolen.jpg'),
      idempotencyKey: 'idem-crosssite',
    });
    expect(res.status).toBe(422);
    expect((res.body as any).error).toBe('invalid_photo_key');
    expect(await db.consumerDropoff.count({ where: { site_id: SITE } })).toBe(0);
    // And no key was burned: the operator's honest retry must still be able to
    // claim it. A claim written for a refused request answers the retry with a
    // stored success for a write that never happened.
    const claims = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM "idempotency_keys" WHERE "key" = 'idem-crosssite'`,
    );
    expect(claims[0].n).toBe(0);
  });
});
