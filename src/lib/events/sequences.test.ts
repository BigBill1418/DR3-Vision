// ADR-0041 (capture half; B6/B10-6) — document-number issuance.
//
// Two layers of proof:
//  1. Logic-level (mocked prisma): the UPDATE…RETURNING contract — issuance hands
//     out the pre-increment value, advances the counter, is monotonic/unique across
//     many calls, honors a custom (tx) executor, and throws when the counter is
//     absent. The mock models the single-statement atomicity (get→return→advance
//     with no await gap, exactly as the DB row lock guarantees).
//  2. Real-DB concurrency (gated on DR3_TEST_DATABASE_URL): N truly-concurrent
//     issues against Postgres must yield N unique, contiguous numbers. Skipped in
//     the default suite (no DB); run against the migtest Postgres in the gate.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeSql {
  values: unknown[];
}
const store = { counters: new Map<string, number>() };

// Models `UPDATE … SET next_value = next_value + 1 … RETURNING next_value - 1`:
// returns the pre-increment value and advances; an absent row returns no rows.
vi.mock('@/lib/prisma', () => ({
  prisma: {
    $queryRaw: async (sql: FakeSql) => {
      const [siteId, code] = sql.values as [string, string];
      const key = `${siteId}::${code}`;
      const cur = store.counters.get(key);
      if (cur === undefined) return [];
      store.counters.set(key, cur + 1);
      return [{ issued: cur }];
    },
  },
}));

import {
  issueDocumentNumber,
  siteGetsVisionDr3Number,
  DocumentSequenceNotFoundError,
  DR3_NUMBER_SEQUENCE,
} from './sequences';

beforeEach(() => {
  store.counters.clear();
});

describe('siteGetsVisionDr3Number — jurisdiction trigger (TODO: per-site config)', () => {
  it('California sites get a Vision DR3#; Oregon does not', () => {
    expect(siteGetsVisionDr3Number('california')).toBe(true);
    expect(siteGetsVisionDr3Number('oregon')).toBe(false);
  });
});

describe('issueDocumentNumber — atomic hand-out + advance', () => {
  it('hands out the seeded next_value then advances', async () => {
    store.counters.set(`W::${DR3_NUMBER_SEQUENCE}`, 5000);
    expect(await issueDocumentNumber('W', DR3_NUMBER_SEQUENCE)).toBe(5000);
    expect(await issueDocumentNumber('W', DR3_NUMBER_SEQUENCE)).toBe(5001);
    expect(await issueDocumentNumber('W', DR3_NUMBER_SEQUENCE)).toBe(5002);
  });

  it('is monotonic and collision-free across many issues', async () => {
    store.counters.set('W::dr3_number', 5000);
    const issued = await Promise.all(
      Array.from({ length: 50 }, () => issueDocumentNumber('W', 'dr3_number')),
    );
    const sorted = [...issued].sort((a, b) => a - b);
    expect(new Set(issued).size).toBe(50); // all unique
    expect(sorted[0]).toBe(5000);
    expect(sorted[49]).toBe(5049); // contiguous, no gaps
  });

  it('honors a supplied executor (the enclosing transaction client)', async () => {
    store.counters.set('W::dr3_number', 42);
    const tx = {
      $queryRaw: async (sql: FakeSql) => {
        const [siteId, code] = sql.values as [string, string];
        const cur = store.counters.get(`${siteId}::${code}`)!;
        store.counters.set(`${siteId}::${code}`, cur + 1);
        return [{ issued: cur }];
      },
    } as unknown as Parameters<typeof issueDocumentNumber>[2];
    expect(await issueDocumentNumber('W', 'dr3_number', tx)).toBe(42);
    expect(store.counters.get('W::dr3_number')).toBe(43);
  });

  it('throws DocumentSequenceNotFoundError when no counter row exists', async () => {
    await expect(issueDocumentNumber('NOSITE', 'dr3_number')).rejects.toBeInstanceOf(
      DocumentSequenceNotFoundError,
    );
  });
});

// Real-DB concurrency proof — gated. Set DR3_TEST_DATABASE_URL to a Postgres with
// the ADR-0041 migration applied to run it (the gate does this against migtest).
const REAL_DB = process.env['DR3_TEST_DATABASE_URL'];
describe.skipIf(!REAL_DB)('issueDocumentNumber — REAL concurrency (Postgres row lock)', () => {
  it('N concurrent issues yield N unique contiguous numbers', async () => {
    // NOTE: no vi.unmock here — vitest hoists it and it would cancel the module
    // mock for the whole file. This test passes its OWN real client as the
    // executor, so the default mocked prisma is irrelevant to it.
    const { PrismaClient } = await import('@prisma/client');
    const db = new PrismaClient({ datasources: { db: { url: REAL_DB! } } });
    try {
      // A standalone counter row keyed on a throwaway site_id would violate the FK,
      // so this proof uses a real seeded site; align to your migtest seed if needed.
      const site = await db.site.findFirst({ select: { id: true } });
      if (!site) return; // no sites seeded — nothing to prove against
      const code = `concurrency-test-${Date.now()}`;
      await db.documentSequence.create({
        data: { site_id: site.id, sequence_code: code, next_value: 1000 },
      });
      const N = 64;
      const issued = await Promise.all(
        Array.from({ length: N }, () => issueDocumentNumber(site.id, code, db)),
      );
      expect(new Set(issued).size).toBe(N);
      expect(Math.min(...issued)).toBe(1000);
      expect(Math.max(...issued)).toBe(1000 + N - 1);
      await db.documentSequence.deleteMany({ where: { site_id: site.id, sequence_code: code } });
    } finally {
      await db.$disconnect();
    }
  });
});
