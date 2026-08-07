'use client';

import { useCallback, useEffect, useState } from 'react';
import { queueCounts, replayAll } from '@/lib/offline-queue';

// ADR-0078 D9 — one source of truth for "can this iPad reach the server right
// now, and is anything waiting?"
//
// JT's ask was that a dropped connection be VISIBLE. Before this, `navigator.
// onLine` was consulted only inside `offline-queue.ts`, to make decisions the
// operator never saw. Two screens then grew their own near-identical sweep
// loops — `load-workflow.tsx` (mount + `online` + 30s sweep + 5s refresh) and
// `pending-banner.tsx` (mount + `online` + 5s refresh, no sweep) — which is how
// you end up with a queue that drains on one screen and sits still on another.
// Both are folded in here.
//
// ## Why `navigator.onLine` is not enough on its own
//
// On iPadOS `navigator.onLine` reports whether the device has a network
// interface, not whether it can reach anything. An iPad associated with a
// warehouse AP that has lost its uplink reports `true` — which is exactly the
// failure JT described, and the one a naive indicator would paint green through.
// So each sweep tick also pings the app's own `/healthz`; a failed ping demotes
// `online` to `offline-queuing` even while the OS insists it is connected.
//
// The ping is deliberately cheap and deliberately OUR endpoint: pinging a
// third-party host would report on the internet rather than on the thing the
// operator's work has to reach.

export type ConnectionStatus =
  /** Reachable, nothing waiting. */
  | 'online'
  /** Unreachable (OS-reported or proven by a failed ping). Writes are queueing. */
  | 'offline-queuing'
  /** Reachable, and a replay sweep is in flight. */
  | 'syncing'
  /**
   * The app is reachable but object storage is NOT, so photo uploads cannot
   * complete. A distinct state because it is a distinct problem with a distinct
   * fix: no amount of the operator moving closer to an access point resolves a
   * bucket that refuses the browser's preflight. Painting this as "offline" is
   * what let 97 uploads pile up on one iPad, unremarked, for weeks.
   */
  | 'uploads-blocked';

export interface ConnectionState {
  status: ConnectionStatus;
  /**
   * Rows still TRYING. Excludes conflicts on purpose — see `activeCount`. A
   * count that folds in permanently parked rows reads as a stalled queue and
   * teaches operators to ignore the badge.
   */
  pending: number;
  /** Rows that need a person, not another retry. */
  conflicts: number;
  /** Rows stuck because object storage is unreachable. */
  blocked: number;
  /** Last sweep that reached the server, or null if none has this session. */
  lastSyncAt: number | null;
  /** Operator-driven retry. Same sweep the timer runs. */
  sync: () => void;
}

const SWEEP_MS = 30_000;
const REFRESH_MS = 5_000;
const PING_TIMEOUT_MS = 4_000;

/**
 * Can we actually reach the app? Resolves false on network error, on a non-2xx,
 * and on timeout — a request that hangs is indistinguishable from one that will
 * never arrive, and treating "still waiting" as "online" is the optimistic lie
 * this whole hook exists to stop telling.
 */
async function reachable(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch('/healthz', { method: 'GET', cache: 'no-store', signal: ctl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export function useConnectionState(): ConnectionState {
  const [status, setStatus] = useState<ConnectionStatus>('online');
  const [pending, setPending] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [blocked, setBlocked] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      // ONE index-only pass for all three numbers. Three separate helpers, each
      // scanning the store, meant three full deserialisations of every queued
      // photo Blob every few seconds — see `queueCounts`.
      const c = await queueCounts();
      setPending(c.active);
      setConflicts(c.conflicts);
      setBlocked(c.blocked);
    } catch {
      // SSR / IndexedDB unavailable — the queue is a progressive-enhancement
      // layer, so its absence must not break the chrome it renders inside.
    }
  }, []);

  const sweep = useCallback(async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('offline-queuing');
      await refresh();
      return;
    }
    if (!(await reachable())) {
      // The OS says we have a network; the server says otherwise. Believe the
      // server — this is the AP-with-a-dead-uplink case.
      setStatus('offline-queuing');
      await refresh();
      return;
    }
    setStatus('syncing');
    // The resting status is decided in ONE place and applied once, in `finally`.
    // An early `return` from inside the `try` still runs `finally`, so a branch
    // that set its own status and returned would have that status immediately
    // overwritten — which is exactly how an indicator ends up reporting green
    // while the thing it indicates is broken.
    let resting: ConnectionStatus = 'online';
    try {
      const r = await replayAll();
      setLastSyncAt(Date.now());
      // The sweep REACHED the server — `lastSyncAt` is genuinely fresh — and
      // still could not deliver photos. Report the specific failure rather than
      // a green light that is technically true and practically useless.
      if (r.blocked > 0) resting = 'uploads-blocked';
    } catch {
      // Per-row failures are persisted on each row's `last_error`; a throw here
      // is the sweep itself failing, which the next tick retries.
    } finally {
      await refresh();
      setStatus(resting);
    }
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void sweep();
    };
    run();
    const onOnline = () => run();
    const onOffline = () => {
      if (!cancelled) setStatus('offline-queuing');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const sweepTick = window.setInterval(run, SWEEP_MS);
    const refreshTick = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(sweepTick);
      window.clearInterval(refreshTick);
    };
  }, [sweep, refresh]);

  return { status, pending, conflicts, blocked, lastSyncAt, sync: () => void sweep() };
}
