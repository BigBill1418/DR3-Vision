'use client';

// ADR-0108 — the editing control for one commodity's look-at-this band.
//
// Deliberately plain. Four numbers and a switch, each with the effect restated
// underneath in pounds as you type, because "k = 6" means nothing and
// "1,237 lb – 13,923 lb" means everything to the person deciding whether the
// line is in the right place.
//
// Per hard rule #10 there is NO HTML `<form>`: every control is a handler.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface VarianceBoundRow {
  id: string;
  commodity: string;
  enabled: boolean;
  medianLbs: number;
  spreadRatio: number;
  k: number;
  sampleN: number;
  minSampleN: number;
  lowLbs: number | null;
  highLbs: number | null;
  inactiveReason: 'turned_off' | 'too_few_observations' | 'no_spread' | null;
}

function lbs(n: number): string {
  return `${Math.round(n).toLocaleString()} lb`;
}

/** The same arithmetic the reader uses, so the preview cannot drift from it. */
function band(medianLbs: number, spreadRatio: number, k: number): [number, number] | null {
  if (!(spreadRatio > 1) || !(medianLbs > 0) || !(k > 0)) return null;
  const span = Math.pow(spreadRatio, k);
  return [medianLbs / span, medianLbs * span];
}

export function VarianceBoundsClient({ rows }: { rows: VarianceBoundRow[] }) {
  return (
    <div className="mt-6 space-y-3">
      {rows.map((r) => (
        <BoundEditor key={r.id} row={r} />
      ))}
    </div>
  );
}

function BoundEditor({ row }: { row: VarianceBoundRow }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(row.enabled);
  const [medianLbs, setMedianLbs] = useState(String(row.medianLbs));
  const [spreadRatio, setSpreadRatio] = useState(String(row.spreadRatio));
  const [k, setK] = useState(String(row.k));
  const [minSampleN, setMinSampleN] = useState(String(row.minSampleN));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const nMedian = Number(medianLbs);
  const nRatio = Number(spreadRatio);
  const nK = Number(k);
  const nMinN = Number(minSampleN);
  const preview = band(nMedian, nRatio, nK);
  const belowFloor = row.sampleN < nMinN;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch('/api/admin/doc-ingest/outbound-variance', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: row.id,
          enabled,
          medianLbs: nMedian,
          spreadRatio: nRatio,
          k: nK,
          minSampleN: nMinN,
        }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const reason =
          typeof body === 'object' && body !== null && 'error' in body
            ? String((body as { error: unknown }).error)
            : `http_${res.status}`;
        setError(reason);
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError('network_error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20"
      data-testid="variance-bound-editor"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold">{row.commodity}</h3>
        <span className="text-xs text-dr3-mist-dim">
          seeded from {row.sampleN.toLocaleString()} load
          {row.sampleN === 1 ? '' : 's'} carrying this commodity
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="Typical weight (lb)" value={medianLbs} onChange={setMedianLbs} step="1" />
        <Field label="Spread step (×)" value={spreadRatio} onChange={setSpreadRatio} step="0.001" />
        <Field label="Steps out (k)" value={k} onChange={setK} step="0.5" />
        <Field label="Min loads to flag" value={minSampleN} onChange={setMinSampleN} step="1" />
        <div>
          <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">Flagging</div>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`mt-1 w-full rounded-md px-3 py-2 text-sm ring-1 ${
              enabled
                ? 'bg-dr3-cyan/20 text-dr3-cyan ring-dr3-cyan/40'
                : 'bg-dr3-steel/40 text-dr3-mist-dim ring-dr3-steel-light/25'
            }`}
            data-testid="variance-bound-toggle"
          >
            {enabled ? 'on' : 'off'}
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs text-dr3-mist-dim" data-testid="variance-bound-preview">
        {!enabled ? (
          <>Flagging is off for {row.commodity}. Its loads are shown with no band applied.</>
        ) : belowFloor ? (
          <>
            Not flagged: {row.sampleN} recorded load{row.sampleN === 1 ? '' : 's'} is below the{' '}
            {nMinN} needed to say what a normal weight looks like. Nothing is being claimed about
            these loads either way.
          </>
        ) : preview === null ? (
          <>
            No band: a spread step of {spreadRatio} leaves no width to measure against, so every
            load would sit on the line. Flagging stays off until the step is above 1.
          </>
        ) : (
          <>
            Loads outside <strong>{lbs(preview[0])}</strong> – <strong>{lbs(preview[1])}</strong>{' '}
            will be marked for a look. Inside that range, nothing is marked.
          </>
        )}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-dr3-cyan/20 px-4 py-1.5 text-sm text-dr3-cyan ring-1 ring-dr3-cyan/40 disabled:opacity-50"
          data-testid="variance-bound-save"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-xs text-emerald-300">Saved.</span>}
        {error && (
          <span className="text-xs text-amber-300" data-testid="variance-bound-error">
            Could not save ({error}).
          </span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  step,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  step: string;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md bg-dr3-space px-3 py-2 text-sm tabular-nums text-dr3-mist ring-1 ring-dr3-steel-light/25"
      />
    </div>
  );
}
