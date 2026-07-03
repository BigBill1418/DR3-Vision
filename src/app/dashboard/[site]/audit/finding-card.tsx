'use client';

// ADR-0039 — one findings-queue row: expand to see expected/actual + provenance,
// then classify (cause) + note + transition status. Per CLAUDE.md hard rule #10
// this uses onClick handlers, never an HTML <form>.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface FindingCardItem {
  id: string;
  checkCode: string;
  kind: string;
  severity: string;
  status: string;
  windowStartISO: string;
  windowEndISO: string;
  legARef: string | null;
  legBRef: string | null;
  causeCategory: string | null;
  firstDetectedISO: string;
  lastSeenISO: string;
}

interface FindingDetailPayload {
  expected: unknown;
  actual: unknown;
  detail: unknown;
  resolutionNote: string | null;
  importId: string | null;
}

const CAUSES = [
  { value: 'data_entry', label: 'Data entry' },
  { value: 'operational', label: 'Operational' },
  { value: 'external_mymrc', label: 'External (MyMRC)' },
  { value: 'template_defect', label: 'Template defect' },
  { value: 'unknown', label: 'Unknown' },
] as const;

const SEVERITY_CLASS: Record<string, string> = {
  low: 'bg-gray-100 text-gray-700',
  medium: 'bg-amber-100 text-amber-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

const STATUS_CLASS: Record<string, string> = {
  open: 'bg-emerald-100 text-emerald-800',
  acknowledged: 'bg-sky-100 text-sky-800',
  resolved: 'bg-gray-100 text-gray-600',
  not_an_issue: 'bg-gray-100 text-gray-500',
};

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <pre className="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-xs text-gray-800">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function FindingCard({ item, siteCode }: { item: FindingCardItem; siteCode: string }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<FindingDetailPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cause, setCause] = useState<string>(item.causeCategory ?? 'data_entry');
  const [note, setNote] = useState('');

  const base = `/api/audit/${siteCode}/findings/${item.id}`;

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(base, { method: 'GET' });
        if (!res.ok) throw new Error(`load failed (${res.status})`);
        const body = (await res.json()) as { finding: FindingDetailPayload };
        setDetail(body.finding);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'load failed');
      } finally {
        setLoading(false);
      }
    }
  }

  async function transition(toStatus: string, withCause: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toStatus,
          ...(withCause ? { causeCategory: cause, resolutionNote: note || undefined } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `action failed (${res.status})`);
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(false);
    }
  }

  const isActive = item.status === 'open' || item.status === 'acknowledged';

  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-gray-900">{item.checkCode}</span>
          <span className="text-sm text-gray-600">{item.kind.replace(/_/g, ' ')}</span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_CLASS[item.severity] ?? ''}`}>
            {item.severity}
          </span>
          <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[item.status] ?? ''}`}>
            {item.status.replace(/_/g, ' ')}
          </span>
        </div>
        <span className="text-xs text-gray-400">
          {item.windowStartISO} → {item.windowEndISO} · {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="space-y-3 border-t border-gray-100 px-4 py-3">
          {loading && <div className="text-sm text-gray-500">Loading…</div>}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {detail && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Json label="Expected" value={detail.expected} />
                <Json label="Actual" value={detail.actual} />
              </div>
              <Json label="Provenance / detail" value={detail.detail} />
              <div className="text-xs text-gray-500">
                Refs: leg A {item.legARef ?? '—'} · leg B {item.legBRef ?? '—'}
                {detail.importId ? ` · workbook import ${detail.importId}` : ''}
              </div>
              <div className="text-xs text-gray-400">
                First detected {new Date(item.firstDetectedISO).toLocaleString()} · last seen{' '}
                {new Date(item.lastSeenISO).toLocaleString()}
              </div>

              <div className="rounded border border-gray-100 bg-gray-50 p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Classify &amp; act</div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-sm">
                    <span className="mr-1 text-gray-600">Cause</span>
                    <select
                      value={cause}
                      onChange={(e) => setCause(e.target.value)}
                      className="rounded border border-gray-300 px-2 py-1 text-sm"
                    >
                      {CAUSES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Resolution note (optional)"
                    className="min-w-[16rem] flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.status === 'open' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => transition('acknowledged', false)}
                      className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Acknowledge
                    </button>
                  )}
                  {isActive && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => transition('resolved', true)}
                        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => transition('not_an_issue', true)}
                        className="rounded bg-gray-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                      >
                        Not an issue
                      </button>
                    </>
                  )}
                  {!isActive && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => transition('open', false)}
                      className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    >
                      Reopen
                    </button>
                  )}
                </div>
                {detail.resolutionNote && (
                  <div className="mt-2 text-xs text-gray-500">Note: {detail.resolutionNote}</div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
