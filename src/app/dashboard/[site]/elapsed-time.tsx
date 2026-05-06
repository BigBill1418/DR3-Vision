'use client';

import { useEffect, useState } from 'react';

// Live elapsed-time counter for the dock-view tile per
// SPRINT-1-PLAN T-010 ("times tick forward in real-time"). Pure
// presentational: the parent server component supplies an ISO
// timestamp; this child re-renders once per second to keep the visible
// counter in sync without paying the price of a full server refresh.
//
// Not coupled to the 5-second polling — the polling refreshes the load
// row data (operator changed, stage advanced, BOL updated). The
// per-second tick is just the clock running on the manager's screen.

type Props = { since: string };

function format(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}

export function ElapsedTime({ since }: Props) {
  const startMs = new Date(since).getTime();
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    // 1s tick. setInterval is fine for a screen-visible counter; we're
    // not trying to measure walltime accurately, just give the manager
    // a live readout. If the tab is backgrounded the browser throttles
    // this anyway — `Date.now()` on the next foreground tick catches up.
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return <span className="font-mono tabular-nums">{format(now - startMs)}</span>;
}
