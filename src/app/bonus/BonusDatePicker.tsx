'use client';

// ADR-0028 — Bonus date picker.
//
// Visible to all managers AND admins on the /bonus surface. Managers are
// constrained to the current draft period's date window (period_start..today).
// Admins remain unconstrained (any historical date, including closed periods).
// Both the client min/max AND the server-side resolveEntryDate enforce the
// constraint (CLAUDE.md hard rule #6 — defense in depth).

import { useRouter } from 'next/navigation';

interface Props {
  selected: string;
  today: string;
  constrained: boolean;
  periodStart: string;
}

export function BonusDatePicker({ selected, today, constrained, periodStart }: Props) {
  const router = useRouter();

  const go = (iso: string) => {
    router.push(iso === today ? '/bonus' : `/bonus?date=${iso}`);
  };

  const label = constrained ? 'Enter for date (this pay period)' : 'Admin: enter for date';
  const hint = constrained
    ? '(today or earlier — within the current open pay period)'
    : '(today or earlier — counts can’t be entered for a future day)';

  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-dr3-cyan/30 bg-dr3-space-2/60 px-4 py-3"
      data-testid="bonus-date-picker"
    >
      <span className="text-xs font-semibold uppercase tracking-wide text-dr3-cyan">{label}</span>
      <span className="text-xs text-dr3-mist-dim">{hint}</span>
      <input
        type="date"
        value={selected}
        min={constrained ? periodStart : undefined}
        max={today}
        onChange={(e) => {
          if (e.target.value) go(e.target.value);
        }}
        className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-1.5 text-sm text-dr3-mist [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
        aria-label="Business day to enter bonus data for"
        data-testid="bonus-date-input"
      />
      {selected !== today ? (
        <button
          type="button"
          onClick={() => go(today)}
          className="text-xs text-dr3-mist-dim underline-offset-4 hover:text-dr3-mist hover:underline"
          data-testid="bonus-date-reset"
        >
          Back to today
        </button>
      ) : null}
    </div>
  );
}
