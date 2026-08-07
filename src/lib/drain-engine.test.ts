// @vitest-environment jsdom
//
// ADR-0078 G8 — the drain engine.
//
// Bill: *"drain should happen no matter what page its on and it should make sure
// all data is always pushed down - not as an afterthought."*
//
// Both halves are structural claims, so both get structural guards:
//   - "no matter what page" → ONE engine, mounted above every screen, and
//     exactly one caller of `replayAll` in the app.
//   - "not as an afterthought" → an enqueue triggers a drain IMMEDIATELY, and a
//     parked iPad drains the instant it is foregrounded rather than on a timer
//     that is suspended precisely while it is parked.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const replayAll = vi.hoisted(() =>
  vi.fn(async () => ({
    uploads_replayed: 0,
    uploads_failed: 0,
    actions_replayed: 0,
    actions_failed: 0,
    conflicts: 0,
    blocked: 0,
    auth: 0,
  })),
);
const enqueueListeners = vi.hoisted(() => new Set<() => void>());

vi.mock('@/lib/offline-queue', () => ({
  replayAll,
  subscribeToEnqueue: (fn: () => void) => {
    enqueueListeners.add(fn);
    return () => enqueueListeners.delete(fn);
  },
}));

import {
  startDrainEngine,
  drainNow,
  subscribeToDrain,
  registerBackgroundSync,
} from './drain-engine';

/** Flush the microtask queue so `drainNow`'s promise chain settles. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  enqueueListeners.clear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => 'visible',
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ADR-0078 G8 — the trigger matrix', () => {
  it('drains on mount', async () => {
    stop = startDrainEngine();
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  it('drains when the network returns', async () => {
    stop = startDrainEngine();
    await settle();
    replayAll.mockClear();
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  // The iPad case. A parked tab has its timers throttled or suspended, so the
  // 30s interval is exactly the trigger that CANNOT fire while parked — the
  // moment of waking has to be its own trigger or a returning operator waits.
  //
  // FALSIFIED BY HAND: removing the `visibilitychange` listener leaves this at
  // zero calls, i.e. an operator picks the iPad back up and nothing sends.
  it('drains the instant the tab becomes visible', async () => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    stop = startDrainEngine();
    await settle();
    replayAll.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  // Safari restores from the back/forward cache WITHOUT firing
  // `visibilitychange` and without re-running effects, so this is a genuinely
  // separate trigger and not a belt-and-braces duplicate of the one above.
  it('drains on pageshow (BFCache resume)', async () => {
    stop = startDrainEngine();
    await settle();
    replayAll.mockClear();
    window.dispatchEvent(new Event('pageshow'));
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  // "Not as an afterthought", made literal: a write that just failed over to the
  // queue is retried NOW, not up to 30 seconds from now.
  //
  // FALSIFIED BY HAND: dropping `subscribeToEnqueue` from the engine leaves this
  // at zero — the queue becomes a waiting room again.
  it('drains immediately after every enqueue', async () => {
    stop = startDrainEngine();
    await settle();
    replayAll.mockClear();
    for (const fn of enqueueListeners) fn();
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  it('drains on the interval while foregrounded', async () => {
    vi.useFakeTimers();
    stop = startDrainEngine();
    replayAll.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  // A hidden tab polling a server it cannot usefully reach is battery cost with
  // no benefit; `visibilitychange` covers the moment that matters.
  it('suspends the interval while hidden', async () => {
    vi.useFakeTimers();
    stop = startDrainEngine();
    replayAll.mockClear();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(120_000);
    expect(replayAll).not.toHaveBeenCalled();
  });
});

describe('ADR-0078 G8 — exactly one engine', () => {
  // React 18 StrictMode double-invokes effects in development, so a second
  // mount is the ordinary case rather than a mistake. Two engines would double
  // every sweep AND every count refresh — and the refresh is not deduped, so on
  // the device holding 99 photos that is a real cost.
  it('a second start is a no-op while one is already running', async () => {
    stop = startDrainEngine();
    await settle();
    replayAll.mockClear();

    const second = startDrainEngine();
    await settle();
    expect(replayAll, 'a second engine started and drained').not.toHaveBeenCalled();
    second();

    // …and the first engine is still live.
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(replayAll).toHaveBeenCalledTimes(1);
  });

  it('publishes every outcome to observers', async () => {
    const seen: string[] = [];
    const un = subscribeToDrain((_r, trigger) => seen.push(trigger));
    await drainNow('signin');
    expect(seen).toEqual(['signin']);
    un();
  });

  // The single-caller property, checked against the source rather than asserted
  // in prose. If the connection hook (or a page) starts calling `replayAll`
  // again, there are two sweep owners and two refresh loops.
  it('replayAll has exactly ONE caller in app code', () => {
    // Resolved from the vitest cwd (repo root) rather than from import.meta.url,
    // which the transform rewrites to a virtual path under this runner.
    const SRC = join(process.cwd(), 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (/\.test\.tsx?$/.test(entry)) continue;
        // The queue module DEFINES it; the conflicts screen sweeps after an
        // explicit operator action (Retry / Retry all / Re-submit), which is a
        // person asking, not a second schedule.
        if (full.endsWith('/lib/offline-queue.ts')) continue;
        if (full.includes('/queue/conflicts/')) continue;
        const src = readFileSync(full, 'utf8');
        for (const line of src.split('\n')) {
          // Ignore prose in comments.
          if (/^\s*(\/\/|\*)/.test(line)) continue;
          if (/\breplayAll\s*\(/.test(line)) hits.push(`${full.split('/src/')[1]}: ${line.trim()}`);
        }
      }
    };
    walk(SRC);
    expect(hits, `expected exactly one caller, found:\n${hits.join('\n')}`).toHaveLength(1);
    expect(hits[0]).toContain('drain-engine.ts');
  });
});

describe('ADR-0078 G8 — Background Sync is progressive enhancement', () => {
  it('registers when the platform supports it', async () => {
    const register = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({ sync: { register } }) },
    });
    await expect(registerBackgroundSync()).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('dr3-queue-drain');
  });

  // iOS. WebKit has never shipped Background Sync, and the DR3 floor runs on
  // iPads — so `false` here is the NORMAL production outcome, not an error path.
  // ADR-0078 states the consequence rather than implying a guarantee: on an iPad
  // the queue drains whenever the app is open on any screen, and there is no
  // closed-app execution.
  it('is a silent no-op where the API is absent (iOS)', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: { ready: Promise.resolve({}) }, // no `sync`
    });
    await expect(registerBackgroundSync()).resolves.toBe(false);
  });

  it('is a no-op where there is no service worker at all', async () => {
    vi.stubGlobal('navigator', {});
    await expect(registerBackgroundSync()).resolves.toBe(false);
  });
});
