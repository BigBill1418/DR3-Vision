'use client';

// ADR-0019 §4/§7 — Bonus daily mattress-count grid (T-105, client component).
//
// CLAUDE.md hard rule #10 — no `<form>` element, no submit handler; the Save
// button posts via `onClick`. No component library (hard rule #7) — plain HTML +
// Tailwind brand tokens.
//
// Each row = employee name, a count input (0..999 with at most ONE decimal
// place — T-330; soft-warn when the INTEGER FLOOR exceeds 200), and an optional
// note. The per-row bonus and the page grand total tick live as the operator
// types, computed through `@/lib/bonus/calculator` with the Woodland rule passed
// down from the server (NEVER hardcoded — hard rule #3). The calculator floors,
// so a fractional entry's preview equals its integer-floor result. The note
// field never feeds the math.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  calculateDailyBonusCents,
  formatCents,
  type BonusRuleParams,
} from '@/lib/bonus/calculator';

export interface GridRowProps {
  bonus_employee_id: string;
  full_name: string;
  mattress_count: number | null;
  note: string | null;
}

interface Props {
  /** Woodland processor-bonus rule params for live calculation (from the server). */
  rule: BonusRuleParams;
  /** ISO calendar day (YYYY-MM-DD) this grid edits. */
  entryDate: string;
  /** Whether the month is still editable (draft). When false the grid is read-only. */
  editable: boolean;
  /** Current month lifecycle state (for the read-only banner copy). */
  monthState: string;
  rows: GridRowProps[];
}

const SOFT_WARN_THRESHOLD = 200;

// T-330: accept 0–9999 with an optional single decimal place. The numeric range
// (0..999) and one-decimal rule are re-enforced by parsedCount and, server-side,
// by isValidMattressCount — this pattern is the input-shape gate only. Negatives
// have no `-`, so they are excluded by construction.
const COUNT_PATTERN = /^\d{1,4}(\.\d)?$/;

interface RowState {
  count: string; // raw input string ('' = not entered)
  note: string;
}

export function DailyEntryGrid({ rule, entryDate, editable, monthState, rows }: Props) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {};
    for (const r of rows) {
      init[r.bonus_employee_id] = {
        count: r.mattress_count != null ? String(r.mattress_count) : '',
        note: r.note ?? '',
      };
    }
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const parsedCount = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    // Shape gate: digits with an optional single decimal place; no sign, so
    // negatives are rejected here. Then enforce the 0..999 numeric range.
    if (!COUNT_PATTERN.test(trimmed)) return null;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0 || n > 999) return null;
    return n;
  };

  const totalCents = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const n = parsedCount(state[r.bonus_employee_id]?.count ?? '');
      if (n != null) sum += calculateDailyBonusCents(n, rule);
    }
    return sum;
  }, [state, rows, rule]);

  const setRow = (id: string, patch: Partial<RowState>) => {
    setSaved(false);
    setState((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
  };

  const handleSave = async () => {
    setError(null);
    setSaved(false);

    const entries: Array<{
      bonus_employee_id: string;
      mattress_count: number;
      note: string | null;
    }> = [];
    for (const r of rows) {
      const rs = state[r.bonus_employee_id]!;
      const n = parsedCount(rs.count);
      // Only submit rows that actually have a count; a blank input is "not keyed".
      if (rs.count.trim() === '') continue;
      if (n == null) {
        setError(
          `"${r.full_name}" has an invalid count — enter 0 to 999 with at most one decimal place.`,
        );
        return;
      }
      entries.push({
        bonus_employee_id: r.bonus_employee_id,
        mattress_count: n,
        note: rs.note.trim() || null,
      });
    }

    if (entries.length === 0) {
      setError('Enter at least one mattress count before saving.');
      return;
    }

    setSaving(true);
    try {
      const res = await fetch('/api/bonus/entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_date: entryDate, entries }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save entries. Please try again.');
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-4" data-testid="daily-entry-grid">
      {!editable ? (
        <p
          className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2/60 px-4 py-3 text-sm text-dr3-mist"
          role="status"
          data-testid="grid-locked-banner"
        >
          This month is {monthState.replace(/_/g, ' ')}. Daily entries are locked and shown
          read-only.
        </p>
      ) : null}

      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="grid-error"
        >
          {error}
        </p>
      ) : null}

      {saved ? (
        <p
          className="rounded-md border border-emerald-400/30 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200"
          role="status"
          data-testid="grid-saved"
        >
          Entries saved.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-dr3-steel-light/25">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-dr3-space-2/80 text-xs uppercase tracking-wider text-dr3-cyan">
              <th className="px-4 py-3 font-semibold">Processor</th>
              <th className="px-4 py-3 font-semibold">Mattresses</th>
              <th className="px-4 py-3 font-semibold">Note (optional)</th>
              <th className="px-4 py-3 text-right font-semibold">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-dr3-mist-dim">
                  No active processors. Add employees on the Bonus Employees page first.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const rs = state[r.bonus_employee_id]!;
                const n = parsedCount(rs.count);
                // Soft-warn on the integer FLOOR (T-330): 200.5 floors to 200
                // (no warn); 201 / 230.5 warn. The calculator floors too, so the
                // warn tracks the value that actually drives the bonus.
                const overWarn = n != null && Math.floor(n) > SOFT_WARN_THRESHOLD;
                const bonus = n != null ? calculateDailyBonusCents(n, rule) : 0;
                return (
                  <tr
                    key={r.bonus_employee_id}
                    className="border-t border-dr3-steel-light/20 odd:bg-dr3-space-2/40"
                    data-testid={`grid-row-${r.bonus_employee_id}`}
                  >
                    <td className="px-4 py-3 font-medium text-dr3-mist">{r.full_name}</td>
                    <td className="px-4 py-3">
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={999}
                        step={0.1}
                        value={rs.count}
                        disabled={!editable}
                        onChange={(e) => setRow(r.bonus_employee_id, { count: e.target.value })}
                        className="w-24 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan disabled:opacity-60"
                        aria-label={`Mattress count for ${r.full_name}`}
                        aria-describedby={`grid-hint-${r.bonus_employee_id}`}
                        data-testid={`grid-count-${r.bonus_employee_id}`}
                      />
                      {overWarn ? (
                        <span
                          className="ml-2 text-xs text-amber-300"
                          data-testid={`grid-warn-${r.bonus_employee_id}`}
                        >
                          Over {SOFT_WARN_THRESHOLD} — please confirm
                        </span>
                      ) : null}
                      <span
                        id={`grid-hint-${r.bonus_employee_id}`}
                        className="mt-1 block text-xs text-dr3-mist-dim"
                        data-testid={`grid-hint-${r.bonus_employee_id}`}
                      >
                        Up to one decimal place
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        value={rs.note}
                        disabled={!editable}
                        maxLength={2000}
                        onChange={(e) => setRow(r.bonus_employee_id, { note: e.target.value })}
                        className="w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan disabled:opacity-60"
                        aria-label={`Note for ${r.full_name}`}
                        data-testid={`grid-note-${r.bonus_employee_id}`}
                      />
                    </td>
                    <td
                      className="px-4 py-3 text-right font-mono text-dr3-mist"
                      data-testid={`grid-bonus-${r.bonus_employee_id}`}
                    >
                      {formatCents(bonus)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-dr3-steel-light/30 bg-dr3-space-2/70">
              <td className="px-4 py-3 font-semibold text-dr3-mist" colSpan={3}>
                Day total
              </td>
              <td
                className="px-4 py-3 text-right font-mono text-base font-bold text-dr3-cyan-bright"
                data-testid="grid-total"
              >
                {formatCents(totalCents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {editable ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-dr3-cyan px-5 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:opacity-60"
            data-testid="grid-save"
          >
            {saving ? 'Saving…' : 'Save entries'}
          </button>
        </div>
      ) : null}
    </section>
  );
}
