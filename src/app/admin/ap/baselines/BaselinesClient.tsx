'use client';

// ADR-0046 Amendment 5 (D-M5-4) — baseline management client. Per-vendor override
// editing (flat $ / percent %) with a Save that PATCHes one baseline, and an
// on-demand "Refresh baselines" button (POST rebuild) that re-pulls the table. No
// <form> submits — every mutation is an explicit onClick, re-validated server-side.

import { useCallback, useState } from 'react';

export interface BaselineRow {
  vendorNameNormalized: string;
  vendorDisplayName: string;
  invoiceCount: number;
  established: boolean;
  meanAmountCents: number;
  medianAmountCents: number;
  minAmountCents: number;
  maxAmountCents: number;
  stddevAmountCents: number | null;
  varianceFlatOverrideCents: number | null;
  variancePercentOverride: number | null;
  computedAtISO: string;
}

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

function OverrideEditor({ row, onSaved }: { row: BaselineRow; onSaved: () => void }) {
  // Flat override edited in DOLLARS; percent override edited as a PERCENT (6.25).
  const [flat, setFlat] = useState(
    row.varianceFlatOverrideCents != null ? (row.varianceFlatOverrideCents / 100).toString() : '',
  );
  const [pct, setPct] = useState(
    row.variancePercentOverride != null ? (row.variancePercentOverride * 100).toString() : '',
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = useCallback(async () => {
    setBusy(true);
    setMsg(null);
    const flatOverrideCents = flat.trim() === '' ? null : Math.round(Number(flat) * 100);
    const percentOverride = pct.trim() === '' ? null : Number(pct) / 100;
    if (flatOverrideCents !== null && (!Number.isFinite(flatOverrideCents) || flatOverrideCents < 0)) {
      setBusy(false);
      setMsg('Flat must be a non-negative dollar amount.');
      return;
    }
    if (percentOverride !== null && (!Number.isFinite(percentOverride) || percentOverride <= 0 || percentOverride > 1)) {
      setBusy(false);
      setMsg('Percent must be > 0 and ≤ 100.');
      return;
    }
    try {
      const res = await fetch(`/api/admin/ap/baselines/${encodeURIComponent(row.vendorNameNormalized)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flatOverrideCents, percentOverride }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setMsg(b.error ?? `Save failed (${res.status})`);
      } else {
        setMsg('Saved');
        onSaved();
      }
    } catch {
      setMsg('Network error');
    } finally {
      setBusy(false);
    }
  }, [flat, pct, row.vendorNameNormalized, onSaved]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-xs text-gray-600">
        $
        <input
          value={flat}
          onChange={(e) => setFlat(e.target.value)}
          inputMode="decimal"
          placeholder="50"
          className="w-16 rounded border border-gray-300 px-1 py-0.5 text-right text-sm"
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-600">
        <input
          value={pct}
          onChange={(e) => setPct(e.target.value)}
          inputMode="decimal"
          placeholder="15"
          className="w-14 rounded border border-gray-300 px-1 py-0.5 text-right text-sm"
        />
        %
      </label>
      <button
        onClick={save}
        disabled={busy}
        className="rounded bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {busy ? '…' : 'Save'}
      </button>
      {msg && <span className="text-xs text-gray-500">{msg}</span>}
    </div>
  );
}

export function BaselinesClient({ initial }: { initial: BaselineRow[] }) {
  const [rows, setRows] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch('/api/admin/ap/baselines');
    if (res.ok) {
      const b = (await res.json()) as { baselines: BaselineRow[] };
      setRows(b.baselines);
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setNote(null);
    try {
      const res = await fetch('/api/admin/ap/baselines/refresh', { method: 'POST' });
      const b = (await res.json().catch(() => ({}))) as { vendorsComputed?: number; error?: string };
      setNote(res.ok ? `Rebuilt ${b.vendorsComputed ?? 0} vendor baselines.` : (b.error ?? 'Refresh failed'));
      if (res.ok) await reload();
    } catch {
      setNote('Network error');
    } finally {
      setRefreshing(false);
    }
  }, [reload]);

  return (
    <div>
      <div className="mb-3 flex items-center gap-3">
        <button
          onClick={refresh}
          disabled={refreshing}
          className="rounded bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-900 disabled:opacity-50"
        >
          {refreshing ? 'Rebuilding…' : 'Refresh baselines'}
        </button>
        {note && <span className="text-sm text-gray-600">{note}</span>}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2 text-right">Count</th>
              <th className="px-3 py-2 text-right">Mean</th>
              <th className="px-3 py-2 text-right">Median</th>
              <th className="px-3 py-2 text-right">Min / Max</th>
              <th className="px-3 py-2">Override (flat / %)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-gray-500">
                  No baselines yet — import an AP report to populate them.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.vendorNameNormalized} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{r.vendorDisplayName}</div>
                    <div className="text-xs text-gray-500">
                      {r.established ? (
                        <span className="text-emerald-700">established</span>
                      ) : (
                        <span className="text-amber-700">insufficient data (&lt; 3)</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.invoiceCount}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(r.meanAmountCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{usd(r.medianAmountCents)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                    {usd(r.minAmountCents)} / {usd(r.maxAmountCents)}
                  </td>
                  <td className="px-3 py-2">
                    <OverrideEditor row={r} onSaved={reload} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
