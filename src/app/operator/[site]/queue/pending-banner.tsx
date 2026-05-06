'use client';

import { useEffect, useState } from 'react';
import { pendingCount, replayAll } from '@/lib/offline-queue';

// T-009 — surface pending offline-queue items on next login. Per
// SPRINT-1-PLAN: "Replay on connectivity recovery; surface unresolved
// queue items on next login." This banner appears at the top of the
// queue page if `listPending()` returns rows from a prior shift.
//
// Tap → fires `replayAll()` immediately. We also kick a sweep on mount
// so the operator sees the count drop in real time as items resolve
// without needing to tap.

export function PendingBanner() {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const n = await pendingCount();
        if (!cancelled) setCount(n);
      } catch {
        // SSR / IndexedDB unavailable — render nothing.
      }
    };
    const sweep = async () => {
      setBusy(true);
      try {
        await replayAll();
      } catch {
        // failures persisted on each row's last_error
      } finally {
        await refresh();
        setBusy(false);
      }
    };
    void sweep();
    const onOnline = () => void sweep();
    window.addEventListener('online', onOnline);
    const refreshTick = window.setInterval(() => void refresh(), 5_000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', onOnline);
      window.clearInterval(refreshTick);
    };
  }, []);

  if (!count) return null;

  const onTap = () => {
    setBusy(true);
    void replayAll()
      .then(() => pendingCount())
      .then(setCount)
      .finally(() => setBusy(false));
  };

  return (
    <button
      type="button"
      onClick={onTap}
      disabled={busy}
      className="w-full rounded-lg bg-dr3-chartreuse/20 px-4 py-3 text-left text-sm font-medium text-dr3-chartreuse hover:bg-dr3-chartreuse/30 disabled:opacity-60"
    >
      ⏳ {count} item{count === 1 ? '' : 's'} pending upload from a previous shift —{' '}
      {busy ? 'syncing now…' : 'tap to replay'}
    </button>
  );
}
