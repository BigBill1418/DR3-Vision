'use client';

import { useCallback, useEffect, useState } from 'react';
import { queueCounts } from '@/lib/offline-queue';
import { drainNow, subscribeToDrain } from '@/lib/drain-engine';

// ADR-0078 D9 — one source of truth for "can this iPad reach the server right
// now, and is anything waiting?"
//
// JT's ask was that a dropped connection be VISIBLE. Before this, `navigator.
// onLine` was consulted only inside `offline-queue.ts`, to make decisions the
// operator never saw. Two screens then grew their own near-identical sweep
// loops — `load-workflow.tsx` (mount + `online` + 30s sweep + 5s refresh) and
// `pending-banner.tsx` (mount + `online` + 5s refresh, no sweep) — which is how
// you end up with a queue that drains on one screen and sits still on another.
//
// ## This hook OBSERVES. It does not drain. (ADR-0078 G8)
//
// The drain schedule belongs to `drain-engine.ts`, mounted once above all nine
// operator screens. This hook used to own a second sweep loop, and with the
// engine now always running that would mean two owners: two `replayAll`
// schedules, and — worse — two independent count refreshes, which are not
// deduped. On the device holding 99 unsent photos that is a real cost paid to
// render a number twice. So the engine drains and publishes; this reports.
//
// `replayAll` therefore has exactly ONE caller in app code (`drainNow`), and
// `drain-engine.test.ts` greps the source to keep it that way.
//
// ## Why `navigator.onLine` is not enough on its own
//
// On iPadOS `navigator.onLine` reports whether the device has a network
// interface, not whether it can reach anything. An iPad associated with a
// warehouse AP that has lost its uplink reports `true` — which is exactly the
// failure JT described, and the one a naive indicator would paint green through.
// So an operator-driven sync pings the app's own `/healthz` first; a failed ping
// demotes `online` to `offline-queuing` even while the OS insists otherwise.
//
// The ping is deliberately cheap and deliberately OUR endpoint: pinging a
// third-party host would report on the internet rather than on the thing the
// operator's work has to reach. `/healthz` is pinned to `NetworkOnly` in the
// service worker for the same reason — see `sw.ts`.

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
  | 'uploads-blocked'
  /**
   * The operator's session ended and queued items are waiting on a sign-in.
   *
   * The most RECOVERABLE state in this list — somebody types a PIN and it all
   * drains — and previously the most invisible. Operator sessions idle out after
   * five minutes, so this is a routine end-of-shift condition rather than an
   * incident, and it gets its own status because the required action is unlike
   * every other state's: not "wait", not "decide", just "sign in".
   */
  | 'session-expired';

export interface ConnectionState {
  status: ConnectionStatus;
  /**
   * Rows still TRYING. Excludes conflicts on purpose — a count that folds in
   * permanently parked rows reads as a stalled queue and teaches operators to
   * ignore the badge.
   */
  pending: number;
  /** Rows that need a person, not another retry. */
  conflicts: number;
  /** Rows stuck because object storage is unreachable. */
  blocked: number;
  /** Rows waiting on a sign-in. */
  auth: number;
  /** Last sweep that reached the server, or null if none has this session. */
  lastSyncAt: number | null;
  /** Operator-driven retry. Asks the engine for a sweep; never runs its own. */
  sync: () => void;
}

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
  const [auth, setAuth] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      // ONE index-only pass for all four numbers. Separate helpers, each
      // scanning the store, meant repeated full deserialisation of every queued
      // photo Blob every few seconds — see `queueCounts`.
      const c = await queueCounts();
      setPending(c.active);
      setConflicts(c.conflicts);
      setBlocked(c.blocked);
      setAuth(c.auth);
    } catch {
      // SSR / IndexedDB unavailable — the queue is a progressive-enhancement
      // layer, so its absence must not break the chrome it renders inside.
    }
  }, []);

  /** Operator tapped the badge. Confirm reachability, then ask the engine. */
  const sync = useCallback(async () => {
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
    await drainNow('manual');
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;

    // Every drain outcome, whoever triggered it, decides the resting status.
    // The ordering is a PRIORITY LIST, not a sequence: session-expired outranks
    // storage-blocked because signing in is one action that resolves
    // everything, and telling an operator "photos can't upload" when their
    // shift session simply timed out sends them to the wrong person.
    const unsubscribe = subscribeToDrain((result) => {
      if (cancelled) return;
      void (async () => {
        if (result) {
          if (result.reached === false) {
            // Attempted and nothing got through — either the OS said offline or
            // every request died at the network layer (the AP-with-a-dead-uplink
            // case). NOT a sync, so `lastSyncAt` is deliberately left alone: a
            // fresh "last sent" stamp for a sweep that never left the device is
            // the precise lie this whole indicator exists to stop telling.
            setStatus('offline-queuing');
          } else if (result.reached === true) {
            setLastSyncAt(Date.now());
            setStatus(
              result.auth > 0
                ? 'session-expired'
                : result.blocked > 0
                  ? 'uploads-blocked'
                  : 'online',
            );
          } else {
            // `null` — the queue was empty, so the sweep proves nothing. Ask
            // `/healthz` directly rather than inferring health from silence.
            // This is also what keeps the dead-uplink probe on a SCHEDULE now
            // that the hook no longer runs its own sweep loop.
            setStatus((await reachable()) ? 'online' : 'offline-queuing');
          }
        }
        await refresh();
      })();
    });

    const onOffline = () => {
      if (!cancelled) setStatus('offline-queuing');
    };
    window.addEventListener('offline', onOffline);

    // Counts only. The DRAIN schedule belongs to the engine; duplicating it
    // here is exactly what ADR-0078 G8 removed.
    const refreshTick = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, REFRESH_MS);
    void refresh();

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('offline', onOffline);
      window.clearInterval(refreshTick);
    };
  }, [refresh]);

  return { status, pending, conflicts, blocked, auth, lastSyncAt, sync: () => void sync() };
}
