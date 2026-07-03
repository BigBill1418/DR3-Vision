'use client';

// ADR-0039 D4 — admin workbook upload. Parsed server-side; only staging rows +
// findings persist. onClick handler, not an HTML <form> (hard rule #10).

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface SiteOption {
  code: string;
  name: string;
}

export function WorkbookUploadForm({ sites }: { sites: SiteOption[] }) {
  const router = useRouter();
  const [siteCode, setSiteCode] = useState(sites[0]?.code ?? '');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [periodLabel, setPeriodLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disabled = busy || !file || !siteCode || !windowStart || !windowEnd;

  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('siteCode', siteCode);
      fd.set('windowStart', windowStart);
      fd.set('windowEnd', windowEnd);
      if (periodLabel) fd.set('periodLabel', periodLabel);
      const res = await fetch('/api/admin/audit/workbook', { method: 'POST', body: fd });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; templateGeneration?: string; rowCount?: number; findingsOpened?: number; error?: string; detail?: string }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(body?.detail ?? body?.error ?? `upload failed (${res.status})`);
      }
      setMessage(
        `Imported (${body.templateGeneration} template): ${body.rowCount} staging rows, ${body.findingsOpened} findings opened.`,
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
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
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
        <label className="text-sm">
          <span className="mb-1 block text-gray-600">Period label (optional)</span>
          <input
            type="text"
            value={periodLabel}
            onChange={(e) => setPeriodLabel(e.target.value)}
            placeholder="e.g. June 2026"
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-gray-600">Window start</span>
          <input
            type="date"
            value={windowStart}
            onChange={(e) => setWindowStart(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-gray-600">Window end (exclusive)</span>
          <input
            type="date"
            value={windowEnd}
            onChange={(e) => setWindowEnd(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="block text-sm">
        <span className="mb-1 block text-gray-600">Workbook (.xlsx / .xlsm)</span>
        <input
          type="file"
          accept=".xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
        {busy ? 'Importing…' : 'Import & audit'}
      </button>

      {message && <p className="text-sm text-emerald-700">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
