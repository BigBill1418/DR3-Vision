'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

// Operations Dashboard auto-refresh (ADR-0020 re-enable). A slower sibling of
// `DockPoller`: the overview aggregates heavier analytics (compliance slate,
// commodity aging, MyMRC mirror counts), so a 5s full-route refresh would hammer
// the DB for no operator benefit. 30s keeps the "on the dock" / "arrived today"
// counts fresh within half a minute while keeping load sane for a wall-mounted
// iPad. `router.refresh()` re-renders every server component on the route, so the
// whole surface — overview and live dock grid — updates on each tick.
//
// A single in-flight guard prevents a slow payload from stacking ticks.

const POLL_INTERVAL_MS = 30_000;

export function OverviewPoller({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (refreshing) return;
      setRefreshing(true);
      router.refresh();
      window.setTimeout(() => setRefreshing(false), 700);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [router, refreshing]);

  return (
    <div className="relative flex flex-col gap-8">
      <div className="pointer-events-none flex items-center justify-end" aria-live="polite">
        <span
          className={
            'rounded-full bg-dr3-cyan px-3 py-1 text-xs font-semibold text-dr3-space shadow transition-opacity ' +
            (refreshing ? 'opacity-100' : 'opacity-70')
          }
        >
          {refreshing ? 'Live · refreshing…' : 'Live · 30s'}
        </span>
      </div>
      {children}
    </div>
  );
}
