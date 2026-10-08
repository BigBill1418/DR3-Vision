// ADR-0078 / ADR-0140 Amendment 1 (review N1) — which runtime route the service
// worker actually picks for the reads that must NEVER be answered from cache.
//
// Serwist registers `runtimeCaching` in array order, per HTTP method, and
// `Serwist.findMatchingRoute` returns the FIRST route whose matcher is truthy
// (node_modules/serwist/dist/index.mjs: `registerRoute` pushes onto
// `_routes.get(method)`, `findMatchingRoute` loops and returns on first match).
// `@serwist/next/worker`'s `defaultCache` has a catch-all `/api/` GET entry
// (NetworkFirst, 10 s timeout, cached up to 24 h) and a catch-all same-origin
// entry for everything else. A never-cache rule placed after either is dead.
//
// This test imports the real `sw.ts` with only the `Serwist` class swapped for
// a recorder, keeps the REAL strategies and the REAL `defaultCache`, and replays
// Serwist's own lookup. It fails if a rule is removed, loosened to a caching
// strategy, or moved below the defaults.
//
// FALSIFIED BY HAND: moving the hold-status entry after `...defaultCache` makes
// the first test resolve to the `apis` NetworkFirst entry and fail.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeCaching } from 'serwist';

const { captured } = vi.hoisted(() => ({ captured: { runtimeCaching: [] as RuntimeCaching[] } }));

vi.mock('serwist', async (importOriginal) => {
  const orig = await importOriginal<typeof import('serwist')>();
  class RecordingSerwist {
    constructor(opts: { runtimeCaching?: RuntimeCaching[] }) {
      captured.runtimeCaching = opts.runtimeCaching ?? [];
    }
    addEventListeners(): void {}
  }
  return { ...orig, Serwist: RecordingSerwist };
});

// The background-sync plugin opens IndexedDB on construction; not under test.
vi.mock('@serwist/background-sync', () => ({
  BackgroundSyncPlugin: class {},
}));

const ORIGIN = 'https://dr3-vision.svdp.us';

/** Serwist's lookup: routes for this method, in registration order, first match wins. */
function routeFor(path: string, method = 'GET'): RuntimeCaching | undefined {
  const url = new URL(path, ORIGIN);
  const request = new Request(url, { method });
  return captured.runtimeCaching
    .filter((r) => (r.method ?? 'GET') === method)
    .find((r) => {
      const m = r.matcher;
      if (typeof m === 'function') {
        return Boolean(
          m({ url, request, sameOrigin: url.origin === ORIGIN, event: {} as ExtendableEvent }),
        );
      }
      if (m instanceof RegExp) return m.test(url.href);
      return false;
    });
}

let NetworkOnly: typeof import('serwist').NetworkOnly;

beforeAll(async () => {
  // `defaultCache` is chosen at module load: outside production it is ONE
  // catch-all NetworkOnly entry, which would make every assertion here pass
  // vacuously. Load the production defaults — the ones the iPads run.
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  vi.stubGlobal('self', {
    __SW_MANIFEST: [],
    addEventListener: () => {},
    skipWaiting: async () => {},
  });
  ({ NetworkOnly } = await import('serwist'));
  await import('./sw');
  expect(captured.runtimeCaching.length).toBeGreaterThan(0);
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('service worker runtime routes that must never be served from cache', () => {
  it('the hold-status read (review N1) resolves to NetworkOnly, not the default /api/ cache', () => {
    const r = routeFor('/api/operator/woodland/count/holds/0f8e-hold-id');
    expect(r, 'no route matched — the default /api/ rule would have').toBeDefined();
    expect(r?.handler).toBeInstanceOf(NetworkOnly);
  });

  it('/healthz (ADR-0078) still resolves to NetworkOnly', () => {
    expect(routeFor('/healthz')?.handler).toBeInstanceOf(NetworkOnly);
  });

  it('the rule is narrow: neighbouring operator GETs are not swept into it', () => {
    // The floor's inbound day list keeps its existing behaviour (reviewed separately).
    expect(routeFor('/api/operator/woodland/inbound')?.handler).not.toBeInstanceOf(NetworkOnly);
    // A path that merely starts like a hold id does not match.
    expect(routeFor('/api/operator/woodland/count/holds/hold-1/extra')?.handler).not.toBeInstanceOf(
      NetworkOnly,
    );
  });

  it('the defaults really would cache it — this rule is load-bearing, not redundant', () => {
    // Drop every custom entry ahead of the defaults and look again.
    const firstDefault = captured.runtimeCaching.findIndex(
      (r) => (r.handler as { cacheName?: string }).cacheName === 'apis',
    );
    expect(firstDefault).toBeGreaterThan(-1);
    const all = captured.runtimeCaching;
    try {
      captured.runtimeCaching = all.slice(firstDefault);
      const r = routeFor('/api/operator/woodland/count/holds/0f8e-hold-id');
      expect((r?.handler as { cacheName?: string }).cacheName).toBe('apis');
    } finally {
      captured.runtimeCaching = all;
    }
  });
});
