// ADR-0078 — exactly-once, proven against a REAL Postgres.
//
// ## Why this suite refuses to use a mocked Prisma
//
// Every claim in this file is a claim about POSTGRES, not about our TypeScript.
// `INSERT ... ON CONFLICT (key) DO NOTHING` returning 0 rows, a primary key
// refusing a duplicate, `ORDER BY ... , created_at DESC` breaking a tie — a fake
// prisma cannot exhibit any of those, it can only be written to agree with them.
// The repo's usual `vi.mock('@/lib/prisma')` idiom is right for testing which
// WHERE clause a function builds; it is exactly wrong for testing whether a
// database constraint holds, because the mock would be enforcing the rule the
// test claims to be checking. That is the "green because the mock lied" failure
// this codebase has shipped more than once, and a double-submit guard is the
// last place to accept it.
//
// So: a real database, or the suite skips. `DR3_TEST_DATABASE_URL` points at a
// Postgres with the migration chain applied. CI's `migrations` job already
// stands one up (postgres:16-alpine + `prisma migrate deploy`), and now runs
// this file against it — before ADR-0078 that job applied migrations and then
// threw the database away without asserting a single behaviour, and the repo's
// one other real-DB test (`events/sequences.test.ts`) has therefore never
// executed in CI even once.
//
// Locally: docker run --rm -e POSTGRES_PASSWORD=dr3 -e POSTGRES_USER=dr3 \
//   -e POSTGRES_DB=dr3_test -p 55433:5432 postgres:16-alpine
//   DATABASE_URL=... npx prisma migrate deploy
//   DR3_TEST_DATABASE_URL=postgresql://dr3:dr3@127.0.0.1:55433/dr3_test npm test

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withIdempotency, IdempotencyKeyReusedError, requestHash } from './idempotency';

const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];

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

/** A key of the exact shape `src/lib/ulid.ts` mints. */
let seq = 0;
function key(): string {
  seq += 1;
  return `${Date.now().toString(36).padStart(13, '0')}-${String(seq).padStart(20, '0')}`;
}

describe.skipIf(!REAL_DB)('ADR-0078 — idempotency against real Postgres', () => {
  beforeEach(async () => {
    const d = await connect();
    // Scoped, NOT a blanket truncate. Vitest runs test FILES in parallel and the
    // real-DB suites share one database, so `DELETE FROM idempotency_keys` here
    // was deleting rows `floor-exactly-once.db.test.ts` was mid-way through
    // relying on — intermittently, depending on interleaving. Each file cleans
    // only what it created.
    await d.$executeRawUnsafe(`DELETE FROM "idempotency_keys" WHERE "scope" = 'test.count'`);
  });

  afterAll(async () => {
    if (db) await db.$disconnect();
  });

  // ── FALSIFICATION 1: idempotency.double-submit ──────────────────────────
  //
  // FALSIFIED BY HAND before this guard was trusted: deleting the
  // `ON CONFLICT ("key") DO NOTHING` clause from `withIdempotency`'s claim makes
  // this fail with a duplicate-key error, and replacing the whole claim with a
  // plain INSERT makes it fail on the row count — TWO rows, the exact defect.
  it('double-submit with the same key writes ONE row and replays the first response', async () => {
    const d = await connect();
    const k = key();
    const payload = { countDate: '2026-08-07', unitsTotal: 100 };
    const writes: string[] = [];

    const run = () =>
      d.$transaction((tx: any) =>
        withIdempotency(
          { key: k, scope: 'test.count', actorUserId: 'u1', siteId: 's1', payload, tx },
          async () => {
            // Stands in for the business write. Each real invocation appends,
            // so the count of appends IS the count of writes performed.
            writes.push('wrote');
            await tx.$executeRawUnsafe('SELECT 1');
            return { snapshotId: `snap-${writes.length}` };
          },
        ),
      );

    const first = await run();
    const second = await run();

    expect(writes).toHaveLength(1); // the business write ran ONCE
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    // The replay returns the ORIGINAL response, not a fresh one.
    expect(second.body).toEqual(first.body);
    expect(second.body).toEqual({ snapshotId: 'snap-1' });

    // Scoped to THIS key. An unscoped count here read the other real-DB
    // suite's rows too — same shared-database race as the cleanup above.
    const rows = await d.$queryRawUnsafe(`SELECT * FROM "idempotency_keys" WHERE "key" = '${k}'`);
    expect(rows).toHaveLength(1);
  });

  // ── FALSIFICATION 2: idempotency.key-reuse-different-payload ─────────────
  //
  // FALSIFIED BY HAND: dropping the `stored.request_hash !== hash` comparison
  // makes this go red by returning the FIRST count's response for the second
  // count — silently answering "saved" for a number nobody stored.
  it('the same key with a DIFFERENT payload is refused 409, not silently replayed', async () => {
    const d = await connect();
    const k = key();

    await d.$transaction((tx: any) =>
      withIdempotency(
        {
          key: k,
          scope: 'test.count',
          actorUserId: 'u1',
          siteId: 's1',
          payload: { unitsTotal: 100 },
          tx,
        },
        async () => ({ ok: 100 }),
      ),
    );

    await expect(
      d.$transaction((tx: any) =>
        withIdempotency(
          {
            key: k,
            scope: 'test.count',
            actorUserId: 'u1',
            siteId: 's1',
            payload: { unitsTotal: 999 }, // a DIFFERENT count under the same key
            tx,
          },
          async () => ({ ok: 999 }),
        ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  // A replay is pinned to the actor that claimed the key. Not in the original
  // ten, added because a bearer string that anyone can present would otherwise
  // read back another operator's stored response body.
  it('a replay by a DIFFERENT actor is refused, not answered', async () => {
    const d = await connect();
    const k = key();
    const payload = { unitsTotal: 100 };

    await d.$transaction((tx: any) =>
      withIdempotency(
        { key: k, scope: 'test.count', actorUserId: 'u1', siteId: 's1', payload, tx },
        async () => ({ ok: true }),
      ),
    );

    await expect(
      d.$transaction((tx: any) =>
        withIdempotency(
          { key: k, scope: 'test.count', actorUserId: 'u2', siteId: 's1', payload, tx },
          async () => ({ ok: true }),
        ),
      ),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  // The dangerous direction: a claim must NEVER outlive a failed business write.
  // If it did, the operator's retry would be answered with a stored success for
  // a write that never happened, and the count would vanish silently.
  it('a failed business write leaves NO claim behind — the key is not burned', async () => {
    const d = await connect();
    const k = key();
    const payload = { unitsTotal: 100 };

    await expect(
      d.$transaction((tx: any) =>
        withIdempotency(
          { key: k, scope: 'test.count', actorUserId: 'u1', siteId: 's1', payload, tx },
          async () => {
            throw new Error('business write failed');
          },
        ),
      ),
    ).rejects.toThrow('business write failed');

    const rows: unknown[] = await d.$queryRawUnsafe(
      `SELECT * FROM "idempotency_keys" WHERE "key" = '${k}'`,
    );
    expect(rows).toHaveLength(0);

    // …and the retry genuinely runs the write.
    const retry = await d.$transaction((tx: any) =>
      withIdempotency(
        { key: k, scope: 'test.count', actorUserId: 'u1', siteId: 's1', payload, tx },
        async () => ({ ok: true }),
      ),
    );
    expect(retry.replayed).toBe(false);
  });

  // Concurrency, not sequence. Two simultaneous taps race the SAME key through
  // two connections; Postgres serialises them on the primary key. Without the
  // ON CONFLICT claim this is where a double-tap produces two anchors.
  it('two CONCURRENT submits of the same key perform one write', async () => {
    const d = await connect();
    const k = key();
    const payload = { unitsTotal: 100 };
    let writes = 0;

    const run = () =>
      d.$transaction((tx: any) =>
        withIdempotency(
          { key: k, scope: 'test.count', actorUserId: 'u1', siteId: 's1', payload, tx },
          async () => {
            writes += 1;
            return { n: writes };
          },
        ),
      );

    const [a, b] = await Promise.all([run(), run()]);
    expect(writes).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });
});

// Pure, so it runs everywhere — including the CI job that has no database.
describe('canonical request hashing', () => {
  it('is insensitive to key ORDER but sensitive to VALUES', () => {
    // Property order must not turn an ordinary retry into a spurious 409.
    expect(requestHash({ a: 1, b: 2 })).toBe(requestHash({ b: 2, a: 1 }));
    expect(requestHash({ a: 1, b: 2 })).not.toBe(requestHash({ a: 1, b: 3 }));
    // Nested, too — the count payload has a nested pool split.
    expect(requestHash({ x: { p: 1, q: 2 } })).toBe(requestHash({ x: { q: 2, p: 1 } }));
  });
});
