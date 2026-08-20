// ADR-0120 — the two promotion-lock key builders must produce the SAME string.
//
// `src/lib/mymrc/inbound-bridge.ts` cannot import `promotion-lock.ts`. It is
// compiled a second time, standalone, by `tsconfig.mymrc.json` so the MyMRC
// scraper runs as plain compiled JS with no Next — and that project sets
// `rootDir: ./src/lib/mymrc` and defines no `paths`, so it can resolve neither
// the `@/` alias nor a relative path to a file outside its rootDir. Importing
// the shared helper there breaks `npm run build:mymrc`, and therefore the
// Docker build.
//
// It did exactly that on 2026-08-20: the import shipped, `tsc --noEmit` was
// clean, CI's `typecheck · test · build` job passed, and the DEPLOY failed at
// `Dockerfile:70 RUN npx tsc --project tsconfig.mymrc.json`. Neither the local
// typecheck nor CI runs that project; only the image build does.
//
// So the bridge carries its own copy of the one line. This test is the price of
// that copy. A duplicated lock key that drifts is worse than no lock at all:
// the two sides would take DIFFERENT advisory locks, serialise against nothing,
// and look completely correct — no error, no failing test, and the double-count
// ADR-0120 exists to prevent, quietly back.
//
// ## Why this is not a vacuous both-sides-transcribed test
//
// It does not re-type the format string and compare it to itself. It imports
// the REAL function from each module and compares their outputs, so changing
// either one alone turns it red. Falsified by hand: editing the bridge's copy
// to `dr3:promo:${siteId}` gives
//     → expected 'dr3:promo:site-woodland' to be 'dr3:promotion:site-woodland'

import { describe, expect, it } from 'vitest';

import { promotionLockKey } from './promotion-lock';
import { lockSiteAgainstPromotion as bridgeLock } from '@/lib/mymrc/inbound-bridge';
import { lockSiteAgainstPromotion as sharedLock } from './promotion-lock';

/**
 * Capture the SQL a lock function issues, by handing it a transaction client
 * double that records the tagged-template call instead of running it.
 *
 * Comparing the emitted SQL and its bound values — rather than only the key
 * strings — also catches a divergence in the statement itself: a copy that said
 * `pg_advisory_lock` (session-scoped, never released) instead of
 * `pg_advisory_xact_lock` would produce an identical KEY and a completely
 * different behaviour.
 */
async function captureLock(
  fn: (tx: never, siteId: string) => Promise<void>,
  siteId: string,
): Promise<{ sql: string; values: unknown[] }> {
  let captured: { sql: string; values: unknown[] } | null = null;
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured = { sql: strings.join('?'), values };
      return Promise.resolve(0);
    },
  };
  await fn(tx as never, siteId);
  if (!captured) throw new Error('the lock function issued no statement');
  return captured;
}

const SITES = ['site-woodland', 'site-eugene', "quote'and-dash — unicode"];

describe('ADR-0120 — the bridge s copy of the promotion lock has not drifted', () => {
  it.each(SITES)('builds the identical key for %s', async (siteId) => {
    const shared = await captureLock(sharedLock, siteId);
    const bridge = await captureLock(bridgeLock, siteId);

    expect(bridge.values, `the bridge must lock the same key as everyone else`).toEqual(
      shared.values,
    );
    // The canonical builder is the definition; both must agree with it.
    expect(shared.values[0]).toBe(promotionLockKey(siteId));
    expect(bridge.values[0]).toBe(promotionLockKey(siteId));
  });

  it('issues the identical STATEMENT, not merely the same key', async () => {
    const shared = await captureLock(sharedLock, 'site-woodland');
    const bridge = await captureLock(bridgeLock, 'site-woodland');

    expect(bridge.sql).toBe(shared.sql);
    // Transaction-scoped, explicitly. `pg_advisory_lock` would build the same
    // key and hold the lock for the whole SESSION — never released, because
    // nothing calls unlock — which would wedge the connection pool.
    expect(shared.sql).toContain('pg_advisory_xact_lock');
    expect(shared.sql).not.toContain('pg_advisory_lock(');
  });
});
