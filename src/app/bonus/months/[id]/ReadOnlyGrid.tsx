// ADR-0019 §8 — Read-only daily grid for a past bonus month (T-117).
//
// Presentational server component (no client JS, no mutation): renders the
// frozen per-day mattress counts for a signed/paid/amended month so a manager
// (Janette) browsing history can see exactly what was keyed, day-by-day, with
// NO editable inputs. The detail page (T-110/T-111/T-116) owns data fetching and
// the editable/amendment surfaces; this component only displays already-fetched,
// pre-assembled rows. All money is integer cents formatted through the shared
// calculator so the figures match the signed PDF (CLAUDE.md hard rule #3).

import { formatCents } from '@/lib/bonus/calculator';

export interface ReadOnlyGridDay {
  /** UTC YYYY-MM-DD key (matches the @db.Date entry_date). */
  iso: string;
  /** Short column header, e.g. "Mon 1". */
  label: string;
}

export interface ReadOnlyGridRow {
  bonusEmployeeId: string;
  name: string;
  /** Mattress count per day iso → count (absent = no entry that day). */
  countsByDay: Record<string, number>;
  totalMattresses: number;
  totalBonusCents: number;
}

export interface ReadOnlyGridProps {
  days: ReadOnlyGridDay[];
  rows: ReadOnlyGridRow[];
  grandTotalCents: number;
}

/**
 * Locked day-by-day grid. Renders nothing actionable: a plain table with each
 * processor's per-day counts and their month totals. A small "Locked" affordance
 * makes the read-only nature explicit to the operator.
 */
export function ReadOnlyGrid({ days, rows, grandTotalCents }: ReadOnlyGridProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-dr3-cream/70">No mattress counts were keyed this month.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs uppercase tracking-wide text-dr3-cream/60">Locked · read-only</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm" data-testid="readonly-daily-grid">
          <thead>
            <tr className="border-b border-dr3-cream/20 text-left text-dr3-cream/70">
              <th className="sticky left-0 bg-dr3-green-dark/40 pb-2 pr-3 font-medium">
                Processor
              </th>
              {days.map((d) => (
                <th key={d.iso} className="px-2 pb-2 text-right font-medium tabular-nums">
                  {d.label}
                </th>
              ))}
              <th className="pb-2 pl-3 text-right font-medium">Mattresses</th>
              <th className="pb-2 pl-3 text-right font-medium">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bonusEmployeeId} className="border-b border-dr3-cream/10">
                <td className="sticky left-0 bg-dr3-green-dark/40 py-2 pr-3 font-medium">
                  {r.name}
                </td>
                {days.map((d) => {
                  const c = r.countsByDay[d.iso];
                  return (
                    <td key={d.iso} className="px-2 py-2 text-right tabular-nums">
                      {c === undefined ? <span className="text-dr3-cream/30">·</span> : c}
                    </td>
                  );
                })}
                <td className="py-2 pl-3 text-right tabular-nums">{r.totalMattresses}</td>
                <td className="py-2 pl-3 text-right tabular-nums">
                  {formatCents(r.totalBonusCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-semibold">
              <td className="sticky left-0 bg-dr3-green-dark/40 pr-3 pt-3">Total payout</td>
              {days.map((d) => (
                <td key={d.iso} className="pt-3" />
              ))}
              <td className="pt-3" />
              <td className="pl-3 pt-3 text-right tabular-nums">{formatCents(grandTotalCents)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
