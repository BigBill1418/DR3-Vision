'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useTransition } from 'react';

// SPRINT-1-PLAN T-012 — segmented period picker for the compliance grid.
//
// Same shape as T-011's range row in `loads-filters.tsx` so the visual
// language stays consistent across the two surfaces a manager bounces
// between when a tile click-through lands them on the load list. URL is
// the source of truth (no <form> per CLAUDE.md hard rule #10); the
// custom-range inputs only render when the active range is `custom`.
//
// Default range on the compliance dashboard is `month` (vs T-011's
// `today`) — compliance metrics are inherently period-aggregations and
// most thresholds are stated per-month / per-rolling-window.

const RANGE_LABELS: Record<string, string> = {
  today: 'Today',
  week: 'This week',
  month: 'This month',
  custom: 'Custom',
};

type Range = 'today' | 'week' | 'month' | 'custom';

type Props = {
  range: Range;
  from: string;
  to: string;
};

export function PeriodPicker({ range, from, to }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const update = (mutate: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params.toString());
    mutate(next);
    const qs = next.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  };

  const setRange = (next: string) => {
    update((p) => {
      // `month` is the dashboard default; clear the param so the URL
      // collapses to the canonical short form.
      if (next === 'month') {
        p.delete('range');
      } else {
        p.set('range', next);
      }
      if (next !== 'custom') {
        p.delete('from');
        p.delete('to');
      }
    });
  };

  const setBound = (which: 'from' | 'to', value: string) => {
    update((p) => {
      if (value) p.set(which, value);
      else p.delete(which);
    });
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-lg bg-dr3-green-dark/30 p-4"
      aria-busy={isPending}
    >
      <div className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wide text-dr3-cream/60">Period</span>
        <div className="flex flex-wrap gap-2">
          {Object.entries(RANGE_LABELS).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setRange(value)}
              disabled={isPending}
              aria-pressed={range === value}
              className={
                range === value
                  ? 'rounded-md bg-dr3-green px-3 py-1.5 text-sm font-semibold text-dr3-ink disabled:opacity-60'
                  : 'rounded-md bg-dr3-green-dark/60 px-3 py-1.5 text-sm font-medium text-dr3-cream hover:bg-dr3-green-dark/80 disabled:opacity-60'
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {range === 'custom' && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-dr3-cream/70">
            From
            <input
              type="date"
              value={from}
              disabled={isPending}
              onChange={(e) => setBound('from', e.target.value)}
              className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-sm text-dr3-cream"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dr3-cream/70">
            To
            <input
              type="date"
              value={to}
              disabled={isPending}
              onChange={(e) => setBound('to', e.target.value)}
              className="rounded-md bg-dr3-green-dark/60 px-2 py-1 text-sm text-dr3-cream"
            />
          </label>
        </div>
      )}
    </div>
  );
}
