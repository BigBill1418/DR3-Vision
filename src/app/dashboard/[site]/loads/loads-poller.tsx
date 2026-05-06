'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

// 30-second auto-refresh per SPRINT-1-PLAN T-011 cadence contract.
// Same shape as the operator queue's 60s poller: setInterval +
// router.refresh() re-runs the server component without a hard
// navigation, with a brief in-flight indicator so the manager knows
// the screen is alive.
//
// Pull-to-refresh is intentionally NOT included — managers run this
// surface on a desktop, not a touch device.

const AUTO_REFRESH_MS = 30_000;

export function LoadsPoller() {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (refreshing) return;
      setRefreshing(true);
      router.refresh();
      window.setTimeout(() => setRefreshing(false), 600);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [router, refreshing]);

  return (
    <div className="flex items-center gap-2 text-xs text-dr3-cream/60" aria-live="polite">
      <span
        className={
          refreshing
            ? 'inline-block h-2 w-2 animate-pulse rounded-full bg-dr3-chartreuse'
            : 'inline-block h-2 w-2 rounded-full bg-dr3-green'
        }
        aria-hidden="true"
      />
      {refreshing ? 'Refreshing…' : 'Auto-refreshing every 30s'}
    </div>
  );
}
