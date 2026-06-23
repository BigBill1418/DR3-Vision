'use client';

// PWA "update available" prompt + safe auto-refresh (ADR-0027, hardened
// 2026-06-23 after the payroll-signing stale-shell incident).
//
// DR3-Vision is an installed Serwist PWA. After a deploy the open/installed
// PWA keeps serving the OLD precached shell; its `/_next/static/chunks/*.js`
// references 404 and pages render blank / read-only — which read to a signer
// (Morena, 2026-06-22) as a "read-only error" that stranded her mid-deadline.
// With `skipWaiting: false` (sw.ts, ADR-0027) a freshly installed SW PARKS in
// the `waiting` state instead of self-activating, so the page controls WHEN it
// promotes.
//
// Two failure modes the original prompt left open, both fixed here:
//
//   (1) The waiting worker was only ever DETECTED on `updatefound`, which the
//       browser fires on navigation or its own slow (~24h) cadence. A signer
//       sitting on an open tab after a deploy might never see the banner. FIX:
//       poll `registration.update()` on an interval AND whenever the tab
//       becomes visible — so a freshly deployed worker is found within ~60s.
//
//   (2) A stranded read-only shell is exactly when the banner is least usable
//       (blank page / the operator may not notice or understand it). FIX:
//       AUTO-promote the waiting worker when it is SAFE — i.e. when the tab is
//       HIDDEN (operator is not actively looking, so a reload can't interrupt
//       data entry). When the tab is VISIBLE we still only show the explicit
//       banner, because an operator may be mid-entry at the dock. Net effect:
//       a signer who left the tab open and comes back gets the fresh shell
//       already loaded instead of a stale read-only one.
//
// Flow:
//   1. On mount, grab the registration and check `registration.waiting` — a
//      worker may already be waiting from a deploy that happened while the tab
//      was closed.
//   2. Listen for `updatefound`; when the new `installing` worker reaches
//      `installed` AND `navigator.serviceWorker.controller` exists (i.e. this
//      is an UPDATE, not the first-ever install), record the waiting worker.
//   3. Decide: tab hidden → auto-promote silently; tab visible → show banner.
//   4. Promote: post `SKIP_WAITING` to the waiting worker (sw.ts promotes it),
//      then reload exactly once on `controllerchange` (guarded by a `refreshing`
//      flag so we never loop).
//
// The component renders nothing until an update is genuinely pending and the
// tab is visible, is SSR-safe, and no-ops gracefully where service workers are
// unsupported.
//
// The DOM/effect logic is split from the presentational banner so the banner's
// behavior (renders strings, calls back on tap/dismiss) is unit-testable
// without a real ServiceWorkerRegistration.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';

// How often an open tab re-checks the server for a newer SW. 60s keeps the
// post-deploy refresh latency tolerable without hammering the edge (the /sw.js
// fetch is `max-age=0, must-revalidate` — one conditional request per tick).
const UPDATE_POLL_MS = 60_000;

export function UpdateBanner({
  onReload,
  onDismiss,
}: {
  onReload: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="update-prompt"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-3"
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-dr3-cyan/45 bg-dr3-space-2/95 px-4 py-3 text-dr3-mist shadow-lg backdrop-blur">
        <div className="min-w-0 flex-1 text-start">
          <p className="truncate text-sm font-semibold text-dr3-cyan-bright">
            {t('update_prompt.title')}
          </p>
          <p className="mt-0.5 text-xs text-dr3-mist-dim">{t('update_prompt.body')}</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded-lg px-2 py-2 text-xs font-medium text-dr3-mist-dim hover:text-dr3-mist"
        >
          {t('update_prompt.dismiss')}
        </button>
        <button
          type="button"
          onClick={onReload}
          className="shrink-0 rounded-lg bg-dr3-green px-4 py-2 text-sm font-semibold text-dr3-ink hover:bg-dr3-green-dark hover:text-dr3-mist"
        >
          {t('update_prompt.reload')}
        </button>
      </div>
    </div>
  );
}

/** Is the tab safe to silently reload right now? Hidden = operator not looking. */
function tabIsHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function UpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Guards the single reload on `controllerchange` — without it a fast
  // activate could fire `controllerchange` more than once and reload-loop.
  const refreshing = useRef(false);
  // The worker we've recorded as waiting, kept in a ref so the visibility
  // handler can promote it without re-subscribing on every state change.
  const waitingRef = useRef<ServiceWorker | null>(null);

  // Promote a waiting worker: ask sw.ts to skipWaiting; the actual reload then
  // happens once on `controllerchange`. Idempotent — safe to call from the
  // banner tap, the auto-promote path, or a visibility change.
  const promoteNow = useCallback((worker: ServiceWorker) => {
    worker.postMessage({ type: 'SKIP_WAITING' });
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const sw = navigator.serviceWorker;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    // Record a genuine UPDATE (page already controlled — not the first install).
    // If the tab is HIDDEN we promote silently (the safe auto-refresh path);
    // otherwise we surface the banner and let the operator choose.
    const record = (worker: ServiceWorker | null) => {
      if (cancelled || !worker || !sw.controller) return;
      waitingRef.current = worker;
      if (tabIsHidden()) {
        promoteNow(worker); // reload happens on controllerchange
      } else {
        setWaiting(worker);
      }
    };

    const watchInstalling = (reg: ServiceWorkerRegistration) => {
      const installing = reg.installing;
      if (!installing) return;
      const onState = () => {
        if (installing.state === 'installed') record(reg.waiting ?? installing);
      };
      installing.addEventListener('statechange', onState);
      cleanups.push(() => installing.removeEventListener('statechange', onState));
    };

    let pollTimer: ReturnType<typeof setInterval> | undefined;

    void sw.getRegistration().then((reg) => {
      if (cancelled || !reg) return;
      // A worker may already be parked from a deploy while the tab was closed.
      if (reg.waiting) record(reg.waiting);
      // …or one may be installing right now.
      watchInstalling(reg);
      const onUpdateFound = () => watchInstalling(reg);
      reg.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));

      // (1) Periodically ask the server whether a newer SW exists, so an
      // open tab notices a deploy without the operator navigating. `update()`
      // is a no-op when nothing changed; on a real change it drives
      // `updatefound` → `record`.
      const checkForUpdate = () => {
        if (!cancelled) void reg.update().catch(() => {});
      };
      pollTimer = setInterval(checkForUpdate, UPDATE_POLL_MS);
      cleanups.push(() => clearInterval(pollTimer));

      // (2) On tab re-focus: re-check for updates, and if one is already
      // waiting and the tab is now hidden again, promote it. The visibility
      // change to "visible" is also the natural moment to check the server.
      const onVisibility = () => {
        if (cancelled) return;
        if (document.visibilityState === 'visible') {
          checkForUpdate();
        } else if (waitingRef.current) {
          // Tab just went hidden while an update was pending → safe to refresh.
          promoteNow(waitingRef.current);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    });

    // When the promoted worker takes control, reload once so the page is served
    // by the new SW + fresh precache.
    const onControllerChange = () => {
      if (refreshing.current) return;
      refreshing.current = true;
      window.location.reload();
    };
    sw.addEventListener('controllerchange', onControllerChange);
    cleanups.push(() => sw.removeEventListener('controllerchange', onControllerChange));

    return () => {
      cancelled = true;
      for (const c of cleanups) c();
    };
  }, [promoteNow]);

  const onReload = useCallback(() => {
    if (waiting) {
      promoteNow(waiting);
      // The actual reload happens on `controllerchange` once the new SW
      // activates and claims the client.
    } else {
      // Defensive: no waiting worker reference but the user asked to reload.
      window.location.reload();
    }
  }, [waiting, promoteNow]);

  const onDismiss = useCallback(() => setDismissed(true), []);

  if (!waiting || dismissed) return null;
  return <UpdateBanner onReload={onReload} onDismiss={onDismiss} />;
}
