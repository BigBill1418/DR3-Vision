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
// raises a `dr3:stall` window event, and lowers it when no stalled job remains
// (each job has its own clock — see `useStallTracker`).
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

/**
 * The shared in-flight tracker behind both hooks below. Raises `dr3:stall` once
 * when ANY watched job on this screen has been unsettled for STALL_AFTER_MS, and
 * lowers it when no stalled job remains or the screen unmounts.
 *
 * ADR-0140 Amendment 1 (review F2) — every job carries ITS OWN 25 s clock. The
 * first version kept one screen-wide timer armed by the first job and cleared
 * only when the in-flight count reached zero, so when job 1 settled while job 2
 * was still running, job 1's clock kept ticking for job 2 and the Reload banner
 * could appear a few seconds into job 2. Per-job clocks also avoid the opposite
 * mistake — restarting one shared clock on every begin — which would let a
 * second tap hide a genuinely stalled first job indefinitely.
 */
function useStallTracker(): { begin: () => number; settle: (id: number) => void } {
  const jobs = useRef(
    new Map<number, { timer: ReturnType<typeof setTimeout>; stalled: boolean }>(),
  );
  const nextId = useRef(0);
  const raised = useRef(false);

  // Reconcile the banner with the jobs: up iff some unsettled job is past its deadline.
  const sync = useCallback(() => {
    let anyStalled = false;
    for (const j of jobs.current.values()) if (j.stalled) anyStalled = true;
    if (anyStalled && !raised.current) {
      raised.current = true;
      emit(true);
    } else if (!anyStalled && raised.current) {
      raised.current = false;
      emit(false);
    }
  }, []);

  const settle = useCallback(
    (id: number) => {
      const job = jobs.current.get(id);
      if (!job) return; // settled twice, or after unmount
      clearTimeout(job.timer);
      jobs.current.delete(id);
      sync();
    },
    [sync],
  );

  const begin = useCallback(() => {
    nextId.current += 1;
    const id = nextId.current;
    const job = {
      stalled: false,
      timer: setTimeout(() => {
        job.stalled = true;
        sync();
      }, STALL_AFTER_MS),
    };
    jobs.current.set(id, job);
    return id;
  }, [sync]);

  // Leaving the screen (a working navigation) lowers the banner and drops every timer.
  useEffect(() => {
    const map = jobs.current;
    return () => {
      for (const j of map.values()) clearTimeout(j.timer);
      map.clear();
      if (raised.current) {
        raised.current = false;
        emit(false);
      }
    };
  }, []);

  return { begin, settle };
}

export function useWatchedTransition(): ReturnType<typeof useTransition> {
  const [isPending, startTransition] = useTransition();
  const { begin, settle } = useStallTracker();

  const watched = useCallback(
    (cb: () => unknown) => {
      const id = begin();
      const done = (): void => settle(id);
      // React's overloads split sync from async at the type level; whether `cb` is
      // async is only known once it has run, and React itself checks for a thenable
      // at runtime, so one runner serves both.
      const run = (): Promise<void> | undefined => {
        let result: unknown;
        try {
          result = cb();
        } catch (e) {
          done();
          throw e;
        }
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return (result as Promise<void>).finally(done);
        }
        done();
        return undefined;
      };
      startTransition(run as () => Promise<void>);
    },
    [startTransition, begin, settle],
  );

  // Same call shape as `startTransition` (sync or async callback); the cast only
  // reconciles React's two overload signatures with our single runtime check.
  return [isPending, watched as unknown as Start];
}

/**
 * ADR-0140 Amendment 1 — the same watchdog for a screen whose busy state is a
 * plain `useState` flag around an async `fetch` handler rather than a
 * transition (count, void, inbound, processed, queue conflicts). Wrap the
 * handler: `onClick={() => void watch(submit)}`.
 *
 * Every request in those handlers already fails on a 20 s deadline, so this
 * banner is for what a deadline cannot reach — an IndexedDB `enqueue` that never
 * resolves on iOS Safari, a `router.refresh()` that never lands. Deliberately
 * NOT used on the photo flows (drop-off, load photo): a legitimate R2 PUT may
 * take up to 90 s, and a Reload offered mid-upload would discard a photo that
 * exists only in memory until it is queued.
 */
export function useStallWatch(): <T>(work: () => Promise<T>) => Promise<T> {
  const { begin, settle } = useStallTracker();
  return useCallback(
    <T>(work: () => Promise<T>): Promise<T> => {
      const id = begin();
      let p: Promise<T>;
      try {
        p = work();
      } catch (e) {
        settle(id);
        throw e;
      }
      return p.finally(() => settle(id));
    },
    [begin, settle],
  );
}
