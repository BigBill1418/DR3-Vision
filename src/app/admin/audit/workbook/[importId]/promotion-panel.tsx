'use client';

// ADR-0048 D5 — promotion panel. Dry-run preview first (counts per table +
// conflicts + recomputed close), then commit. onClick handlers, not an HTML
// <form> (hard rule #10).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BackfillScopeConfig } from '@/lib/audit/backfill-scopes';

interface Counts {
  processed_units_daily: number;
  inbound_loads: number;
  outbound_materials: number;
  landfilled_units: number;
  consumer_dropoffs: number;
  site_inventory_snapshots: number;
}
interface Conflict {
  table: string;
  dates: string[];
}
interface Preview {
  alreadyPromoted: boolean;
  counts: Counts;
  clippedRowCount: number;
  conflicts: Conflict[];
  computedClose: { program: string; nonProgram: string; total: string };
  expectedCloseTotal: number | null;
  balanceOk: boolean;
}

export function PromotionPanel({ importId, scopes }: { importId: string; scopes: BackfillScopeConfig[] }) {
  const router = useRouter();
  const [scopeKey, setScopeKey] = useState(scopes[0]?.key ?? '');
  const [busy, setBusy] = useState<false | 'preview' | 'promote'>(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const selected = scopes.find((s) => s.key === scopeKey) ?? scopes[0];

  async function call(dryRun: boolean) {
    setBusy(dryRun ? 'preview' : 'promote');
    setError(null);
    if (dryRun) setDone(null);
    try {
      const res = await fetch(`/api/admin/audit/workbook/${importId}/promote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scopeKey, dryRun }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; preview?: Preview; result?: { counts: Counts; computedClose?: { total: string } }; error?: string; conflicts?: Conflict[]; names?: string[] }
        | null;
      if (!res.ok || !body?.ok) {
        const extra = body?.conflicts
          ? ` — conflicts: ${body.conflicts.map((c) => `${c.table}[${c.dates.join(',')}]`).join('; ')}`
          : body?.names
            ? ` — unresolved sources: ${body.names.join(', ')}`
            : '';
        throw new Error((body?.error ?? `request failed (${res.status})`) + extra);
      }
      if (dryRun && body.preview) {
        setPreview(body.preview);
      } else if (body.result) {
        setDone(`Promoted. Recomputed close: ${body.result.computedClose?.total ?? '—'}.`);
        setPreview(null);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  const canPromote =
    preview !== null && !preview.alreadyPromoted && preview.conflicts.length === 0 && preview.balanceOk;

  return (
    <div className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <label className="block text-sm">
        <span className="mb-1 block text-gray-600">Scope</span>
        <select
          value={scopeKey}
          onChange={(e) => {
            setScopeKey(e.target.value);
            setPreview(null);
          }}
          className="w-full max-w-sm rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          {scopes.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label} ({s.from} → {s.to})
              {s.expectedCloseTotal !== null ? ` · close ${s.expectedCloseTotal}` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-3">
        <button
          type="button"
          disabled={busy !== false || !scopeKey}
          onClick={() => call(true)}
          className="rounded border border-emerald-700 px-4 py-2 text-sm font-medium text-emerald-700 disabled:opacity-50"
        >
          {busy === 'preview' ? 'Previewing…' : 'Dry-run preview'}
        </button>
        <button
          type="button"
          disabled={busy !== false || !canPromote}
          onClick={() => call(false)}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy === 'promote' ? 'Promoting…' : 'Promote'}
        </button>
      </div>

      {preview && (
        <div className="rounded border border-gray-200 bg-gray-50 p-3 text-sm">
          <table className="w-full text-left">
            <tbody>
              {Object.entries(preview.counts).map(([table, n]) => (
                <tr key={table} className="border-b border-gray-100 last:border-0">
                  <td className="py-1 font-mono text-xs text-gray-700">{table}</td>
                  <td className="py-1 text-right tabular-nums">{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.clippedRowCount > 0 && (
            <p className="mt-2 text-xs text-gray-500">{preview.clippedRowCount} row(s) clipped (outside the scope window).</p>
          )}
          <p className="mt-2">
            Recomputed close: <strong>{preview.computedClose.total}</strong>
            {selected?.expectedCloseTotal !== null && selected !== undefined && (
              <span className={preview.balanceOk ? ' text-emerald-700' : ' text-red-600'}>
                {' '}
                (expected {preview.expectedCloseTotal}
                {preview.balanceOk ? ' ✓' : ' ✗ — commit will refuse'})
              </span>
            )}
          </p>
          {preview.conflicts.length > 0 && (
            <p className="mt-2 text-red-600">
              Conflicts (live rows in window — promotion refuses):{' '}
              {preview.conflicts.map((c) => `${c.table}[${c.dates.join(', ')}]`).join('; ')}
            </p>
          )}
          {preview.alreadyPromoted && <p className="mt-2 text-emerald-700">Already promoted — re-run would be a no-op.</p>}
        </div>
      )}

      {done && <p className="text-sm font-medium text-emerald-700">{done}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
