'use client';

import { replayAll, subscribeToEnqueue, type ReplayResult } from '@/lib/offline-queue';

// ADR-0078 G8 — the drain engine.
//
// Bill's directive, verbatim: *"drain should happen no matter what page its on
// and it should make sure all data is always pushed down - not as an
// afterthought."*
//
// That is an architectural statement, not a feature request, and it rules out
// the shape this code had. Replay used to live INSIDE screens: `load-workflow`
// ran a sweep loop, `pending-banner` ran a different one, and every other screen
// ran none. So whether an operator's queued count went anywhere depended on
// which page they happened to be looking at — the queue drained on the load
// workflow and merely *displayed* on the queue page. That is the definition of
// an afterthought.
//
// The engine is now mounted ONCE, in the operator layout, and every operator
// screen inherits it because it is above all of them rather than inside any of
// them. Nothing here is a component's responsibility any more.
//
// ## The trigger matrix
//
// | Trigger              | Why it exists                                            |
// |----------------------|----------------------------------------------------------|
// | mount                | anything queued by a previous session drains immediately  |
// | `online`             | the network came back                                     |
// | `visibilitychange`   | the operator returned to the tab — the iPad case          |
// | `pageshow`           | BFCache resume; `visibilitychange` does NOT fire for this |
// | 30s interval         | the AP says online but the server is unreachable          |
// | after every enqueue  | a queued write attempts at once, not up to 30s later      |
//
// The last row is the one that makes "always pushed down" true rather than
// eventually true: a write that fails over to the queue tries again immediately,
// so the queue is a retry path and not a waiting room.
//
// The interval is suspended while hidden. A background tab that keeps polling a
// server it cannot usefully reach is battery cost with no benefit, and
// `visibilitychange` already covers the moment it matters.

/** Named so the connection hook and the tests describe the same events. */
export type DrainTrigger =
  | 'mount'
  | 'online'
  | 'visible'
  | 'pageshow'
  | 'interval'
  | 'enqueue'
  | 'manual'
  | 'signin';

const INTERVAL_MS = 30_000;

// ── One engine, and observers ─────────────────────────────────────────────
//
// `replayAll` has exactly ONE caller in the app outside the conflicts screen:
// `drainNow` below. That is the property that makes "one engine" checkable
// rather than merely intended, and `drain-engine.test.ts` greps for it.
//
// The connection indicator used to call `replayAll` itself. With the engine
// mounted on every screen that meant two sweep owners racing, and — worse — two
// independent `refresh()` loops, which is not deduped and would have doubled the
// queue reads on the one device holding the irreplaceable rows. The hook now
// OBSERVES: it subscribes to results and asks for a sweep by name.

type DrainObserver = (result: ReplayResult | null, trigger: DrainTrigger) => void;
const observers = new Set<DrainObserver>();

/** Subscribe to every drain outcome. Returns an unsubscribe. */
export function subscribeToDrain(fn: DrainObserver): () => void {
  observers.add(fn);
  return () => {
    observers.delete(fn);
  };
}

function publish(result: ReplayResult | null, trigger: DrainTrigger): void {
  for (const fn of observers) {
    try {
      fn(result, trigger);
    } catch {
      // An observer's failure must not stop the other observers, or the engine.
    }
  }
}

/**
 * Run one sweep now. THE single entry point to `replayAll` for the whole app
 * (the conflicts screen aside, which sweeps after an explicit operator action).
 */
export function drainNow(trigger: DrainTrigger = 'manual'): Promise<void> {
  return replayAll()
    .then((result) => publish(result, trigger))
    .catch(() => {
      // Per-row outcomes live on each row's `last_error`; a throw here is the
      // sweep itself failing, which the next trigger retries.
      publish(null, trigger);
    });
}

/** True while an engine is mounted. Guards against a second mount. */
let engineRunning = false;
export function isDrainEngineRunning(): boolean {
  return engineRunning;
}

/**
 * Start the engine. Returns a stop function.
 *
 * Deliberately framework-free — no React — so it can be unit-tested against a
 * plain DOM and so the layout component that mounts it stays a three-line
 * wrapper. `replayAll()` already dedupes concurrent invocations, so overlapping
 * triggers are safe by construction and none of the listeners below need to
 * coordinate with each other.
 */
export function startDrainEngine(): () => void {
  // A second engine would double every sweep and every count refresh. React 18
  // StrictMode double-invokes effects in development, so this is reached in the
  // ordinary case and not only through a mistake.
  if (engineRunning) return () => undefined;
  engineRunning = true;

  let stopped = false;
  let timer: number | null = null;

  // The flag is set before any listener is attached, so a throw between here and
  // the return would strand it `true` for the document's lifetime — engine dead,
  // `isDrainEngineRunning()` still reporting healthy, no cleanup ever delivered.
  const failStart = (e: unknown): never => {
    engineRunning = false;
    throw e;
  };

  const drain = (trigger: DrainTrigger): void => {
    if (stopped) return;
    void drainNow(trigger);
  };

  const startInterval = (): void => {
    if (timer !== null) return;
    timer = window.setInterval(() => drain('interval'), INTERVAL_MS);
  };
  const stopInterval = (): void => {
    if (timer === null) return;
    window.clearInterval(timer);
    timer = null;
  };

  const onOnline = (): void => drain('online');
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      startInterval();
      drain('visible');
    } else {
      stopInterval();
    }
  };
  // BFCache resume. Safari restores a page from the back/forward cache WITHOUT
  // firing `visibilitychange`, so an iPad returning to a suspended tab would
  // otherwise sit idle until the next interval tick — which is also suspended.
  const onPageShow = (): void => {
    startInterval();
    drain('pageshow');
  };

  try {
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
  } catch (e) {
    failStart(e);
  }

  // Every enqueue attempts immediately. This is the "not as an afterthought"
  // half: the queue is where a failed write goes to be retried at once, not
  // where it waits for a timer.
  const unsubscribe = subscribeToEnqueue(() => drain('enqueue'));

  if (document.visibilityState === 'visible') startInterval();
  drain('mount');

  return () => {
    stopped = true;
    engineRunning = false;
    stopInterval();
    unsubscribe();
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pageshow', onPageShow);
  };
}

// ── Service-worker Background Sync — progressive enhancement only ──────────
//
// Registering a one-shot Background Sync lets the browser drain the queue after
// the tab is closed. Where it exists, it is strictly better than anything a page
// can do.
//
// **It does not exist on iOS.** WebKit has never shipped the Background Sync API
// or Periodic Background Sync, and the DR3 floor runs on iPads. So this is
// capability-detected and a no-op there, and the ADR states the limit plainly
// rather than implying a guarantee we cannot make: on an iPad the queue drains
// whenever the app is open on ANY screen (which the engine above guarantees) and
// resumes the instant it is foregrounded. There is no closed-app execution, and
// pretending otherwise would be the kind of claim that stops anyone from
// checking.
export const BACKGROUND_SYNC_TAG = 'dr3-queue-drain';

// Structurally typed rather than `extends ServiceWorkerRegistration`: the DOM
// lib declares `sync: SyncManager` as REQUIRED, which is a lie on every browser
// that does not implement it — and the point of this code is to cope with its
// absence.
type SyncCapableRegistration = { sync?: { register(tag: string): Promise<void> } };

/**
 * Register one-shot Background Sync when the platform has it.
 *
 * Returns whether it was registered — `false` on iOS and anywhere else the API
 * is absent, which is a supported outcome and not an error.
 */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
    const reg = (await navigator.serviceWorker.ready) as unknown as SyncCapableRegistration;
    if (!reg.sync || typeof reg.sync.register !== 'function') return false;
    await reg.sync.register(BACKGROUND_SYNC_TAG);
    return true;
  } catch {
    // A SecurityError (permission denied) or an unsupported tag is a
    // no-enhancement outcome, never a failure of the page.
    return false;
  }
}
