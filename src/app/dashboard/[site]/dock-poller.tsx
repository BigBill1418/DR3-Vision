'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

// 5-second auto-refresh wrapper for the manager-portal dock view per
// SPRINT-1-PLAN T-010 ("5-second polling"). Mirrors the operator
// `queue-client.tsx` pattern minus the pull-to-refresh — the manager
// is on a desktop, not an iPad, so a touch gesture isn't load-bearing
// here.
//
// Refreshing pill at the top tells the operator the page is alive
// while a refresh is in flight. The refresh is paused while one is
// already pending so that a slow server payload can't stack ticks.

const POLL_INTERVAL_MS = 5_000;

type Props = { children: React.ReactNode };

export function DockPoller({ children }: Props) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (refreshing) return;
      setRefreshing(true);
      router.refresh();
      // 600ms is the same readability budget the operator queue uses;
      // long enough to be visible, short enough that the pill doesn't
      // linger after the new payload lands.
      window.setTimeout(() => setRefreshing(false), 600);
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [router, refreshing]);

  return (
    <div className="relative">
      <div
        className="pointer-events-none flex items-center justify-end pb-2"
        aria-live="polite"
      >
        <span
          className={
            'rounded-full bg-dr3-green px-2.5 py-0.5 text-[11px] font-semibold text-dr3-ink shadow transition-opacity ' +
            (refreshing ? 'opacity-100' : 'opacity-60')
          }
        >
          {refreshing ? 'Live · refreshing…' : 'Live · 5s'}
        </span>
      </div>
      {children}
    </div>
  );
}
