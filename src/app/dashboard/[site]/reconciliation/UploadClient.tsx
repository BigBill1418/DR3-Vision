'use client';

// Sprint-1 T-016 — upload widget for the monthly MyMRC CSV.
//
// CLAUDE.md hard rule #10 — no <form>, no submit handler. The file
// input + tolerance input + button live inside a section; the
// button's onClick handler builds a FormData and posts it via
// fetch(). On success we route to the per-session table page.
//
// Idempotency surfaces here as a friendly resume hint: if the API
// returns `created: false` (meaning the SHA-256 already exists for
// this site), the panel shows "this file was previously uploaded —
// open the existing session" with a link.

import { useRouter } from 'next/navigation';
import { useState } from 'react';

interface Props {
  siteCode: string;
}

interface UploadResponse {
  reconciliation_id: string;
  created: boolean;
  counts: {
    total: number;
    match_clean: number;
    weight_mismatch: number;
    count_mismatch: number;
    missing_in_dr3: number;
    missing_in_mymrc: number;
  };
  sha256: string;
}

export function UploadClient({ siteCode }: Props) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [tolerance, setTolerance] = useState<string>('2.0');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resumeHint, setResumeHint] = useState<{ id: string; sha256: string } | null>(null);

  const handleUpload = async () => {
    setError(null);
    setResumeHint(null);
    if (!file) {
      setError('Choose a CSV file before uploading.');
      return;
    }
    const tNum = Number(tolerance);
    if (!Number.isFinite(tNum) || tNum < 0 || tNum > 100) {
      setError('Tolerance must be a number between 0 and 100.');
      return;
    }

    const fd = new FormData();
    fd.append('file', file);
    fd.append('tolerance_pct', tolerance);

    setPending(true);
    try {
      const res = await fetch(`/api/reconciliation/${siteCode}/upload`, {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(body.detail ?? body.error ?? 'Upload failed.');
        return;
      }
      const body = (await res.json()) as UploadResponse;
      if (!body.created) {
        setResumeHint({ id: body.reconciliation_id, sha256: body.sha256 });
        return;
      }
      router.push(`/dashboard/${siteCode}/reconciliation/${body.reconciliation_id}`);
      router.refresh();
    } catch (uploadErr) {
      setError(uploadErr instanceof Error ? uploadErr.message : 'Upload failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 rounded-md bg-dr3-green-dark/30 p-5"
      data-testid="reconciliation-upload"
    >
      <header>
        <h2 className="text-lg font-semibold text-dr3-cream">Upload monthly CSV</h2>
        <p className="text-xs text-dr3-cream/70">
          Pull the latest monthly export from MyMRC and drop it here. Uploads are deduplicated by
          file content — re-uploading the same file routes you to the existing session.
        </p>
      </header>

      {error ? (
        <p
          className="rounded-md bg-red-900/40 px-4 py-2 text-sm text-red-100"
          role="alert"
          data-testid="reconciliation-upload-error"
        >
          {error}
        </p>
      ) : null}

      {resumeHint ? (
        <p
          className="rounded-md bg-amber-900/40 px-4 py-2 text-sm text-amber-100"
          data-testid="reconciliation-upload-resume"
        >
          This file has been processed already. Open the existing session:{' '}
          <a
            href={`/dashboard/${siteCode}/reconciliation/${resumeHint.id}`}
            className="font-semibold underline-offset-4 hover:underline"
          >
            resume
          </a>
          .
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-dr3-cream/80">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="rounded-md bg-dr3-green-dark/40 px-3 py-2 text-sm text-dr3-cream file:mr-3 file:rounded file:border-0 file:bg-dr3-chartreuse file:px-3 file:py-1 file:text-sm file:font-semibold file:text-dr3-ink"
            data-testid="reconciliation-file-input"
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium text-dr3-cream/80">Weight tolerance (%)</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            max="100"
            step="0.1"
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className="rounded-md bg-dr3-green-dark/40 px-3 py-2 text-dr3-cream focus:outline-none focus:ring-2 focus:ring-dr3-chartreuse"
            data-testid="reconciliation-tolerance-input"
          />
        </label>
      </div>

      <div>
        <button
          type="button"
          onClick={handleUpload}
          disabled={pending || !file}
          className="inline-flex items-center gap-2 rounded-md bg-dr3-chartreuse px-4 py-2 text-sm font-semibold text-dr3-ink transition-colors hover:bg-dr3-chartreuse/90 disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="reconciliation-upload-submit"
        >
          {pending ? 'Uploading…' : 'Upload and reconcile'}
        </button>
      </div>
    </section>
  );
}
