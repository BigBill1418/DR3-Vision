'use client';

// T-116 — Amendment panel (ADR-0019 §6, ADMIN-ONLY client component).
//
// CLAUDE.md hard rule #10 — no `<form>` element; buttons post via onClick. No
// component library (hard rule #7) — plain HTML + Tailwind brand tokens.
// English-only (ADR-0017). This component is rendered ONLY for admins (the page
// gates on ctx.isAdmin); the server also re-enforces admin-only on every route,
// so the UI gate is a convenience, not the security boundary.
//
// Three responsibilities, keyed on month state:
//   - signed | paid  -> "Unlock month" (confirm modal requires a free-text reason)
//                       POST /api/bonus/months/<id>/amend
//   - amended        -> a month-scoped editable daily grid (correct the counts)
//                       POST /api/bonus/months/<id>/entries
//                       + "Re-submit for signatures"
//                       POST /api/bonus/months/<id>/resubmit
//
// ADR-0083 Amendment 1 (2026-08-08) — this grid can now correct `saves`.
//
// It shipped with four columns while ADR-0083 added a fifth paid quantity, so a
// mis-keyed saves figure inside an already-signed period had NO correction
// surface anywhere in the app: the primary `DailyEntryGrid` refuses a locked
// month, and this — the only editor that reaches one — could not express the
// value. Nothing was lost by that gap (the service reads an ABSENT `saves` as
// UNCHANGED, never zero, so correcting a count here never wiped one), but the
// deadline was real: ADR-0083 shipped 2026-08-08, so the FIRST signed period
// containing a non-zero save closes at the end of the current bi-weekly period.
//
// The column is modelled on `DailyEntryGrid` deliberately, down to the semantics
// that are easy to get subtly wrong:
//
//   - `saves` is ALWAYS sent, never omitted. The server treats absent as
//     "leave unchanged" (stale-tab safety), so if a blank box omitted the field
//     there would be no way to clear a value back to zero from this screen.
//   - A row is "keyed" if EITHER box has a value. Requiring a processed count
//     would make a saves-only correction unsubmittable — and a processor who
//     spent a shift pulling units for resale has a real, paid day with a zero
//     processed count.
//   - The day total tiers ONCE over `count + saves` (`paid-units.ts`), never
//     twice over the two columns separately. Tiering separately grants a second
//     unpaid 50-unit allowance and pays $0 for most real days.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  calculateDailyBonusCents,
  formatCents,
  type BonusRuleParams,
} from '@/lib/bonus/calculator';
import { amendmentErrorMessage } from '@/lib/bonus/amendment-error-messages';

export interface AmendEmployeeRow {
  bonus_employee_id: string;
  full_name: string;
  /** Existing count for the selected day, or null if not keyed that day. */
  mattress_count: number | null;
  /** ADR-0083 — existing saves for the selected day, or null if not keyed. */
  saves: number | null;
  note: string | null;
}

export interface AmendDayOption {
  /** ISO YYYY-MM-DD (UTC calendar day). */
  iso: string;
  label: string;
}

interface Props {
  monthId: string;
  /** 'signed' | 'paid' | 'amended' — the panel only renders for these. */
  state: 'signed' | 'paid' | 'amended';
  /** Woodland rule params for live calculation (from the server, NEVER hardcoded). */
  rule: BonusRuleParams;
  /** Days of this month (for the amended-state day picker). */
  days: AmendDayOption[];
  /** Active employees with the FIRST day's entries pre-loaded (amended state only). */
  employees: AmendEmployeeRow[];
  /** Entries keyed by `${iso}|${employeeId}` -> { count, note } for fast day switching. */
  entriesByDay: Record<string, { mattress_count: number; saves: number; note: string | null }>;
}

const SOFT_WARN = 200;

export function AmendmentPanel({ monthId, state, rule, days, employees, entriesByDay }: Props) {
  const router = useRouter();

  // ── Unlock modal (signed | paid) ──────────────────────────────────
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  async function submitUnlock() {
    if (reason.trim().length === 0) {
      setUnlockError('A reason is required to unlock this month.');
      return;
    }
    setUnlocking(true);
    setUnlockError(null);
    try {
      const res = await fetch(`/api/bonus/months/${monthId}/amend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setUnlockError(body.error ?? 'Could not unlock this month. Please try again.');
        setUnlocking(false);
        return;
      }
      setUnlockOpen(false);
      setUnlocking(false);
      router.refresh();
    } catch {
      setUnlockError('Network error. Please try again.');
      setUnlocking(false);
    }
  }

  if (state === 'signed' || state === 'paid') {
    return (
      <div className="flex flex-col gap-3" data-testid="amendment-unlock">
        <p className="text-sm text-dr3-mist-dim">
          This month is locked. Unlocking it for amendment clears both signatures and re-opens the
          daily counts for correction. Both signatures must be re-collected afterward.
        </p>
        <button
          type="button"
          onClick={() => {
            setReason('');
            setUnlockError(null);
            setUnlockOpen(true);
          }}
          className="self-start rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition hover:bg-dr3-cyan-bright focus:outline-none focus:ring-2 focus:ring-dr3-cyan/70"
          data-testid="amendment-unlock-btn"
        >
          Unlock month for amendment
        </button>

        {unlockOpen && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Unlock month for amendment"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          >
            <div className="w-full max-w-md rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-6 text-dr3-mist shadow-xl">
              <h2 className="text-lg font-bold">Unlock this month?</h2>
              <p className="mt-3 text-sm leading-relaxed text-dr3-mist-dim">
                Both signatures will be cleared and the month re-opened for correction. The original
                signed PDF is preserved; a new AMENDED PDF is generated after re-signing.
              </p>
              <div className="mt-4">
                <label htmlFor="amend-reason" className="block text-sm font-medium">
                  Reason for amendment<span className="text-red-400"> *</span>
                </label>
                <textarea
                  id="amend-reason"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Maria's 5/12 count was keyed as 60, should be 80"
                  className="mt-1 w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist placeholder:text-dr3-mist-dim/60 focus:border-dr3-cyan focus:outline-none focus:ring-1 focus:ring-dr3-cyan"
                  data-testid="amendment-reason"
                />
              </div>
              {unlockError && (
                <p
                  role="alert"
                  className="mt-3 rounded border border-red-500/30 bg-red-900/40 px-3 py-2 text-sm text-red-100"
                >
                  {unlockError}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !unlocking && setUnlockOpen(false)}
                  disabled={unlocking}
                  className="rounded-md px-4 py-2 text-sm font-medium text-dr3-mist-dim hover:text-dr3-mist disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitUnlock}
                  disabled={unlocking || reason.trim().length === 0}
                  className="rounded-md bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space transition hover:bg-dr3-cyan-bright disabled:opacity-50"
                  data-testid="amendment-confirm-unlock"
                >
                  {unlocking ? 'Unlocking…' : 'Unlock for amendment'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Amended state: editable grid + re-submit ──────────────────────
  return (
    <AmendedEditor
      monthId={monthId}
      rule={rule}
      days={days}
      employees={employees}
      entriesByDay={entriesByDay}
    />
  );
}

interface RowState {
  count: string;
  /** ADR-0083 — raw input string; '' means "not entered", exactly as `count`. */
  saves: string;
  note: string;
}

function AmendedEditor({
  monthId,
  rule,
  days,
  employees,
  entriesByDay,
}: {
  monthId: string;
  rule: BonusRuleParams;
  days: AmendDayOption[];
  employees: AmendEmployeeRow[];
  entriesByDay: Record<string, { mattress_count: number; saves: number; note: string | null }>;
}) {
  const router = useRouter();
  const [day, setDay] = useState<string>(days[0]?.iso ?? '');
  const [state, setState] = useState<Record<string, RowState>>(() =>
    buildRowState(employees, entriesByDay, days[0]?.iso ?? ''),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-submit
  const [resubmitting, setResubmitting] = useState(false);
  const [resubmitError, setResubmitError] = useState<string | null>(null);

  function onDayChange(iso: string) {
    setDay(iso);
    setSaved(false);
    setError(null);
    setState(buildRowState(employees, entriesByDay, iso));
  }

  const parsed = (raw: string): number | null => {
    if (raw.trim() === '') return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 999) return null;
    return n;
  };

  // ADR-0083 — one tier application over processed + saves, matching
  // `dailyBonusCentsFor` on the server. A row with no processed count but a
  // saves figure still earns, so it is included; a row with neither earns
  // nothing and is skipped.
  const totalCents = useMemo(() => {
    let sum = 0;
    for (const e of employees) {
      const rs = state[e.bonus_employee_id];
      const n = parsed(rs?.count ?? '');
      const sv = parsed(rs?.saves ?? '');
      if (n != null || sv != null) sum += calculateDailyBonusCents((n ?? 0) + (sv ?? 0), rule);
    }
    return sum;
  }, [state, employees, rule]);

  /** Total saved-for-resale units on the selected day, for its own footer cell. */
  const totalSaves = useMemo(() => {
    let sum = 0;
    for (const e of employees) sum += parsed(state[e.bonus_employee_id]?.saves ?? '') ?? 0;
    return sum;
  }, [state, employees]);

  const setRow = (id: string, patch: Partial<RowState>) => {
    setSaved(false);
    setState((prev) => ({ ...prev, [id]: { ...prev[id]!, ...patch } }));
  };

  async function save() {
    setError(null);
    setSaved(false);
    const entries: Array<{
      bonus_employee_id: string;
      mattress_count: number;
      saves: number;
      note: string | null;
    }> = [];
    for (const e of employees) {
      const rs = state[e.bonus_employee_id]!;
      // ADR-0083 — keyed if EITHER box has a value; see the file header.
      if (rs.count.trim() === '' && rs.saves.trim() === '') continue;
      const n = parsed(rs.count);
      const sv = parsed(rs.saves);
      if (rs.count.trim() !== '' && n == null) {
        setError(`"${e.full_name}" has an invalid count — enter a whole number from 0 to 999.`);
        return;
      }
      if (rs.saves.trim() !== '' && sv == null) {
        setError(
          `"${e.full_name}" has an invalid saves value — enter a whole number from 0 to 999.`,
        );
        return;
      }
      entries.push({
        bonus_employee_id: e.bonus_employee_id,
        mattress_count: n ?? 0,
        // Sent EXPLICITLY on every entry, never omitted. The server reads an
        // absent `saves` as "leave unchanged" (stale-tab safety), so omitting it
        // for a blank box would make clearing a value back to 0 impossible from
        // this screen — the one screen that reaches a signed period.
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
      const res = await fetch(`/api/bonus/months/${monthId}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_date: day, entries }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          amendmentErrorMessage(body.error, 'Could not save corrected counts. Please try again.'),
        );
        return;
      }
      setSaved(true);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function resubmit() {
    setResubmitError(null);
    setResubmitting(true);
    try {
      const res = await fetch(`/api/bonus/months/${monthId}/resubmit`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setResubmitError(body.error ?? 'Could not re-submit for signatures. Please try again.');
        setResubmitting(false);
        return;
      }
      router.refresh();
    } catch {
      setResubmitError('Network error. Please try again.');
      setResubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4" data-testid="amendment-editor">
      <p className="text-sm text-dr3-mist-dim">
        This month is unlocked for amendment. Correct the daily counts below, then re-submit for
        signatures. A new AMENDED PDF is generated once both signatures are re-collected.
      </p>

      <div className="flex items-center gap-3">
        <label htmlFor="amend-day" className="text-sm font-medium text-dr3-mist">
          Edit day
        </label>
        <select
          id="amend-day"
          value={day}
          onChange={(e) => onDayChange(e.target.value)}
          className="rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-sm text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
          data-testid="amendment-day-select"
        >
          {days.map((d) => (
            <option key={d.iso} value={d.iso}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100">
          {error}
        </p>
      )}
      {saved && (
        <p
          role="status"
          className="rounded-md border border-emerald-400/30 bg-emerald-500/15 px-4 py-2 text-sm text-emerald-200"
        >
          Corrected counts saved.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-dr3-steel-light/25">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-dr3-space-2/80 text-xs uppercase tracking-wider text-dr3-cyan">
              <th className="px-4 py-3 font-semibold">Processor</th>
              <th className="px-4 py-3 font-semibold">Mattresses</th>
              {/* ADR-0083 — saves sits directly beside processed, matching the
                  primary DailyEntryGrid so the two editors read identically. */}
              <th className="px-4 py-3 font-semibold">Saved for resale</th>
              <th className="px-4 py-3 font-semibold">Note (optional)</th>
              <th className="px-4 py-3 text-right font-semibold">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const rs = state[e.bonus_employee_id]!;
              const n = parsed(rs.count);
              const sv = parsed(rs.saves);
              const overWarn = n != null && n > SOFT_WARN;
              // ADR-0083 — tiered ONCE over the summed paid units, never twice.
              const bonus =
                n != null || sv != null ? calculateDailyBonusCents((n ?? 0) + (sv ?? 0), rule) : 0;
              return (
                <tr
                  key={e.bonus_employee_id}
                  className="border-t border-dr3-steel-light/20 odd:bg-dr3-space-2/40"
                  data-testid={`amend-row-${e.bonus_employee_id}`}
                >
                  <td className="px-4 py-3 font-medium text-dr3-mist">{e.full_name}</td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={999}
                      value={rs.count}
                      onChange={(ev) => setRow(e.bonus_employee_id, { count: ev.target.value })}
                      className="w-24 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                      aria-label={`Mattress count for ${e.full_name}`}
                      data-testid={`amend-count-${e.bonus_employee_id}`}
                    />
                    {overWarn && (
                      <span className="ml-2 text-xs text-amber-300">
                        Over {SOFT_WARN} — please confirm
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={999}
                      value={rs.saves}
                      onChange={(ev) => setRow(e.bonus_employee_id, { saves: ev.target.value })}
                      className="w-24 rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                      aria-label={`Mattresses saved for resale by ${e.full_name}`}
                      aria-describedby={`amend-saves-hint-${e.bonus_employee_id}`}
                      data-testid={`amend-saves-${e.bonus_employee_id}`}
                    />
                    <span
                      id={`amend-saves-hint-${e.bonus_employee_id}`}
                      className="mt-1 block text-xs text-dr3-mist-dim"
                    >
                      Saved for resale — paid the same
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={rs.note}
                      maxLength={2000}
                      onChange={(ev) => setRow(e.bonus_employee_id, { note: ev.target.value })}
                      className="w-full rounded-md border border-dr3-steel-light/25 bg-dr3-space px-3 py-2 text-dr3-mist focus:outline-none focus:ring-2 focus:ring-dr3-cyan"
                      aria-label={`Note for ${e.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-dr3-mist">
                    {formatCents(bonus)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-dr3-steel-light/30 bg-dr3-space-2/70">
              <td className="px-4 py-3 font-semibold text-dr3-mist" colSpan={2}>
                Day total
              </td>
              {/* ADR-0083 — saves totalled in its OWN cell rather than folded
                  into anything else. Processed and saved are disjoint
                  quantities; the Bonus total beside them IS the combined
                  figure, because pay is what the two have in common. */}
              <td
                className="whitespace-nowrap px-4 py-3 font-mono text-base font-bold text-dr3-mist"
                data-testid="amend-total-saves"
                aria-label={`Total mattresses saved for resale: ${totalSaves}`}
              >
                {totalSaves}
                <span className="ml-1 text-xs font-normal text-dr3-mist-dim">saved</span>
              </td>
              <td className="px-4 py-3" />
              <td
                className="px-4 py-3 text-right font-mono text-base font-bold text-dr3-cyan-bright"
                data-testid="amend-total"
              >
                {formatCents(totalCents)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap justify-between gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-dr3-cyan px-5 py-2 text-sm font-semibold text-dr3-space transition-colors hover:bg-dr3-cyan-bright disabled:opacity-60"
          data-testid="amend-save"
        >
          {saving ? 'Saving…' : 'Save corrected counts'}
        </button>
        <button
          type="button"
          onClick={resubmit}
          disabled={resubmitting}
          className="rounded-md border border-dr3-cyan/40 bg-dr3-space-2 px-5 py-2 text-sm font-semibold text-dr3-cyan transition hover:bg-dr3-space-2/70 hover:text-dr3-cyan-bright disabled:opacity-60"
          data-testid="amend-resubmit"
        >
          {resubmitting ? 'Re-submitting…' : 'Re-submit for signatures'}
        </button>
      </div>
      {resubmitError && (
        <p role="alert" className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100">
          {resubmitError}
        </p>
      )}
    </div>
  );
}

function buildRowState(
  employees: AmendEmployeeRow[],
  entriesByDay: Record<string, { mattress_count: number; saves: number; note: string | null }>,
  iso: string,
): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  for (const e of employees) {
    const keyed = entriesByDay[`${iso}|${e.bonus_employee_id}`];
    out[e.bonus_employee_id] = {
      count: keyed ? String(keyed.mattress_count) : '',
      // Seeded from the stored row, so a note-only correction re-sends the day's
      // EXISTING saves rather than a blank. Seeding '' here would turn every
      // note edit into an explicit `saves: 0` — a silent pay cut, and the exact
      // failure the falsification in `AmendmentPanel.test.tsx` demonstrates.
      saves: keyed ? String(keyed.saves) : '',
      note: keyed?.note ?? '',
    };
  }
  return out;
}
