/// <reference lib="webworker" />
import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig, RuntimeCaching } from 'serwist';
import { CacheFirst, ExpirationPlugin, NetworkFirst, NetworkOnly, Serwist } from 'serwist';
import { BackgroundSyncPlugin } from '@serwist/background-sync';

// Service Worker entry point for DR3-Vision (T-009 / ADR-0006).
//
// Cache versioning is explicit via `cacheId` — bumping the constant
// invalidates every Serwist-managed cache without touching the precache
// hash. `__SW_BUILD_ID__` comes from `next.config.js` (a `define` is
// not strictly necessary because `injectManifest` already emits a
// per-build precache hash, but having a coarse version we can read from
// DevTools is cheap insurance).
//
// `BackgroundSyncPlugin` queues failed POST/PUT requests in IndexedDB
// (separate DB from the operator queue at `src/lib/offline-queue.ts`)
// and replays them on the next `sync` event from the browser. The
// operator-side replay loop in offline-queue.ts is the primary path on
// iPad Safari (which does not implement the Background Sync API);
// BackgroundSyncPlugin is the belt-and-braces backstop for any
// browser that does.

declare const self: ServiceWorkerGlobalScope &
  SerwistGlobalConfig & {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  };

const CACHE_VERSION = 'dr3-v1';

// Background-sync queues — one per offline-able request shape.
// `maxRetentionTime` in MINUTES per Workbox convention. 24h gives the
// iPad time to come back online overnight without losing queued items.
const photoMintQueue = new BackgroundSyncPlugin('dr3-photo-mint', {
  maxRetentionTime: 24 * 60,
});
const photoPutQueue = new BackgroundSyncPlugin('dr3-photo-put', {
  maxRetentionTime: 24 * 60,
});
const photoConfirmQueue = new BackgroundSyncPlugin('dr3-photo-confirm', {
  maxRetentionTime: 24 * 60,
});
const serverActionQueue = new BackgroundSyncPlugin('dr3-server-actions', {
  maxRetentionTime: 24 * 60,
});

// Custom routes layered IN FRONT of `defaultCache`. Order matters —
// Serwist evaluates `runtimeCaching` top-down and the first matcher
// wins. We need:
//   - R2 photo GETs cached aggressively (manager portal preview)
//   - operator API GETs use NetworkFirst with a tight 5s timeout
//   - photo upload endpoints get the BackgroundSyncPlugin so a failed
//     POST/PUT lands in the SW's IDB queue (in addition to the
//     application-level queue in `src/lib/offline-queue.ts`)
//   - Next.js server actions land at the page route via POST with
//     `Next-Action` header — those get queued too
const customCaching: RuntimeCaching[] = [
  // ADR-0078 — /healthz is NEVER cached, and this entry must stay FIRST.
  //
  // `useConnectionState` pings /healthz to answer "can this iPad actually reach
  // the app?", because `navigator.onLine` on iPadOS reports only that a network
  // interface exists — an iPad on an access point with a dead uplink says
  // `true`, which is the exact failure JT reported.
  //
  // `defaultCache` ends with an `others` entry matching every same-origin path
  // that is not under `/api/`, on NetworkFirst. /healthz matches it. So without
  // this rule, the ping on a dead uplink falls back to a CACHED 200 and the
  // indicator reports "connected" while every replay fails — the detection
  // defeated by the app's own service worker. `cache: 'no-store'` on the fetch
  // does not help: that is an HTTP-cache directive and does not bypass the SW.
  //
  // Order is load-bearing: `runtimeCaching` is [...customCaching, ...defaultCache]
  // and the first matching entry wins. Move this below `defaultCache` and the
  // catch-all silently reclaims it.
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/healthz',
    method: 'GET',
    handler: new NetworkOnly(),
  },
  // R2 photo previews — CacheFirst, 200 entries, 7 days
  {
    matcher: ({ url }) =>
      url.hostname.endsWith('.r2.cloudflarestorage.com') ||
      url.hostname === 'photos.dr3-vision.svdp.us' ||
      url.hostname === 'photos-dev.dr3-vision.svdp.us',
    method: 'GET',
    handler: new CacheFirst({
      cacheName: 'dr3-r2-photos',
      plugins: [
        new ExpirationPlugin({
          maxEntries: 200,
          maxAgeSeconds: 7 * 24 * 60 * 60,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },
  // Operator data API GETs — NetworkFirst with 5s fallback to cache
  {
    matcher: ({ url, sameOrigin }) =>
      sameOrigin && /^\/api\/(loads|sources|transporters|users)(\/|$)/.test(url.pathname),
    method: 'GET',
    handler: new NetworkFirst({
      cacheName: 'dr3-api-data',
      networkTimeoutSeconds: 5,
      plugins: [
        new ExpirationPlugin({
          maxEntries: 64,
          maxAgeSeconds: 5 * 60,
          maxAgeFrom: 'last-used',
        }),
      ],
    }),
  },
  // Photo upload-url POST — queue on failure
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/api/photos/upload-url',
    method: 'POST',
    handler: new NetworkFirst({
      cacheName: 'dr3-no-cache',
      networkTimeoutSeconds: 10,
      plugins: [photoMintQueue],
    }),
  },
  // Photo confirm POST — queue on failure
  {
    matcher: ({ url, sameOrigin }) => sameOrigin && url.pathname === '/api/photos/confirm',
    method: 'POST',
    handler: new NetworkFirst({
      cacheName: 'dr3-no-cache',
      networkTimeoutSeconds: 10,
      plugins: [photoConfirmQueue],
    }),
  },
  // Cross-origin R2 PUT — queue on failure. Match by hostname only.
  {
    matcher: ({ url, request }) =>
      request.method === 'PUT' && url.hostname.endsWith('.r2.cloudflarestorage.com'),
    method: 'PUT',
    handler: new NetworkFirst({
      cacheName: 'dr3-no-cache',
      networkTimeoutSeconds: 30,
      plugins: [photoPutQueue],
    }),
  },
  // Next.js server actions — same-origin POST to a page route with the
  // `Next-Action` header. Queue on failure so reload-after-replay sees
  // the action.
  {
    matcher: ({ request, sameOrigin, url }) =>
      sameOrigin &&
      request.method === 'POST' &&
      request.headers.has('Next-Action') &&
      !url.pathname.startsWith('/api/'),
    method: 'POST',
    handler: new NetworkFirst({
      cacheName: 'dr3-no-cache',
      networkTimeoutSeconds: 10,
      plugins: [serverActionQueue],
    }),
  },
];

const serwist = new Serwist({
  // `__SW_MANIFEST` is injected by `@serwist/next` at build time. The
  // `?? []` is for `exactOptionalPropertyTypes: true` (tsconfig); at
  // runtime this is always populated.
  precacheEntries: self.__SW_MANIFEST ?? [],
  // `skipWaiting: false` (ADR-0027) — a freshly installed SW parks in the
  // `waiting` state instead of self-activating. This is what lets the
  // in-page UpdatePrompt detect "an update is ready" and let the operator
  // choose when to reload (operators may be mid data-entry at the dock).
  // The prompt promotes the waiting worker on tap via the `SKIP_WAITING`
  // message handler below. `clientsClaim` stays `true` so that — once the
  // new SW DOES activate — it controls the open page immediately without a
  // second navigation.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  cacheId: CACHE_VERSION,
  runtimeCaching: [...customCaching, ...defaultCache],
});

serwist.addEventListeners();

// Allow the page to force-promote a waiting SW immediately. Used by
// the in-page "update available" prompt (`src/app/UpdatePrompt.tsx`,
// ADR-0027): the client posts `SKIP_WAITING` when the operator taps
// "Reload", we `skipWaiting()`, the new SW activates, `clientsClaim`
// takes control, and the client reloads once on `controllerchange`.
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});
