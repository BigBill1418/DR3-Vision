// ADR-0006 Amendment 1 — the service worker never replays a Next.js server action.
//
// From 9f1ebd8 (2026-05-06) until this amendment, `sw.ts` routed every
// same-origin `Next-Action` POST through NetworkFirst + a Workbox
// BackgroundSyncPlugin queue (`dr3-server-actions`, 24 h retention). A failed
// action was stored in the SW's own IndexedDB and re-sent later, with whatever
// session cookie was live at replay time, mostly without an idempotency key,
// and after a deploy with an action id the server no longer knows. On iPad
// Safari (no Background Sync API) Serwist replays that queue every time the
// worker starts. The app's own queue (`src/lib/offline-queue.ts`) is the
// designed replay path; this one was an undocumented duplicate.
//
// Same harness as the never-cache route tests: the REAL `sw.ts`, the REAL
// strategies and the REAL production `defaultCache`, with only the `Serwist`
// class swapped for a recorder, and Serwist's own first-match lookup replayed.
//
// FAILED BEFORE THE CHANGE (run on origin/main 40a5fa9): the server-action
// route resolved to NetworkFirst carrying a BackgroundSyncPlugin, a
// `dr3-server-actions` queue was constructed, and no activate handler purged it.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RuntimeCaching } from 'serwist';

const { captured } = vi.hoisted(() => ({
  captured: {
    runtimeCaching: [] as RuntimeCaching[],
    queueNames: [] as string[],
    listeners: new Map<string, Array<(e: unknown) => void>>(),
  },
}));

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

// The real plugin opens IndexedDB and, on a browser without Background Sync,
// REPLAYS its queue from the constructor. Record the name instead.
vi.mock('@serwist/background-sync', () => ({
  BackgroundSyncPlugin: class {
    constructor(name: string) {
      captured.queueNames.push(name);
    }
  },
}));

const ORIGIN = 'https://dr3-vision.svdp.us';

function serverActionRequest(path = '/operator/woodland/load/l-1'): Request {
  return new Request(new URL(path, ORIGIN), {
    method: 'POST',
    headers: { 'Next-Action': '7f3a-synthetic-action-id', 'Content-Type': 'text/plain' },
    body: '["k-1","woodland","l-1",1,4,"ledger"]',
  });
}

/** Serwist's lookup: routes for this method, in registration order, first match wins. */
function routeFor(request: Request): RuntimeCaching | undefined {
  const url = new URL(request.url);
  return captured.runtimeCaching
    .filter((r) => (r.method ?? 'GET') === request.method)
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
  // Outside production `defaultCache` is one catch-all NetworkOnly entry, which
  // would make the route assertions pass vacuously. Load what the iPads run.
  vi.stubEnv('NODE_ENV', 'production');
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal('self', {
    __SW_MANIFEST: [],
    indexedDB: globalThis.indexedDB,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      captured.listeners.set(type, [...(captured.listeners.get(type) ?? []), fn]);
    },
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

describe('a Next-Action POST goes straight to the network', () => {
  it('resolves to NetworkOnly with no plugins — nothing can queue it', () => {
    const r = routeFor(serverActionRequest());
    expect(r, 'no route matched the server-action POST').toBeDefined();
    expect(r?.handler).toBeInstanceOf(NetworkOnly);
    expect((r?.handler as unknown as { plugins: unknown[] }).plugins).toEqual([]);
  });

  it('no service-worker background-sync queue exists for server actions', () => {
    expect(captured.queueNames).not.toContain('dr3-server-actions');
    // The photo queues are a separate decision and are untouched by this change.
    expect(captured.queueNames).toEqual(['dr3-photo-mint', 'dr3-photo-put', 'dr3-photo-confirm']);
  });

  it('a failed network call rejects to the page, once, and is not retried', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new TypeError('Load failed');
    });
    vi.stubGlobal('fetch', fetchSpy);
    // Strategy code tests `event instanceof FetchEvent`; node has no such global.
    vi.stubGlobal('FetchEvent', class {});
    const handler = routeFor(serverActionRequest())!.handler as InstanceType<typeof NetworkOnly>;
    const pending: Promise<unknown>[] = [];
    const event = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExtendableEvent;
    await expect(handler.handle({ request: serverActionRequest(), event })).rejects.toBeTruthy();
    await Promise.allSettled(pending);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a POST without the Next-Action header is not swept into the rule', () => {
    const plain = new Request(new URL('/operator/woodland/load/l-1', ORIGIN), { method: 'POST' });
    expect(routeFor(plain)).toBeUndefined();
  });
});

describe('activate purges the retired dr3-server-actions queue without replaying it', () => {
  it('registers an activate handler that empties that queue and keeps the photo queues', async () => {
    const { BG_SYNC_DB_NAME } = await import('@/lib/sw-legacy-queue');
    await new Promise<void>((resolve, reject) => {
      const req = globalThis.indexedDB.open(BG_SYNC_DB_NAME, 3);
      req.onupgradeneeded = () => {
        req.result
          .createObjectStore('requests', { autoIncrement: true, keyPath: 'id' })
          .createIndex('queueName', 'queueName', { unique: false });
      };
      req.onsuccess = () => {
        const tx = req.result.transaction('requests', 'readwrite');
        const s = tx.objectStore('requests');
        s.add({ queueName: 'dr3-server-actions', requestData: { url: '/x' }, timestamp: 1 });
        s.add({ queueName: 'dr3-server-actions', requestData: { url: '/y' }, timestamp: 2 });
        s.add({ queueName: 'dr3-photo-put', requestData: { url: '/p' }, timestamp: 3 });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    const handlers = captured.listeners.get('activate') ?? [];
    expect(handlers.length, 'sw.ts registers no activate handler').toBe(1);
    const waited: Promise<unknown>[] = [];
    handlers[0]!({ waitUntil: (p: Promise<unknown>) => waited.push(p) });
    expect(waited.length).toBe(1);
    await waited[0];

    const left = await new Promise<string[]>((resolve, reject) => {
      const req = globalThis.indexedDB.open(BG_SYNC_DB_NAME);
      req.onsuccess = () => {
        const all = req.result.transaction('requests').objectStore('requests').getAll();
        all.onsuccess = () => {
          req.result.close();
          resolve((all.result as Array<{ queueName: string }>).map((r) => r.queueName));
        };
        all.onerror = () => reject(all.error);
      };
      req.onerror = () => reject(req.error);
    });
    expect(left).toEqual(['dr3-photo-put']);
  });
});
