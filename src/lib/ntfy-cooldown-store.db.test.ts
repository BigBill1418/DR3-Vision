// ADR-0130 — the cooldown claim, proven against a REAL Postgres.
//
// Every claim in this file is a claim about POSTGRES, not about our TypeScript:
// that `INSERT … ON CONFLICT DO UPDATE … WHERE expires_at <= $now` reports ONE row
// affected when the window is claimable and ZERO when it is not; that the affected
// count (not a returned row, not an error) is the verdict; that two concurrent
// claimers cannot both win. A fake `$executeRawUnsafe` cannot exhibit any of that —
// it can only be written to agree with whatever the implementation does, which is
// the "green because the mock lied" failure this repo has shipped before. The
// restart test in `ntfy-cooldown-restart.test.ts` uses such a fake ON PURPOSE and
// says so; this file is the half that fake cannot cover.
//
// So: a real database, or the suite skips. Same contract as `idempotency.db.test.ts`
// — `DR3_TEST_DATABASE_URL` points at a Postgres with the migration chain applied.
//
// Locally: docker run --rm -e POSTGRES_PASSWORD=dr3 -e POSTGRES_USER=dr3 \
//   -e POSTGRES_DB=dr3_test -p 55433:5432 postgres:16-alpine
//   DATABASE_URL=... npx prisma migrate deploy
//   DR3_TEST_DATABASE_URL=postgresql://dr3:dr3@127.0.0.1:55433/dr3_test npm test

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  claimCooldown,
  releaseCooldown,
  setCooldownDb,
  __cooldownTesting,
} from './ntfy-cooldown-store';

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

let seq = 0;
/** A fresh fingerprint per test — no cross-test coupling through the table. */
function fp(): string {
  seq += 1;
  return `test-cooldown:${process.pid}:${seq}`;
}

async function rowFor(key: string): Promise<{ expires_at: Date; send_count: number } | undefined> {
  const rows = (await db.$queryRawUnsafe(
    'SELECT "expires_at", "send_count" FROM "alert_cooldowns" WHERE "key" = $1',
    key,
  )) as Array<{ expires_at: Date; send_count: number }>;
  return rows[0];
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const suite = REAL_DB ? describe : describe.skip;

suite('ADR-0130 cooldown claim — against a real Postgres', () => {
  beforeEach(async () => {
    __cooldownTesting.reset();
    setCooldownDb(await connect());
    // Never reap during a test: a 1-hour throttle is the production default and
    // would fire once per file, deleting long-expired rows mid-assertion.
    __cooldownTesting.setReapIntervalMs(Number.MAX_SAFE_INTEGER);
  });

  afterAll(async () => {
    if (db) {
      await db.$executeRawUnsafe(
        `DELETE FROM "alert_cooldowns" WHERE "key" LIKE $1`,
        `test-cooldown:${process.pid}:%`,
      );
      await db.$disconnect();
    }
  });

  it('the FIRST claim wins and writes the row', async () => {
    const key = fp();
    const now = Date.now();
    const claim = await claimCooldown(key, DAY, now);

    expect(claim).toMatchObject({ claimed: true, durable: true, expiresAt: now + DAY });
    const row = await rowFor(key);
    expect(row).toBeDefined();
    expect(row!.expires_at.getTime()).toBe(now + DAY);
  });

  it('a SECOND claim inside the window is REFUSED — 0 rows affected, row untouched', async () => {
    const key = fp();
    const t0 = Date.now();
    await claimCooldown(key, DAY, t0);

    // One hour later — the mymrc cron period, in a brand-new process.
    const second = await claimCooldown(key, DAY, t0 + 60 * MINUTE);
    expect(second.claimed).toBe(false);
    expect(second.durable).toBe(true);

    // The refusal must NOT slide the window forward, or a storming alert would be
    // suppressed forever instead of paging once a day.
    expect((await rowFor(key))!.expires_at.getTime()).toBe(t0 + DAY);
  });

  it('twenty-four hourly ticks produce exactly ONE claim (the incident, replayed)', async () => {
    const key = fp();
    const t0 = Date.now();
    let won = 0;
    for (let hour = 0; hour < 24; hour++) {
      const c = await claimCooldown(key, DAY, t0 + hour * 60 * MINUTE);
      if (c.claimed) won += 1;
      expect(c.durable).toBe(true);
    }
    expect(won).toBe(1);
    // …and the 25th hour, past the window, pages again.
    expect((await claimCooldown(key, DAY, t0 + DAY + MINUTE)).claimed).toBe(true);
  });

  it('an EXPIRED window is reclaimable and the expiry moves forward', async () => {
    const key = fp();
    const t0 = Date.now();
    await claimCooldown(key, 5 * MINUTE, t0);
    const later = t0 + 6 * MINUTE;

    const again = await claimCooldown(key, 5 * MINUTE, later);
    expect(again.claimed).toBe(true);
    expect((await rowFor(key))!.expires_at.getTime()).toBe(later + 5 * MINUTE);
  });

  it('the boundary is INCLUSIVE of expiry — expires_at == now reclaims', async () => {
    const key = fp();
    const t0 = Date.now();
    await claimCooldown(key, 5 * MINUTE, t0);
    expect((await claimCooldown(key, 5 * MINUTE, t0 + 5 * MINUTE - 1)).claimed).toBe(false);
    expect((await claimCooldown(key, 5 * MINUTE, t0 + 5 * MINUTE)).claimed).toBe(true);
  });

  it('CONCURRENT claimers: exactly one wins (this is what a Map cannot do)', async () => {
    const key = fp();
    const now = Date.now();
    // Ten simultaneous processes waking on the same cron minute.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCooldown(key, DAY, now)),
    );
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.every((r) => r.durable)).toBe(true);
  });

  it('RELEASE deletes the row so the next tick may retry a dropped publish', async () => {
    const key = fp();
    const now = Date.now();
    const claim = await claimCooldown(key, DAY, now);
    expect(claim.claimed).toBe(true);

    await releaseCooldown(key, claim.expiresAt);
    expect(await rowFor(key)).toBeUndefined();

    // The retry, one hour later, pages.
    expect((await claimCooldown(key, DAY, now + 60 * MINUTE)).claimed).toBe(true);
  });

  it('RELEASE is guarded on the exact expiry — it cannot delete a NEWER claim', async () => {
    const key = fp();
    const now = Date.now();
    const stale = await claimCooldown(key, DAY, now);
    // Another process re-takes the window after this one expires.
    await releaseCooldown(key, stale.expiresAt);
    const fresh = await claimCooldown(key, DAY, now + 1);
    expect(fresh.claimed).toBe(true);

    // A late release carrying the OLD expiry must be a no-op.
    await releaseCooldown(key, stale.expiresAt);
    expect(await rowFor(key)).toBeDefined();
    // (releaseCooldown also clears the in-process mirror; the DURABLE row is what
    // the next process reads, and it survived.)
    __cooldownTesting.reset();
    setCooldownDb(db);
    __cooldownTesting.setReapIntervalMs(Number.MAX_SAFE_INTEGER);
    expect((await claimCooldown(key, DAY, now + 2)).claimed).toBe(false);
  });

  it('cooldownMs: 0 NEVER suppresses — three modules already depend on this', async () => {
    // `src/lib/doc-ingest/reauth.ts`, `src/lib/doc-ingest/anomalies.ts` and
    // `src/lib/workbook-sync/engine.ts` each discovered this defect independently
    // and each built its OWN durable latch in Postgres (`reauth_paged_at`,
    // `last_paged_at`, `workbook_sources.last_alert_at`), passing `cooldownMs: 0`
    // precisely so the in-process ledger cannot second-guess it. reauth.ts states
    // the reason in its header: "A per-process cooldown would either re-page on
    // every restart or, worse, SUPPRESS THE FIRST PAGE after a restart."
    //
    // ADR-0130 generalises their pattern; it must not break the three that got
    // there first. A `cooldownMs: 0` claim writes `expires_at = now`, and the
    // claim predicate is `expires_at <= $now` — so it is always immediately
    // reclaimable, including within the same millisecond.
    const key = fp();
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect((await claimCooldown(key, 0, now)).claimed).toBe(true);
    }
  });

  it('D4 — send_count counts SENDS, and a refused claim does not inflate it', async () => {
    // The instrument. The Map could answer "is this suppressed right now" and
    // nothing else; `send_count` is what makes the next ADR-0037 re-grade read
    // rows instead of guessing. A REFUSED claim must not increment it, or the
    // number would count polls rather than pages.
    const key = fp();
    const t0 = Date.now();
    await claimCooldown(key, 5 * MINUTE, t0);
    expect((await rowFor(key))!.send_count).toBe(1);

    for (let i = 1; i < 5; i++) await claimCooldown(key, 5 * MINUTE, t0 + i * MINUTE);
    expect((await rowFor(key))!.send_count).toBe(1); // four refusals, no inflation

    await claimCooldown(key, 5 * MINUTE, t0 + 6 * MINUTE); // window expired: a real send
    expect((await rowFor(key))!.send_count).toBe(2);
  });

  it('the reaper removes rows past the grace window and keeps live ones', async () => {
    const live = fp();
    const dead = fp();
    const now = Date.now();
    await claimCooldown(live, DAY, now);
    // A row that expired 8 days ago (grace is 7).
    await db.$executeRawUnsafe(
      `INSERT INTO "alert_cooldowns" ("key","expires_at","last_sent_at")
       VALUES ($1, $2::timestamptz, $3::timestamptz)`,
      dead,
      new Date(now - 8 * DAY).toISOString(),
      new Date(now - 8 * DAY).toISOString(),
    );

    __cooldownTesting.setReapIntervalMs(0); // due now
    await claimCooldown(fp(), DAY, now);

    expect(await rowFor(dead)).toBeUndefined();
    expect(await rowFor(live)).toBeDefined();
  });
});
