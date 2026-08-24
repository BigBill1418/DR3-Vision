'use client';

// ADR-0125 — the day selector. CLAUDE.md hard rule #10: onClick/onChange only.
//
// The day travels in the URL (`?day=`), not in component state, so the server
// page and every gap-fill write are talking about the same day and a refresh or
// a shared link lands on the same screen.

import Link from 'next/link';
import { useRouter } from 'next/navigation';

/** Shift a `YYYY-MM-DD` by whole days without touching a timezone. */
function shift(dayISO: string, days: number): string {
  const [y, m, d] = dayISO.split('-').map(Number);
  const t = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

const linkCls =
  'inline-flex min-h-[44px] items-center rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-sm text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40';

export function EodDayNav({
  siteCode,
  dayKey,
  todayKey,
}: {
  siteCode: string;
  dayKey: string;
  todayKey: string;
}) {
  const router = useRouter();
  const base = `/dashboard/${siteCode}/eod`;
  const next = shift(dayKey, 1);
  // A future day cannot be reviewed or closed, so it is not offered. The server
  // still refuses it — the UI is not the boundary.
  const canGoForward = next <= todayKey;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`${base}?day=${shift(dayKey, -1)}`} className={linkCls}>
        ← Previous day
      </Link>
      <input
        type="date"
        aria-label="Review day"
        max={todayKey}
        className="rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white"
        value={dayKey}
        onChange={(e) => {
          if (e.target.value) router.push(`${base}?day=${e.target.value}`);
        }}
      />
      {canGoForward ? (
        <Link href={`${base}?day=${next}`} className={linkCls}>
          Next day →
        </Link>
      ) : (
        <span className={`${linkCls} cursor-default opacity-40`}>Next day →</span>
      )}
      {dayKey !== todayKey && (
        <Link href={base} className={linkCls}>
          Today
        </Link>
      )}
    </div>
  );
}
