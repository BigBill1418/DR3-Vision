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

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  calculateDailyBonusCents,
  formatCents,
  type BonusRuleParams,
} from '@/lib/bonus/calculator';

export interface AmendEmployeeRow {
  bonus_employee_id: string;
  full_name: string;
  /** Existing count for the selected day, or null if not keyed that day. */
  mattress_count: number | null;
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
  entriesByDay: Record<string, { mattress_count: number; note: string | null }>;
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
        <p className="text-sm text-dr3-cream/70">
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
          className="self-start rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink transition hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse/70"
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
            <div className="w-full max-w-md rounded-lg bg-dr3-cream p-6 text-dr3-ink shadow-xl">
              <h2 className="text-lg font-bold">Unlock this month?</h2>
              <p className="mt-3 text-sm leading-relaxed">
                Both signatures will be cleared and the month re-opened for correction. The original
                signed PDF is preserved; a new AMENDED PDF is generated after re-signing.
              </p>
              <div className="mt-4">
                <label htmlFor="amend-reason" className="block text-sm font-medium">
                  Reason for amendment<span className="text-red-700"> *</span>
                </label>
                <textarea
                  id="amend-reason"
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Maria's 5/12 count was keyed as 60, should be 80"
                  className="mt-1 w-full rounded-md border border-dr3-ink/20 bg-white px-3 py-2 text-sm focus:border-dr3-green-dark focus:outline-none focus:ring-1 focus:ring-dr3-green-dark"
                  data-testid="amendment-reason"
                />
              </div>
              {unlockError && (
                <p role="alert" className="mt-3 rounded bg-red-100 px-3 py-2 text-sm text-red-800">
                  {unlockError}
                </p>
              )}
              <div className="mt-6 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => !unlocking && setUnlockOpen(false)}
                  disabled={unlocking}
                  className="rounded-md px-4 py-2 text-sm font-medium text-dr3-ink/70 hover:text-dr3-ink disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitUnlock}
                  disabled={unlocking || reason.trim().length === 0}
                  className="rounded-md bg-dr3-green-deep px-4 py-2 text-sm font-semibold text-dr3-cream transition hover:bg-dr3-green-dark disabled:opacity-50"
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
  entriesByDay: Record<string, { mattress_count: number; note: string | null }>;
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

  const totalCents = useMemo(() => {
    let sum = 0;
    for (const e of employees) {
      const n = parsed(state[e.bonus_employee_id]?.count ?? '');
      if (n != null) sum += calculateDailyBonusCents(n, rule);
    }
    return sum;
  }, [state, employees, rule]);

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
      note: string | null;
    }> = [];
    for (const e of employees) {
      const rs = state[e.bonus_employee_id]!;
      if (rs.count.trim() === '') continue;
      const n = parsed(rs.count);
      if (n == null) {
        setError(`"${e.full_name}" has an invalid count — enter a whole number from 0 to 999.`);
        return;
      }
      entries.push({
        bonus_employee_id: e.bonus_employee_id,
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
      const res = await fetch(`/api/bonus/months/${monthId}/entries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_date: day, entries }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'Could not save corrected counts. Please try again.');
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
      <p className="text-sm text-dr3-cream/70">
        This month is unlocked for amendment. Correct the daily counts below, then re-submit for
        signatures. A new AMENDED PDF is generated once both signatures are re-collected.
      </p>

      <div className="flex items-center gap-3">
        <label htmlFor="amend-day" className="text-sm font-medium text-dr3-cream">
          Edit day
        </label>
        <select
          id="amend-day"
          value={day}
          onChange={(e) => onDayChange(e.target.value)}
          className="rounded-md bg-dr3-green-dark/40 px-3 py-2 text-sm text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
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
          className="rounded-md bg-dr3-green-dark/40 px-4 py-2 text-sm text-dr3-cream"
        >
          Corrected counts saved.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-dr3-green-dark/50">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="bg-dr3-green-dark/40 text-xs uppercase tracking-wider text-dr3-cream/70">
              <th className="px-4 py-3 font-semibold">Processor</th>
              <th className="px-4 py-3 font-semibold">Mattresses</th>
              <th className="px-4 py-3 font-semibold">Note (optional)</th>
              <th className="px-4 py-3 text-right font-semibold">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {employees.map((e) => {
              const rs = state[e.bonus_employee_id]!;
              const n = parsed(rs.count);
              const overWarn = n != null && n > SOFT_WARN;
              const bonus = n != null ? calculateDailyBonusCents(n, rule) : 0;
              return (
                <tr
                  key={e.bonus_employee_id}
                  className="border-t border-dr3-green-dark/30"
                  data-testid={`amend-row-${e.bonus_employee_id}`}
                >
                  <td className="px-4 py-3 font-medium text-dr3-cream">{e.full_name}</td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={999}
                      value={rs.count}
                      onChange={(ev) => setRow(e.bonus_employee_id, { count: ev.target.value })}
                      className="w-24 rounded-md bg-dr3-green-dark/40 px-3 py-2 text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
                      aria-label={`Mattress count for ${e.full_name}`}
                      data-testid={`amend-count-${e.bonus_employee_id}`}
                    />
                    {overWarn && (
                      <span className="ml-2 text-xs text-dr3-chartreuse">
                        Over {SOFT_WARN} — please confirm
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={rs.note}
                      maxLength={2000}
                      onChange={(ev) => setRow(e.bonus_employee_id, { note: ev.target.value })}
                      className="w-full rounded-md bg-dr3-green-dark/40 px-3 py-2 text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
                      aria-label={`Note for ${e.full_name}`}
                    />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-dr3-cream">
                    {formatCents(bonus)}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-dr3-green-dark/60 bg-dr3-green-dark/30">
              <td className="px-4 py-3 font-semibold text-dr3-cream" colSpan={3}>
                Day total
              </td>
              <td
                className="px-4 py-3 text-right font-mono text-base font-bold text-dr3-chartreuse"
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
          className="rounded-md bg-dr3-chartreuse px-5 py-2 text-sm font-semibold text-dr3-ink transition-opacity hover:opacity-90 disabled:opacity-60"
          data-testid="amend-save"
        >
          {saving ? 'Saving…' : 'Save corrected counts'}
        </button>
        <button
          type="button"
          onClick={resubmit}
          disabled={resubmitting}
          className="rounded-md bg-dr3-green-deep px-5 py-2 text-sm font-semibold text-dr3-cream transition hover:bg-dr3-green-dark disabled:opacity-60"
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
  entriesByDay: Record<string, { mattress_count: number; note: string | null }>,
  iso: string,
): Record<string, RowState> {
  const out: Record<string, RowState> = {};
  for (const e of employees) {
    const keyed = entriesByDay[`${iso}|${e.bonus_employee_id}`];
    out[e.bonus_employee_id] = {
      count: keyed ? String(keyed.mattress_count) : '',
      note: keyed?.note ?? '',
    };
  }
  return out;
}
