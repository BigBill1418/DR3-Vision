'use client';

// ADR-0046 Amendment 5 (D-M5-4) — baseline import client. Two-step: Preview (POST
// the picked file-drop id → parsed rows, no write) then Confirm (POST the reviewed
// rows → history + rebuild). The admin can drop individual rows before confirming.
// No <form> submits — explicit onClick, re-validated server-side.

import { useCallback, useState } from 'react';

export interface FileDropOption {
  id: string;
  filename: string;
  byteSize: number;
  createdISO: string;
  downloadable: boolean;
}

interface PreviewRow {
  vendorName: string;
  invoiceDate: string;
  invoiceAmountCents: number;
  siteCode: string | null;
}

const usd = (cents: number): string =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function BaselineImportClient({ fileDrops }: { fileDrops: FileDropOption[] }) {
  const [selectedId, setSelectedId] = useState('');
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [source, setSource] = useState<string>('');
  const [unparsedCount, setUnparsedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const preview = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    setDone(null);
    setRows(null);
    try {
      const res = await fetch('/api/admin/ap/baselines/import/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileDropId: selectedId }),
      });
      const b = (await res.json().catch(() => ({}))) as {
        rows?: PreviewRow[];
        source?: string;
        unparsedCount?: number;
        error?: string;
      };
      if (!res.ok) {
        setMsg(b.error ?? `Preview failed (${res.status})`);
      } else {
        setRows(b.rows ?? []);
        setSource(b.source ?? '');
        setUnparsedCount(b.unparsedCount ?? 0);
      }
    } catch {
      setMsg('Network error');
    } finally {
      setBusy(false);
    }
  }, [selectedId]);

  const dropRow = useCallback((i: number) => {
    setRows((prev) => (prev ? prev.filter((_, idx) => idx !== i) : prev));
  }, []);

  const confirm = useCallback(async () => {
    if (!rows || rows.length === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/admin/ap/baselines/import/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fileDropId: selectedId, rows }),
      });
      const b = (await res.json().catch(() => ({}))) as {
        historyRowsWritten?: number;
        vendorsComputed?: number;
        rejected?: number;
        error?: string;
      };
      if (!res.ok) {
        setMsg(b.error ?? `Import failed (${res.status})`);
      } else {
        setDone(
          `Imported ${b.historyRowsWritten ?? 0} rows → ${b.vendorsComputed ?? 0} vendor baselines` +
            (b.rejected ? ` (${b.rejected} rejected)` : '') +
            '.',
        );
        setRows(null);
      }
    } catch {
      setMsg('Network error');
    } finally {
      setBusy(false);
    }
  }, [rows, selectedId]);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700">
          <span className="mb-1 block font-medium">AP-report PDF</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="w-96 max-w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            <option value="">Select a file-drop…</option>
            {fileDrops.map((d) => (
              <option key={d.id} value={d.id} disabled={!d.downloadable}>
                {d.filename} · {(d.byteSize / 1024).toFixed(0)} KB · {d.createdISO.slice(0, 10)}
                {d.downloadable ? '' : ' (not stored)'}
              </option>
            ))}
          </select>
        </label>
        <button
          onClick={preview}
          disabled={busy || !selectedId}
          className="rounded bg-gray-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-900 disabled:opacity-50"
        >
          {busy ? 'Parsing…' : 'Preview'}
        </button>
      </div>

      {fileDrops.length === 0 && (
        <p className="mt-3 text-sm text-amber-700">
          No PDF file-drops found. Ask Bill to upload the AP report to /admin/file-drop first.
        </p>
      )}
      {msg && <p className="mt-3 text-sm text-red-600">{msg}</p>}
      {done && <p className="mt-3 text-sm font-medium text-emerald-700">{done}</p>}

      {rows && (
        <div className="mt-6">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-gray-600">
              {rows.length} row{rows.length === 1 ? '' : 's'} parsed (source: {source})
              {unparsedCount > 0 ? ` · ${unparsedCount} lines could not be parsed` : ''}
            </div>
            <button
              onClick={confirm}
              disabled={busy || rows.length === 0}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy ? 'Importing…' : `Confirm import (${rows.length})`}
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-2">Vendor</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2">Site</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.vendorName}-${i}`} className="border-t border-gray-100">
                    <td className="px-3 py-1.5">{r.vendorName}</td>
                    <td className="px-3 py-1.5 tabular-nums text-gray-600">{r.invoiceDate}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{usd(r.invoiceAmountCents)}</td>
                    <td className="px-3 py-1.5 text-gray-600">{r.siteCode ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right">
                      <button
                        onClick={() => dropRow(i)}
                        className="text-xs text-red-600 hover:underline"
                      >
                        Drop
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
