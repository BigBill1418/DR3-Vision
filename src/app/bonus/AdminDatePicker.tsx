'use client';

// Admin-only business-day selector for the daily bonus entry surface
// (TZ-fix + admin backfill, 2026-06-06).
//
// Gated to admin (Bill) at the SERVER (the parent page only renders this for
// `ctx.isAdmin`, and the write API re-checks admin for any non-today date —
// the client is never trusted). Non-admin users never see a picker; their
// entry is always Pacific "today".
//
// The picker operates in Pacific calendar days: the native <input type="date">
// emits a `YYYY-MM-DD` string, which the page reads via ?date= and resolves to
// the matching @db.Date business day regardless of the server's UTC clock.
// No component library (CLAUDE.md hard rule #7) — plain HTML + Tailwind tokens,
// `onChange` navigation (no <form> submit ceremony).

import { useRouter } from 'next/navigation';

interface Props {
  /** Currently-selected business day, `YYYY-MM-DD`. */
  selected: string;
  /** Pacific "today", `YYYY-MM-DD` — the max selectable day and the reset target. */
  today: string;
}

export function AdminDatePicker({ selected, today }: Props) {
  const router = useRouter();

  const go = (iso: string) => {
    // Reset to the canonical (no-query) URL when picking today, so the page
    // behaves identically to the default load.
    router.push(iso === today ? '/bonus' : `/bonus?date=${iso}`);
  };

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-dr3-chartreuse/30 bg-dr3-green-dark/30 px-4 py-3"
      data-testid="admin-date-picker"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-dr3-chartreuse">
        Admin: enter for date
      </span>
      <input
        type="date"
        value={selected}
        max={today}
        onChange={(e) => {
          if (e.target.value) go(e.target.value);
        }}
        className="rounded-md border border-dr3-cream/20 bg-dr3-green-dark/60 px-3 py-1.5 text-sm text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
        aria-label="Business day to enter bonus data for"
        data-testid="admin-date-input"
      />
      {selected !== today ? (
        <button
          type="button"
          onClick={() => go(today)}
          className="text-xs text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
          data-testid="admin-date-reset"
        >
          Back to today
        </button>
      ) : null}
    </div>
  );
}
