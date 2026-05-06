'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

// Wraps the queue list with two refresh paths:
//   1. Auto-refresh every 60s — meets SPRINT-1-PLAN T-005 cadence
//      contract. `router.refresh()` re-runs the server component
//      without a hard navigation.
//   2. Pull-to-refresh — touch gesture from scroll-top, threshold
//      ~80px. Works in iPad Safari standalone PWA where the
//      browser-native pull-to-refresh is not installed.
//
// Both paths show a small "Refreshing…" pill at the top during the
// in-flight transition so the operator knows the screen is alive.

const AUTO_REFRESH_MS = 60_000;
const PULL_THRESHOLD_PX = 80;

type Props = {
  children: React.ReactNode;
  lastSyncAt: string | null; // ISO; surfaced through here so the wrapper can re-format on refresh
};

export function QueueClient({ children }: Props) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const startYRef = useRef<number | null>(null);

  // Auto-refresh tick. The interval is paused while a refresh is
  // already in flight to avoid stacking router.refresh() calls.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (refreshing) return;
      setRefreshing(true);
      router.refresh();
      // router.refresh resolves quickly on the client; the actual
      // re-render lands when the server payload returns. 600ms gives
      // the pill enough time to be readable without lingering.
      window.setTimeout(() => setRefreshing(false), 600);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [router, refreshing]);

  // Pull-to-refresh. Only engages from scroll-top so a normal
  // mid-list swipe still scrolls.
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY > 0) return;
      startYRef.current = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current == null) return;
      const y = e.touches[0]?.clientY ?? startYRef.current;
      const dy = y - startYRef.current;
      if (dy <= 0) {
        setPullDistance(0);
        return;
      }
      // Linear → resistant past the threshold so the indicator
      // doesn't fly off the screen if the user keeps pulling.
      const resistant =
        dy < PULL_THRESHOLD_PX ? dy : PULL_THRESHOLD_PX + (dy - PULL_THRESHOLD_PX) * 0.3;
      setPullDistance(resistant);
    };
    const onTouchEnd = () => {
      if (startYRef.current == null) return;
      const dist = pullDistance;
      startYRef.current = null;
      setPullDistance(0);
      if (dist >= PULL_THRESHOLD_PX && !refreshing) {
        setRefreshing(true);
        router.refresh();
        window.setTimeout(() => setRefreshing(false), 600);
      }
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [router, refreshing, pullDistance]);

  return (
    <div className="relative">
      {(refreshing || pullDistance > 0) && (
        <div
          className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 -translate-y-full transform pt-2"
          style={{ transform: `translate(-50%, ${Math.max(0, pullDistance) - 40}px)` }}
        >
          <span className="rounded-full bg-dr3-green px-3 py-1 text-xs font-semibold text-dr3-ink shadow">
            {refreshing
              ? 'Refreshing…'
              : pullDistance >= PULL_THRESHOLD_PX
                ? 'Release to refresh'
                : 'Pull down'}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}
