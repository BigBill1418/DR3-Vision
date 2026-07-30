'use client';

// ADR-0037 D5 (Addendum B4) — processed_units_daily office-desktop daily close.
//
// Super-admin only (the page enforces it; the API re-checks). English-first is
// acceptable here (office super-admin surface). CLAUDE.md hard rule #10 — no
// <form>; all handlers are onClick/onChange.
//
// The STRIPPED program split IS the billing basis: billing (P2) reads stripped
// program units only. `saved` (default 0) is set aside, not processed, and SUBTRACTS
// from the non-program inventory pool (ADR-0037 amendment §A.2). Whole units sold +
// landfilled for the day are DERIVED (from renovation outbound + landfilled rows) and
// shown for CONFIRMATION at close — never entered twice.

import { useCallback, useEffect, useState } from 'react';
import { appTodayISO } from '@/lib/time';
import type { ProcessedUnitsView } from '@/lib/loads/processed-units';

interface SiteOption {
  code: string;
  name: string;
}
interface Props {
  sites: SiteOption[];
}

// ADR-0065 Amendment 2 — the Pacific day, not the UTC day.
//
// This read `new Date().toISOString().slice(0, 10)`. `toISOString()` converts to
// UTC first, so from 5:00 PM Pacific (00:00Z the next day) it returned TOMORROW —
// and every date input on this screen defaulted to a day that had not happened.
// An evening entry silently landed on the wrong production day.
//
// `appTodayISO` already existed for exactly this ("for client default values");
// six client screens each rolled their own instead. Use the shared one.
function todayIso(): string {
  return appTodayISO();
}

const inputCls = 'rounded border border-dr3-mist/20 bg-black/30 px-2 py-1.5';
const labelCls = 'flex flex-col gap-1 text-sm';

export function ProcessedUnitsClient({ sites }: Props) {
  const [siteCode, setSiteCode] = useState(sites[0]?.code ?? '');
  const [date, setDate] = useState(todayIso());
  const [strippedProgram, setStrippedProgram] = useState('');
  const [strippedNonProgram, setStrippedNonProgram] = useState('0');
  const [savedUnits, setSavedUnits] = useState('');
  const [materialTicket, setMaterialTicket] = useState('');
  const [employees, setEmployees] = useState('');
  const [processors, setProcessors] = useState('');
  const [pocketcoil, setPocketcoil] = useState('');
  const [rows, setRows] = useState<ProcessedUnitsView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!siteCode) return;
    const res = await fetch(`/api/admin/processed-units?site=${encodeURIComponent(siteCode)}`);
    if (res.ok) {
      const data = (await res.json()) as { rows: ProcessedUnitsView[] };
      setRows(data.rows);
    }
  }, [siteCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const numOrUndef = (s: string): number | undefined => (s === '' ? undefined : Number(s));

  const save = async () => {
    setBusy('save');
    setMessage(null);
    try {
      const res = await fetch('/api/admin/processed-units', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          site: siteCode,
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
        setMessage({
          kind: 'err',
          text:
            err.error === 'closed'
              ? 'That day is closed — use the amendment path.'
              : `Save failed (${res.status}).`,
        });
        return;
      }
      setMessage({ kind: 'ok', text: `Saved ${date}.` });
      setStrippedProgram('');
      setStrippedNonProgram('0');
      setSavedUnits('');
      setMaterialTicket('');
      setEmployees('');
      setProcessors('');
      setPocketcoil('');
      await load();
    } finally {
      setBusy(null);
    }
  };

  const close = async (id: string) => {
    setBusy(id);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/processed-units/${id}/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ site: siteCode }),
      });
      if (!res.ok) {
        setMessage({ kind: 'err', text: `Close failed (${res.status}).` });
        return;
      }
      setMessage({ kind: 'ok', text: 'Day closed.' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const isBusy = busy !== null;
  const canSave =
    siteCode !== '' && strippedProgram !== '' && Number.isFinite(Number(strippedProgram));

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section className="rounded-lg border border-dr3-mist/15 bg-black/20 p-5">
        <h2 className="text-lg font-semibold">Enter a day</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className={labelCls}>
            <span className="text-dr3-mist-dim">Site</span>
            <select
              className={inputCls}
              value={siteCode}
              onChange={(e) => setSiteCode(e.target.value)}
            >
              {sites.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            <span className="text-dr3-mist-dim">Production date</span>
            <input
              type="date"
              className={inputCls}
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="text-dr3-mist-dim">Stripped — program (billed)</span>
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
            <span className="text-dr3-mist-dim">Stripped — non-program</span>
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
            <span className="text-dr3-mist-dim">Saved units (excl. from balance)</span>
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
            <span className="text-dr3-mist-dim">Material ticket #</span>
            <input
              className={inputCls}
              value={materialTicket}
              onChange={(e) => setMaterialTicket(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="text-dr3-mist-dim"># employees</span>
            <input
              type="number"
              min="0"
              className={inputCls}
              value={employees}
              onChange={(e) => setEmployees(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="text-dr3-mist-dim"># processors</span>
            <input
              type="number"
              min="0"
              className={inputCls}
              value={processors}
              onChange={(e) => setProcessors(e.target.value)}
            />
          </label>
          <label className={labelCls}>
            <span className="text-dr3-mist-dim">Pocketcoil estimate</span>
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
          <button
            type="button"
            disabled={!canSave || isBusy}
            onClick={save}
            className="rounded bg-dr3-cyan px-4 py-2 text-sm font-semibold text-dr3-space disabled:opacity-40"
          >
            {busy === 'save' ? 'Saving…' : 'Save entry'}
          </button>
          {message && (
            <span
              className={message.kind === 'ok' ? 'text-sm text-dr3-cyan' : 'text-sm text-red-400'}
            >
              {message.text}
            </span>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold">Recent days</h2>
        <p className="mt-1 text-xs text-dr3-mist-dim">
          Whole units sold + landfilled are DERIVED from the day&apos;s renovation outbound +
          landfilled rows — confirm them at close, they are never entered here.
        </p>
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-dr3-mist-dim">
            <tr>
              <th className="py-2">Date</th>
              <th className="py-2">Stripped P</th>
              <th className="py-2">Stripped NP</th>
              <th className="py-2">Total</th>
              <th className="py-2">Saved</th>
              <th className="py-2">Whole sold</th>
              <th className="py-2">Landfilled</th>
              <th className="py-2">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="py-4 text-dr3-mist-dim">
                  No entries yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-dr3-mist/10">
                <td className="py-2">{r.productionDate.toString().slice(0, 10)}</td>
                <td className="py-2">{r.strippedProgram}</td>
                <td className="py-2">{r.strippedNonProgram}</td>
                <td className="py-2 font-semibold">{r.totalStripped}</td>
                <td className="py-2">{r.savedUnits ?? '—'}</td>
                <td className="py-2">{r.derived.wholeUnitsSold.total}</td>
                <td className="py-2">{r.derived.landfilled.total}</td>
                <td className="py-2">{r.closedAt ? 'Closed' : 'Open'}</td>
                <td className="py-2">
                  {!r.closedAt && (
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => close(r.id)}
                      className="rounded border border-dr3-mist/30 px-3 py-1 text-xs hover:bg-dr3-mist/10 disabled:opacity-40"
                    >
                      {busy === r.id ? 'Closing…' : 'Close day'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
