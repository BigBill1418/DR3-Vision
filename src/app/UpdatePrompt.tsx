'use client';

// PWA "update available — tap to reload" prompt (ADR-0027).
//
// DR3-Vision is an installed Serwist PWA. After a deploy the open/installed
// PWA keeps serving the OLD precached shell; its `/_next/static/chunks/*.js`
// references 404 and pages render blank — which once read to the operator as
// "all my data is gone." With `skipWaiting: false` (sw.ts, ADR-0027) a freshly
// installed SW now PARKS in the `waiting` state instead of self-activating, so
// the page can detect it and offer an explicit, user-controlled reload.
//
// Flow:
//   1. On mount, grab the registration and check `registration.waiting` — a
//      worker may already be waiting from a deploy that happened while the tab
//      was closed.
//   2. Listen for `updatefound`; when the new `installing` worker reaches the
//      `installed` state AND `navigator.serviceWorker.controller` exists (i.e.
//      this is an UPDATE, not the first-ever install), surface the banner.
//   3. On tap: post `SKIP_WAITING` to the waiting worker (sw.ts promotes it),
//      then reload exactly once on `controllerchange` (guarded by a `refreshing`
//      flag so we never loop).
//
// We never auto-reload — operators may be mid data-entry at the dock. The
// component renders nothing until an update is genuinely pending, is SSR-safe,
// and no-ops gracefully where service workers are unsupported.
//
// The DOM/effect logic is split from the presentational banner so the banner's
// behavior (renders strings, calls back on tap/dismiss) is unit-testable
// without a real ServiceWorkerRegistration.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n/provider';

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

export function UpdatePrompt() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  // Guards the single reload on `controllerchange` — without it a fast
  // activate could fire `controllerchange` more than once and reload-loop.
  const refreshing = useRef(false);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    const sw = navigator.serviceWorker;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    // A worker is a genuine UPDATE (not the first install) only when the page
    // is already controlled by a SW. On the very first install there is no
    // controller yet — that worker should activate silently, not prompt.
    const promote = (worker: ServiceWorker | null) => {
      if (!cancelled && worker && sw.controller) setWaiting(worker);
    };

    const watchInstalling = (reg: ServiceWorkerRegistration) => {
      const installing = reg.installing;
      if (!installing) return;
      const onState = () => {
        if (installing.state === 'installed') promote(reg.waiting ?? installing);
      };
      installing.addEventListener('statechange', onState);
      cleanups.push(() => installing.removeEventListener('statechange', onState));
    };

    void sw.getRegistration().then((reg) => {
      if (cancelled || !reg) return;
      // A worker may already be parked from a deploy while the tab was closed.
      if (reg.waiting) promote(reg.waiting);
      // …or one may be installing right now.
      watchInstalling(reg);
      const onUpdateFound = () => watchInstalling(reg);
      reg.addEventListener('updatefound', onUpdateFound);
      cleanups.push(() => reg.removeEventListener('updatefound', onUpdateFound));
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
  }, []);

  const onReload = useCallback(() => {
    if (waiting) {
      waiting.postMessage({ type: 'SKIP_WAITING' });
      // The actual reload happens on `controllerchange` once the new SW
      // activates and claims the client.
    } else {
      // Defensive: no waiting worker reference but the user asked to reload.
      window.location.reload();
    }
  }, [waiting]);

  const onDismiss = useCallback(() => setDismissed(true), []);

  if (!waiting || dismissed) return null;
  return <UpdateBanner onReload={onReload} onDismiss={onDismiss} />;
}
