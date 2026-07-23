'use client';

// ADR-0037 Phase 3 (§3.3 Option B) — manager daily-close ENTRY panel.
//
// Entry + amendment only. There is deliberately NO close control here: closing and
// locking a day is Bill's authority at /admin/processed-units, and no manager API
// exists to call. A closed day renders read-only with a "Closed — locked by Bill"
// status; the server refuses a write to it regardless (409 `closed`).
//
// CLAUDE.md hard rule #10 — no <form>; every handler is onClick/onChange.

import { useCallback, useEffect, useState } from 'react';
import type { ProcessedUnitsView } from '@/lib/loads/processed-units';

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const labelCls = 'flex flex-col gap-1 text-sm';
const btnCls = 'rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-black disabled:opacity-40';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoDate(d: Date | string): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}
function numOrUndef(s: string): number | undefined {
  return s.trim() === '' ? undefined : Number(s);
}

export function ProcessedUnitsEntryClient({ siteCode }: { siteCode: string }) {
  const [rows, setRows] = useState<ProcessedUnitsView[]>([]);
  const [date, setDate] = useState(todayIso());
  const [strippedProgram, setStrippedProgram] = useState('');
  const [strippedNonProgram, setStrippedNonProgram] = useState('0');
  const [savedUnits, setSavedUnits] = useState('');
  const [materialTicket, setMaterialTicket] = useState('');
  const [employees, setEmployees] = useState('');
  const [processors, setProcessors] = useState('');
  const [pocketcoil, setPocketcoil] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/manager/${siteCode}/processed-units`);
    if (!res.ok) return;
    const data = (await res.json()) as { rows: ProcessedUnitsView[] };
    setRows(data.rows);
  }, [siteCode]);
  useEffect(() => void load(), [load]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/manager/${siteCode}/processed-units`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          productionDate: date,
          strippedProgram: Number(strippedProgram),
          strippedNonProgram: Number(strippedNonProgram || '0'),
          savedUnits: numOrUndef(savedUnits),
          materialTicketNumber: materialTicket || undefined,
          employeesCount: numOrUndef(employees),
          processorsCount: numOrUndef(processors),
          pocketcoilEstimate: numOrUndef(pocketcoil),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({
          kind: 'err',
          text:
            err.error === 'closed'
              ? 'That day is already closed and locked — ask Bill to run the amendment path.'
              : `Save failed (${res.status}).`,
        });
        return;
      }
      setMsg({ kind: 'ok', text: `Saved ${date}. Bill closes and locks it.` });
      setStrippedProgram('');
      setStrippedNonProgram('0');
      setSavedUnits('');
      setMaterialTicket('');
      setEmployees('');
      setProcessors('');
      setPocketcoil('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave = strippedProgram !== '' && Number.isFinite(Number(strippedProgram));

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-white/15 bg-black/20 p-5">
        <h2 className="text-lg font-semibold">Enter a day</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className={labelCls}>
            <span className="opacity-70">Production date</span>
            <input
              type="date"
              className={inputCls}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Stripped — program (billed)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              className={inputCls}
              value={strippedProgram}
              onChange={(e) => setStrippedProgram(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Stripped — non-program</span>
            <input
              type="number"
              min="0"
              step="0.1"
              className={inputCls}
              value={strippedNonProgram}
              onChange={(e) => setStrippedNonProgram(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Saved units</span>
            <input
              type="number"
              min="0"
              step="0.1"
              className={inputCls}
              value={savedUnits}
              onChange={(e) => setSavedUnits(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Material ticket #</span>
            <input
              className={inputCls}
              value={materialTicket}
              onChange={(e) => setMaterialTicket(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70"># employees</span>
            <input
              type="number"
              min="0"
              className={inputCls}
              value={employees}
              onChange={(e) => setEmployees(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70"># processors</span>
            <input
              type="number"
              min="0"
              className={inputCls}
              value={processors}
              onChange={(e) => setProcessors(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="opacity-70">Pocketcoil estimate</span>
            <input
              type="number"
              min="0"
              className={inputCls}
              value={pocketcoil}
              onChange={(e) => setPocketcoil(e.target.value)}
            />
          </label>
        </div>
        <div className="mt-4 flex items-center gap-4">
          <button type="button" disabled={!canSave || busy} onClick={save} className={btnCls}>
            {busy ? 'Saving…' : 'Save entry'}
          </button>
          {msg && (
            <span className={msg.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-300'}>
              {msg.text}
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Recent days</h2>
        <p className="mt-1 text-xs opacity-70">
          Whole units sold + landfilled are derived from the day&apos;s renovation outbound +
          landfilled rows — never entered here. Re-saving an open day amends it. Only Bill can close
          and lock a day.
        </p>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="opacity-70">
            <tr>
              <th className="py-2">Date</th>
              <th className="py-2">Stripped P</th>
              <th className="py-2">Stripped NP</th>
              <th className="py-2">Total</th>
              <th className="py-2">Saved</th>
              <th className="py-2">Whole sold</th>
              <th className="py-2">Landfilled</th>
              <th className="py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="py-4 opacity-70">
                  No entries yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-white/10">
                <td className="py-2">{isoDate(r.productionDate)}</td>
                <td className="py-2">{r.strippedProgram}</td>
                <td className="py-2">{r.strippedNonProgram}</td>
                <td className="py-2 font-semibold">{r.totalStripped}</td>
                <td className="py-2">{r.savedUnits ?? '—'}</td>
                <td className="py-2">{r.derived.wholeUnitsSold.total}</td>
                <td className="py-2">{r.derived.landfilled.total}</td>
                <td className="py-2">
                  {r.closedAt ? 'Closed — locked by Bill' : 'Open — you can still amend'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
