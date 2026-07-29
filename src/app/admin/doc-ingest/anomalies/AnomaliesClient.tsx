'use client';

// ADR-0067 §3.4 / D7 — the anomaly review client.
//
// Split into two lists on purpose:
//   HELD FOR REVIEW — a staged revision is waiting; APPLY or DISCARD moves data.
//   OTHER ANOMALIES — access lost, subscriptions, unclassified. Nothing to apply;
//                     acknowledge or resolve once the underlying thing is fixed.
//
// Conflating them would put a harmless "waiting for confirmation" notice next to
// a held billing revision with the same two buttons, and the two demand very
// different attention.
//
// Hard rule #10: no `<form>` — every action is an onClick.

import { useCallback, useMemo, useState } from 'react';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import type { AnomalyRow } from '@/lib/doc-ingest/health';

interface SheetLike {
  name: string;
  rowCount: number;
  populatedColumns?: string[];
  numericTotals?: Record<string, number>;
}

function summarize(value: unknown): string {
  if (value === null || value === undefined) return '—';
  const obj = value as { totalRows?: number; sheets?: SheetLike[] };
  if (typeof obj.totalRows !== 'number' || !Array.isArray(obj.sheets)) return '—';
  const sheets = obj.sheets
    .map((s) => `${s.name}: ${s.rowCount} rows`)
    .slice(0, 6)
    .join(' · ');
  return `${obj.totalRows} rows total${sheets ? ` — ${sheets}` : ''}`;
}

function fmt(iso: string): string {
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-red-500/15 text-red-300 ring-red-500/30',
  warning: 'bg-amber-400/15 text-amber-300 ring-amber-400/30',
  info: 'bg-dr3-cyan/15 text-dr3-cyan ring-dr3-cyan/30',
};

export function AnomaliesClient({ initialAnomalies }: { initialAnomalies: AnomalyRow[] }) {
  const [rows, setRows] = useState(initialAnomalies);
  const [showResolved, setShowResolved] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (resolved: boolean) => {
    const res = await fetch(`/api/admin/doc-ingest/anomalies${resolved ? '?resolved=1' : ''}`, {
      cache: 'no-store',
    });
    if (!res.ok) return;
    const body = (await res.json()) as { anomalies: AnomalyRow[] };
    setRows(body.anomalies);
  }, []);

  const post = useCallback(
    async (payload: Record<string, unknown>, key: string) => {
      setPending(key);
      setError(null);
      try {
        const res = await fetch('/api/admin/doc-ingest/anomalies', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          setError(M.sources.saveFailed);
          return;
        }
        await refresh(showResolved);
      } catch {
        setError(M.sources.saveFailed);
      } finally {
        setPending(null);
      }
    },
    [refresh, showResolved],
  );

  const staged = useMemo(() => rows.filter((r) => r.staged && r.versionId), [rows]);
  const others = useMemo(() => rows.filter((r) => !(r.staged && r.versionId)), [rows]);

  return (
    <div className="flex flex-col gap-10">
      {error ? (
        <p className="rounded-md bg-red-500/10 px-4 py-3 text-sm text-red-300 ring-1 ring-red-500/30">
          {error}
        </p>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">
          {M.anomalies.stagedHeading}
          {staged.length > 0 ? ` (${staged.length})` : ''}
        </h2>
        {staged.length === 0 ? (
          <p className="text-sm text-dr3-mist-dim">{M.anomalies.empty}</p>
        ) : (
          <ul className="flex flex-col gap-4">
            {staged.map((a) => (
              <li
                key={a.id}
                className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ring-1 ${SEVERITY_STYLE[a.severity] ?? ''}`}
                  >
                    {a.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="font-medium">{a.sourceName ?? '—'}</span>
                  <span className="text-xs text-dr3-mist-dim">
                    {M.anomalies.occurrences} {a.occurrences} {M.anomalies.times} ·{' '}
                    {fmt(a.lastSeenISO)}
                  </span>
                </div>

                <p className="mt-2 text-sm">{a.detail}</p>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="rounded bg-dr3-space/60 p-3">
                    <p className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                      {M.anomalies.before}
                    </p>
                    <p className="mt-1 text-sm">{summarize(a.before)}</p>
                  </div>
                  <div className="rounded bg-dr3-space/60 p-3">
                    <p className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                      {M.anomalies.after}
                    </p>
                    <p className="mt-1 text-sm">{summarize(a.after)}</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={pending === a.id}
                    onClick={() => void post({ action: 'apply', versionId: a.versionId }, a.id)}
                    className="rounded bg-emerald-400/15 px-3 py-1 text-sm text-emerald-300 ring-1 ring-emerald-400/40 disabled:opacity-40"
                  >
                    {M.anomalies.apply}
                  </button>
                  <input
                    aria-label={M.anomalies.discardReason}
                    placeholder={M.anomalies.discardReason}
                    value={notes[a.id] ?? ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                    className="min-w-56 flex-1 rounded bg-dr3-space px-2 py-1 text-sm ring-1 ring-dr3-steel-light/30"
                  />
                  <button
                    type="button"
                    disabled={pending === a.id || !(notes[a.id] ?? '').trim()}
                    onClick={() =>
                      void post(
                        {
                          action: 'discard',
                          versionId: a.versionId,
                          note: (notes[a.id] ?? '').trim(),
                        },
                        a.id,
                      )
                    }
                    className="rounded bg-red-500/15 px-3 py-1 text-sm text-red-300 ring-1 ring-red-500/40 disabled:opacity-40"
                  >
                    {M.anomalies.discard}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">{M.anomalies.otherHeading}</h2>
          <button
            type="button"
            onClick={() => {
              const next = !showResolved;
              setShowResolved(next);
              void refresh(next);
            }}
            className="rounded px-2 py-1 text-xs text-dr3-mist-dim ring-1 ring-dr3-steel-light/30 hover:text-dr3-cyan"
          >
            {showResolved ? M.anomalies.hideResolved : M.anomalies.showResolved}
          </button>
        </div>

        {others.length === 0 ? (
          <p className="text-sm text-dr3-mist-dim">{M.anomalies.empty}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {others.map((a) => (
              <li
                key={a.id}
                className="rounded-lg bg-dr3-steel/10 p-3 ring-1 ring-dr3-steel-light/15"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ring-1 ${SEVERITY_STYLE[a.severity] ?? ''}`}
                  >
                    {a.kind.replace(/_/g, ' ')}
                  </span>
                  {a.sourceName ? <span className="text-sm">{a.sourceName}</span> : null}
                  <span className="text-xs text-dr3-mist-dim">
                    {a.status} · {M.anomalies.occurrences} {a.occurrences} {M.anomalies.times} ·{' '}
                    {fmt(a.lastSeenISO)}
                  </span>
                </div>
                <p className="mt-1 text-sm text-dr3-mist-dim">{a.detail}</p>
                {a.status !== 'resolved' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={pending === a.id}
                      onClick={() => void post({ action: 'acknowledge', anomalyId: a.id }, a.id)}
                      className="rounded px-2 py-1 text-xs text-dr3-mist-dim ring-1 ring-dr3-steel-light/30 hover:text-dr3-cyan disabled:opacity-40"
                    >
                      {M.anomalies.acknowledge}
                    </button>
                    <input
                      aria-label={M.anomalies.resolveNote}
                      placeholder={M.anomalies.resolveNote}
                      value={notes[a.id] ?? ''}
                      onChange={(e) => setNotes((n) => ({ ...n, [a.id]: e.target.value }))}
                      className="min-w-56 flex-1 rounded bg-dr3-space px-2 py-1 text-xs ring-1 ring-dr3-steel-light/30"
                    />
                    <button
                      type="button"
                      disabled={pending === a.id || !(notes[a.id] ?? '').trim()}
                      onClick={() =>
                        void post(
                          { action: 'resolve', anomalyId: a.id, note: (notes[a.id] ?? '').trim() },
                          a.id,
                        )
                      }
                      className="rounded px-2 py-1 text-xs text-emerald-300 ring-1 ring-emerald-400/40 disabled:opacity-40"
                    >
                      {M.anomalies.resolve}
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
