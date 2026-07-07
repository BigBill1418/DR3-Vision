'use client';

// ADR-0048 D3 — Terex upload. Parsed server-side into equipment_events. onClick
// handler, not an HTML <form> (hard rule #10).

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SiteOption {
  code: string;
  name: string;
}

export function TerexUploadForm({ sites }: { sites: SiteOption[] }) {
  const router = useRouter();
  const [siteCode, setSiteCode] = useState(sites[0]?.code ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = busy || !file || !siteCode;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('siteCode', siteCode);
      const res = await fetch('/api/admin/equipment/import', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: { created: number; skipped: number; rowsParsed: number; imported: boolean }; error?: string; detail?: string }
        | null;
      if (!res.ok || !body?.ok) throw new Error(body?.detail ?? body?.error ?? `upload failed (${res.status})`);
      const r = body.result!;
      setMessage(
        r.imported
          ? `Imported ${r.rowsParsed} rows: ${r.created} events created, ${r.skipped} skipped (already present).`
          : 'Identical file already imported — no-op.',
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'upload failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4">
      <label className="block max-w-sm text-sm">
        <span className="mb-1 block text-gray-600">Site</span>
        <select
          value={siteCode}
          onChange={(e) => setSiteCode(e.target.value)}
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        >
          {sites.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-gray-600">Terex spreadsheet (.xlsx / .xlsm / .csv)</span>
        <input
          type="file"
          accept=".xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="text-sm"
        />
      </label>

      <button
        type="button"
        disabled={disabled}
        onClick={submit}
        className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Importing…' : 'Import Terex history'}
      </button>

      {message && <p className="text-sm text-emerald-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
