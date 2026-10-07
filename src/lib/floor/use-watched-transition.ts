'use client';

// `useTransition` that notices when its work has been in flight too long.
//
// Every floor button runs a server action inside `useTransition`, and `isPending`
// stays true until the action settles. A server action cannot be given a timeout
// from the client, and Next runs them one at a time, so one stalled request leaves
// its button disabled — and everything behind it — until the page is reloaded.
//
// This keeps `useTransition`'s signature (a drop-in swap) and adds one thing: if
// a callback handed to `startTransition` has not settled after STALL_AFTER_MS it
// raises a `dr3:stall` window event, and lowers it when everything has settled.
// The `StallBanner` in FloorShell listens and offers Reload. It does NOT cancel
// the action: the write may still land, and every queued write is idempotent, so
// a reload is safe and is the only thing that frees a wedged action queue.
//
// It tracks the in-flight work ITSELF rather than reading `isPending`. The app
// router runs on Next's bundled React, where `isPending` spans an async action;
// plain React 18 (what the unit tests resolve) ends it at the first await. Reading
// our own settle point behaves identically under both, so what the tests prove is
// what runs on the iPad. Sync callbacks (a `router.push`) stay sync.

import { useCallback, useEffect, useRef, useTransition } from 'react';

export const STALL_AFTER_MS = 25_000;
export const STALL_EVENT = 'dr3:stall';

function emit(stalled: boolean): void {
  window.dispatchEvent(new CustomEvent(STALL_EVENT, { detail: { stalled } }));
}

type Start = ReturnType<typeof useTransition>[1];

export function useWatchedTransition(): ReturnType<typeof useTransition> {
  const [isPending, startTransition] = useTransition();
  const inflight = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raised = useRef(false);

  const settle = useCallback(() => {
    inflight.current = Math.max(0, inflight.current - 1);
    if (inflight.current > 0) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (raised.current) {
      raised.current = false;
      emit(false);
    }
  }, []);

  // Leaving the screen (a working navigation) lowers the banner and drops the timer.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (raised.current) {
        raised.current = false;
        emit(false);
      }
    },
    [],
  );

  const watched = useCallback(
    (cb: () => unknown) => {
      inflight.current += 1;
      if (!timer.current) {
        timer.current = setTimeout(() => {
          raised.current = true;
          emit(true);
        }, STALL_AFTER_MS);
      }
      // React's overloads split sync from async at the type level; whether `cb` is
      // async is only known once it has run, and React itself checks for a thenable
      // at runtime, so one runner serves both.
      const run = (): Promise<void> | undefined => {
        let result: unknown;
        try {
          result = cb();
        } catch (e) {
          settle();
          throw e;
        }
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return (result as Promise<void>).finally(settle);
        }
        settle();
        return undefined;
      };
      startTransition(run as () => Promise<void>);
    },
    [startTransition, settle],
  );

  // Same call shape as `startTransition` (sync or async callback); the cast only
  // reconciles React's two overload signatures with our single runtime check.
  return [isPending, watched as unknown as Start];
}
