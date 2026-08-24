'use client';

// ADR-0125 — the source-classifier editor. CLAUDE.md hard rule #10: every
// control is an onClick/onChange handler, never an HTML <form>.
//
// Each row saves ON ITS OWN. A single "save all" button would send four
// classifiers for every source in the list, so an unrelated stale row on screen
// would silently overwrite a change somebody else made — and these columns move
// invoice lines.

import { useMemo, useState } from 'react';

export interface SourceRow {
  id: string;
  siteId: string;
  siteCode: string;
  name: string;
  city: string | null;
  state: string | null;
  isActive: boolean;
  isNonProgram: boolean;
  isTransCharge: boolean;
  canonicalMileage: number | null;
  haulAssignment: 'primary' | 'secondary' | 'tertiary' | null;
}

const inputCls = 'rounded border border-white/20 bg-black/30 px-2 py-1.5 text-sm text-white';
const ASSIGNMENTS = ['primary', 'secondary', 'tertiary'] as const;

export function SourcesClient({ rows }: { rows: SourceRow[] }) {
  const [all, setAll] = useState<SourceRow[]>(rows);
  const [site, setSite] = useState<string>('all');
  const [query, setQuery] = useState('');

  const siteCodes = useMemo(() => [...new Set(rows.map((r) => r.siteCode))].sort(), [rows]);
  const shown = all.filter(
    (r) =>
      (site === 'all' || r.siteCode === site) &&
      (query.trim() === '' || r.name.toLowerCase().includes(query.trim().toLowerCase())),
  );

  const patch = (next: SourceRow) =>
    setAll((prev) => prev.map((r) => (r.id === next.id ? next : r)));

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">Site</span>
          <select className={inputCls} value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="all">All sites</option>
            {siteCodes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="opacity-70">Search</span>
          <input
            className={inputCls}
            value={query}
            placeholder="source name"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span className="pb-2 text-xs text-dr3-mist-dim">
          {shown.length} of {all.length}
        </span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[56rem] text-left text-sm">
          <thead className="text-dr3-mist-dim">
            <tr>
              <th className="py-2">Source</th>
              <th className="py-2">Site</th>
              <th className="py-2">Non-program</th>
              <th className="py-2">Trans charge</th>
              <th className="py-2">Mileage</th>
              <th className="py-2">Haul assignment</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="py-4 text-dr3-mist-dim">
                  No sources match.
                </td>
              </tr>
            )}
            {shown.map((r) => (
              <SourceEditor key={r.id} row={r} onSaved={patch} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceEditor({ row, onSaved }: { row: SourceRow; onSaved: (next: SourceRow) => void }) {
  const [nonProgram, setNonProgram] = useState(row.isNonProgram);
  const [transCharge, setTransCharge] = useState(row.isTransCharge);
  const [mileage, setMileage] = useState(
    row.canonicalMileage === null ? '' : String(row.canonicalMileage),
  );
  const [assignment, setAssignment] = useState<string>(row.haulAssignment ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const mileageValue = mileage.trim() === '' ? null : Number(mileage);
  const mileageBad = mileageValue !== null && (!Number.isInteger(mileageValue) || mileageValue < 0);

  const dirty =
    nonProgram !== row.isNonProgram ||
    transCharge !== row.isTransCharge ||
    mileageValue !== row.canonicalMileage ||
    (assignment === '' ? null : assignment) !== row.haulAssignment;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/sources', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceId: row.id,
          isNonProgram: nonProgram,
          isTransCharge: transCharge,
          canonicalMileage: mileageValue,
          haulAssignment: assignment === '' ? null : assignment,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg({ kind: 'err', text: err.error ?? `Save failed (${res.status}).` });
        return;
      }
      const data = (await res.json()) as { row: SourceRow };
      onSaved(data.row);
      setMsg({ kind: 'ok', text: 'Saved.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-t border-white/10">
      <td className="py-2">
        <span className="font-medium">{row.name}</span>
        {(row.city || row.state) && (
          <span className="ml-2 text-xs text-dr3-mist-dim">
            {[row.city, row.state].filter(Boolean).join(', ')}
          </span>
        )}
        {!row.isActive && <span className="ml-2 text-xs text-amber-300">inactive</span>}
      </td>
      <td className="py-2 text-dr3-mist-dim">{row.siteCode}</td>
      <td className="py-2">
        <input
          type="checkbox"
          aria-label={`Non-program: ${row.name}`}
          checked={nonProgram}
          onChange={(e) => setNonProgram(e.target.checked)}
        />
      </td>
      <td className="py-2">
        <input
          type="checkbox"
          aria-label={`Trans charge: ${row.name}`}
          checked={transCharge}
          onChange={(e) => setTransCharge(e.target.checked)}
        />
      </td>
      <td className="py-2">
        <input
          type="number"
          min="0"
          aria-label={`Mileage: ${row.name}`}
          className={`${inputCls} w-24`}
          value={mileage}
          onChange={(e) => setMileage(e.target.value)}
        />
      </td>
      <td className="py-2">
        <select
          aria-label={`Haul assignment: ${row.name}`}
          className={inputCls}
          value={assignment}
          onChange={(e) => setAssignment(e.target.value)}
        >
          {/* Blank is a real value: "not yet loaded from the Mileage_Table".
              It is never backfilled to `primary`, because a fabricated
              assignment is indistinguishable from a real one. */}
          <option value="">— not set —</option>
          {ASSIGNMENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2">
        <button
          type="button"
          disabled={!dirty || mileageBad || busy}
          onClick={save}
          className="rounded bg-dr3-cyan px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <span className={`ml-2 text-xs ${msg.kind === 'ok' ? 'text-dr3-cyan' : 'text-red-300'}`}>
            {msg.text}
          </span>
        )}
      </td>
    </tr>
  );
}
