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
import { RequestEditBatchModal, type BatchItem } from './RequestEditBatchModal';

// ADR-0028: the `requires_amendment` 409 shape returned by POST /api/bonus/entries
// when a non-admin manager edits a prior day's count in the current draft period.
interface PendingChange {
  bonus_employee_id: string;
  change_type: 'update' | 'insert';
  existing: { mattress_count: number; saves: number; note: string | null } | null;
  proposed: { mattress_count: number; saves: number; note: string | null };
}
interface RequiresAmendmentBody {
  error: 'requires_amendment';
  monthId: string;
  pending: PendingChange[];
  approverName: string | null;
}

// ADR-0029: the whole set of prior-day changes from one save routes through a
// SINGLE batch modal → one amendment request batch → one notification per
// direction. The modal carries the shared period/date/approver plus the items.
interface AmendmentBatch {
  bonusPayPeriodId: string;
  targetEntryDate: string;
  approverName: string;
  items: BatchItem[];
}

export interface GridRowProps {
  bonus_employee_id: string;
  full_name: string;
  mattress_count: number | null;
  /** ADR-0083 — mattresses saved for resale; null iff the row is unkeyed. */
  saves: number | null;
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

// Counts allow one decimal place, so a day's sum can pick up binary-float dust
// (0.1 + 0.2). Round to a single decimal, then render integers cleanly and
// fractional totals to one place, with a thousands separator for tablet legibility.
const formatMattresses = (n: number): string =>
  (Math.round(n * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 });

// T-330: accept 0–9999 with an optional single decimal place. The numeric range
// (0..999) and one-decimal rule are re-enforced by parsedCount and, server-side,
// by isValidMattressCount — this pattern is the input-shape gate only. Negatives
// have no `-`, so they are excluded by construction.
const COUNT_PATTERN = /^\d{1,4}(\.\d)?$/;

interface RowState {
  count: string; // raw input string ('' = not entered)
  saves: string; // ADR-0083 — raw input string ('' = not entered)
  note: string;
}

export function DailyEntryGrid({ rule, entryDate, editable, monthState, rows }: Props) {
  const router = useRouter();
  const [state, setState] = useState<Record<string, RowState>>(() => {
    const init: Record<string, RowState> = {};
    for (const r of rows) {
      init[r.bonus_employee_id] = {
        count: r.mattress_count != null ? String(r.mattress_count) : '',
        saves: r.saves != null ? String(r.saves) : '',
        note: r.note ?? '',
      };
    }
    return init;
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // ADR-0029: a single save that touches N prior-day count changes routes
  // through ONE batch amendment request (one notification per direction), not N
  // separate modals. We collect every pending change into one batch and surface
  // a single modal. Closing it (submit or cancel) refreshes the grid.
  const [amendmentBatch, setAmendmentBatch] = useState<AmendmentBatch | null>(null);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.bonus_employee_id, r.full_name);
    return m;
  }, [rows]);

  const closeBatch = () => {
    setAmendmentBatch(null);
    router.refresh();
  };

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

  // ADR-0083 — the live day total is tiered ONCE over PAID units (processed +
  // saves), matching `dailyBonusCentsFor` on the server. A row with no processed
  // count but a saves figure still earns, so it is included: the guard is on
  // "nothing keyed at all", not on the count alone.
  const totalCents = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const rs = state[r.bonus_employee_id];
      const n = parsedCount(rs?.count ?? '');
      const sv = parsedCount(rs?.saves ?? '');
      if (n != null || sv != null) {
        sum += calculateDailyBonusCents((n ?? 0) + (sv ?? 0), rule);
      }
    }
    return sum;
  }, [state, rows, rule]);

  // Live sum of the per-employee SAVES column. Reported separately from
  // processed mattresses because they are disjoint quantities (ADR-0083) — a
  // combined "units" figure in the footer would invite reading a saved mattress
  // as a processed one.
  const totalSaves = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const sv = parsedCount(state[r.bonus_employee_id]?.saves ?? '');
      if (sv != null) sum += sv;
    }
    return sum;
  }, [state, rows]);

  // Live sum of the per-employee mattress counts (the "total processed" figure —
  // same reactivity as `totalCents`). Uses the raw parsed count, NOT the calculator
  // floor: this is how many mattresses were processed, not a bonus input.
  const totalMattresses = useMemo(() => {
    let sum = 0;
    for (const r of rows) {
      const n = parsedCount(state[r.bonus_employee_id]?.count ?? '');
      if (n != null) sum += n;
    }
    return sum;
  }, [state, rows]);

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
      saves: number;
      note: string | null;
    }> = [];
    for (const r of rows) {
      const rs = state[r.bonus_employee_id]!;
      const n = parsedCount(rs.count);
      const sv = parsedCount(rs.saves);
      // ADR-0083 — a row is "keyed" if EITHER box has a value. Requiring a
      // processed count would make a saves-only day unsubmittable, and a
      // processor who spent a shift pulling units for resale has a real, paid
      // day with a zero processed count.
      if (rs.count.trim() === '' && rs.saves.trim() === '') continue;
      if (rs.count.trim() !== '' && n == null) {
        setError(
          `"${r.full_name}" has an invalid count — enter 0 to 999 with at most one decimal place.`,
        );
        return;
      }
      if (rs.saves.trim() !== '' && sv == null) {
        setError(
          `"${r.full_name}" has an invalid saves value — enter 0 to 999 with at most one decimal place.`,
        );
        return;
      }
      entries.push({
        bonus_employee_id: r.bonus_employee_id,
        mattress_count: n ?? 0,
        // Always sent explicitly, never omitted: the server treats an ABSENT
        // saves as "leave unchanged" (stale-tab safety), so a blank box on a
        // current client has to mean an explicit 0 or clearing a value would be
        // impossible.
        saves: sv ?? 0,
        note: rs.note.trim() || null,
      });
    }

    if (entries.length === 0) {
      setError('Enter at least one mattress count or saves value before saving.');
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
        const body = (await res.json().catch(() => ({}))) as Partial<RequiresAmendmentBody> & {
          error?: string;
        };
        // ADR-0028: a non-admin manager editing a prior day's count in the
        // current draft period cannot write directly — the change routes through
        // the four-eyes amendment workflow. Instead of dumping the raw
        // "requires_amendment" string, pivot to the Request Edit modal(s).
        if (
          res.status === 409 &&
          body.error === 'requires_amendment' &&
          body.monthId &&
          Array.isArray(body.pending)
        ) {
          const approverName = body.approverName ?? 'your counterpart';
          const items: BatchItem[] = body.pending.map((p) => ({
            bonusEmployeeId: p.bonus_employee_id,
            employeeName: nameById.get(p.bonus_employee_id) ?? 'this processor',
            changeType: p.change_type,
            oldValue: p.existing,
            newValue: p.proposed,
          }));
          setAmendmentBatch({
            bonusPayPeriodId: body.monthId,
            targetEntryDate: entryDate,
            approverName,
            items,
          });
          return;
        }
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
              {/* ADR-0083 — saves sits directly beside processed, per JT's ask
                  ("a dedicated saves field beside processed"). */}
              <th className="px-4 py-3 font-semibold">Saves</th>
              <th className="px-4 py-3 font-semibold">Note (optional)</th>
              <th className="px-4 py-3 text-right font-semibold">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-dr3-mist-dim">
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
                const sv = parsedCount(rs.saves);
                const overWarn = n != null && Math.floor(n) > SOFT_WARN_THRESHOLD;
                // ADR-0083 — one tier application over processed + saves, the
                // same basis the server and the signed PDF use.
                const bonus =
                  n != null || sv != null
                    ? calculateDailyBonusCents((n ?? 0) + (sv ?? 0), rule)
                    : 0;
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
                        type="number"
                        inputMode="decimal"
                        min={0}
                        max={999}
                        step={0.1}
                        value={rs.saves}
                        disabled={!editable}
                        onChange={(e) => setRow(r.bonus_employee_id, { saves: e.target.value })}
                        className="w-24 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan disabled:opacity-60"
                        aria-label={`Mattresses saved for resale by ${r.full_name}`}
                        aria-describedby={`grid-saves-hint-${r.bonus_employee_id}`}
                        data-testid={`grid-saves-${r.bonus_employee_id}`}
                      />
                      <span
                        id={`grid-saves-hint-${r.bonus_employee_id}`}
                        className="mt-1 block text-xs text-dr3-mist-dim"
                        data-testid={`grid-saves-hint-${r.bonus_employee_id}`}
                      >
                        Saved for resale — paid the same
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
              <td className="px-4 py-3 font-semibold text-dr3-mist">Day total</td>
              {/* Total processed mattresses — under the Mattresses column, aligned
                  with the per-row counts; captioned + aria-labelled so it can't be
                  read as a dollar figure alongside the Bonus total. */}
              <td
                className="whitespace-nowrap px-4 py-3 text-right font-mono text-base font-bold text-dr3-mist"
                data-testid="grid-total-mattresses"
                aria-label={`Total processed mattresses: ${formatMattresses(totalMattresses)}`}
              >
                {formatMattresses(totalMattresses)}
                <span className="ml-1 text-xs font-normal text-dr3-mist-dim">mattresses</span>
              </td>
              {/* ADR-0083 — saves totalled in its OWN footer cell rather than
                  folded into the mattresses figure. They are disjoint
                  quantities: a saved mattress was diverted to resale, not torn
                  down, and merging the two would invite reading one as the
                  other. The Bonus total beside it IS the combined figure,
                  because pay is what the two have in common. */}
              <td
                className="whitespace-nowrap px-4 py-3 text-right font-mono text-base font-bold text-dr3-mist"
                data-testid="grid-total-saves"
                aria-label={`Total mattresses saved for resale: ${formatMattresses(totalSaves)}`}
              >
                {formatMattresses(totalSaves)}
                <span className="ml-1 text-xs font-normal text-dr3-mist-dim">saved</span>
              </td>
              <td className="px-4 py-3" />
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

      {/* ADR-0029: prior-day count edits route through the four-eyes amendment
          workflow as ONE batch request (one notification per direction). The
          grid surfaces a single batch modal built off the 409 `requires_amendment`
          response listing every pending change; submit/cancel refreshes the grid. */}
      {amendmentBatch ? (
        <RequestEditBatchModal
          open
          onClose={closeBatch}
          bonusPayPeriodId={amendmentBatch.bonusPayPeriodId}
          targetEntryDate={amendmentBatch.targetEntryDate}
          approverName={amendmentBatch.approverName}
          items={amendmentBatch.items}
        />
      ) : null}
    </section>
  );
}
