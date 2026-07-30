'use client';

// ADR-0069 — the reconciliation surface.
//
// Presentational only: every figure is computed server-side by
// `reconcileReference`, and this component never re-derives one. The period
// controls navigate (they change the URL), so a manager can share the exact view
// they are looking at — a reconciliation somebody cannot link to is a
// reconciliation nobody can discuss.
//
// Forms use `onClick`, never `<form onSubmit>` (repo convention).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import type {
  ReconciliationRow,
  ReconciliationSiteSummary,
  ReconciliationStatus,
} from '@/lib/doc-ingest/reconciliation';
import type { DocReferenceMetric } from '@prisma/client';

const METRIC_LABEL: Record<DocReferenceMetric, string> = {
  stripped_program: M.reconciliation.metricStrippedProgram,
  stripped_non_program: M.reconciliation.metricStrippedNonProgram,
  saved_units: M.reconciliation.metricSavedUnits,
};

const STATUS_LABEL: Record<ReconciliationStatus, string> = {
  agree: M.reconciliation.statusAgree,
  disagree: M.reconciliation.statusDisagree,
  missing_in_vision: M.reconciliation.statusMissingInVision,
  missing_in_reference: M.reconciliation.statusMissingInReference,
};

const STATUS_STYLE: Record<ReconciliationStatus, string> = {
  agree: 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/40',
  disagree: 'bg-amber-400/15 text-amber-200 ring-amber-400/40',
  missing_in_vision: 'bg-red-500/15 text-red-300 ring-red-500/40',
  missing_in_reference: 'bg-dr3-steel/40 text-dr3-mist-dim ring-dr3-steel-light/40',
};

/** Trailing zeros are noise on a units figure; a half unit is not. */
function fmt(n: number | null): string {
  if (n === null) return '—';
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function signed(n: number | null): string {
  if (n === null) return '—';
  if (n === 0) return '0';
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
}

export interface ReconciliationClientProps {
  rows: ReconciliationRow[];
  summaries: ReconciliationSiteSummary[];
  from: string;
  to: string;
}

export function ReconciliationClient({
  rows,
  summaries,
  from,
  to,
}: ReconciliationClientProps): JSX.Element {
  const router = useRouter();
  const [fromValue, setFromValue] = useState(from);
  const [toValue, setToValue] = useState(to);

  const apply = (): void => {
    router.push(
      `/admin/doc-ingest/reconciliation?from=${encodeURIComponent(fromValue)}&to=${encodeURIComponent(toValue)}`,
    );
  };

  const anyCoverage = summaries.some((s) => s.daysCovered > 0);

  return (
    <div className="flex flex-col gap-8">
      <p className="rounded-md bg-dr3-steel/20 px-4 py-3 text-sm text-dr3-mist-dim ring-1 ring-dr3-steel-light/20">
        {M.reconciliation.intro}
      </p>

      {/* ── Period ─────────────────────────────────────────────────────── */}
      <section className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-dr3-mist-dim">
          {M.reconciliation.from}
          <input
            type="date"
            value={fromValue}
            onChange={(e) => setFromValue(e.target.value)}
            className="rounded bg-dr3-space px-2 py-1 text-sm text-dr3-mist ring-1 ring-dr3-steel-light/30 [color-scheme:dark]"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-dr3-mist-dim">
          {M.reconciliation.to}
          <input
            type="date"
            value={toValue}
            onChange={(e) => setToValue(e.target.value)}
            className="rounded bg-dr3-space px-2 py-1 text-sm text-dr3-mist ring-1 ring-dr3-steel-light/30 [color-scheme:dark]"
          />
        </label>
        <button
          type="button"
          onClick={apply}
          className="rounded bg-dr3-cyan/15 px-4 py-1.5 text-sm text-dr3-cyan ring-1 ring-dr3-cyan/40 hover:bg-dr3-cyan/25"
        >
          {M.reconciliation.apply}
        </button>
      </section>

      {!anyCoverage ? (
        <section className="rounded-lg bg-dr3-steel/20 p-6 ring-1 ring-dr3-steel-light/20">
          <h2 className="text-lg font-semibold">{M.reconciliation.emptyHeading}</h2>
          <p className="mt-2 text-sm text-dr3-mist-dim">{M.reconciliation.emptyBody}</p>
        </section>
      ) : null}

      {/* ── Per-site scorecard ─────────────────────────────────────────── */}
      <section className="grid gap-4 md:grid-cols-2">
        {summaries.map((s) => {
          const compared = s.agree + s.disagree;
          const settled = s.daysCovered > 0 && s.disagree === 0 && s.missingInVision === 0;
          return (
            <div
              key={s.siteId}
              className="flex flex-col gap-3 rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20"
            >
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-lg font-semibold">{s.siteName}</h3>
                <span className="text-xs text-dr3-mist-dim">
                  {M.reconciliation.coverage}{' '}
                  {s.daysCovered > 0
                    ? `${s.coverageFrom} → ${s.coverageTo} (${s.daysCovered} ${M.reconciliation.daysCovered})`
                    : M.reconciliation.coverageNone}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Tile label={M.reconciliation.agree} value={s.agree} tone="good" />
                <Tile label={M.reconciliation.disagree} value={s.disagree} tone="warn" />
                <Tile
                  label={M.reconciliation.missingInVision}
                  value={s.missingInVision}
                  tone="bad"
                />
                <Tile
                  label={M.reconciliation.missingInReference}
                  value={s.missingInReference}
                  tone="muted"
                />
              </dl>

              <p className="text-xs text-dr3-mist-dim">
                {M.reconciliation.totalAbsDelta}:{' '}
                <span className="text-dr3-mist">{fmt(s.totalAbsDelta)}</span>
                {s.documents.length > 0 ? (
                  <>
                    {' · '}
                    {M.reconciliation.documents} {s.documents.join(', ')}
                  </>
                ) : null}
              </p>

              {compared > 0 || s.missingInVision > 0 ? (
                <p
                  className={`rounded px-3 py-2 text-xs ring-1 ${
                    settled
                      ? 'bg-emerald-400/10 text-emerald-300 ring-emerald-400/30'
                      : 'bg-amber-400/10 text-amber-200 ring-amber-400/30'
                  }`}
                >
                  <span className="font-semibold">{M.reconciliation.retirableHeading}</span>{' '}
                  {settled ? M.reconciliation.retirableYes : M.reconciliation.retirableNo}
                </p>
              ) : null}
            </div>
          );
        })}
      </section>

      {/* ── Day-by-day ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">{M.reconciliation.title}</h2>
        {rows.length === 0 ? (
          <p className="text-sm text-dr3-mist-dim">{M.reconciliation.noRows}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <thead className="bg-dr3-steel/30 text-left text-xs uppercase tracking-wide text-dr3-mist-dim">
                <tr>
                  <th className="px-3 py-2">{M.reconciliation.colDate}</th>
                  <th className="px-3 py-2">{M.reconciliation.colSite}</th>
                  <th className="px-3 py-2">{M.reconciliation.colMetric}</th>
                  <th className="px-3 py-2 text-right">{M.reconciliation.colReference}</th>
                  <th className="px-3 py-2 text-right">{M.reconciliation.colVision}</th>
                  <th className="px-3 py-2 text-right">{M.reconciliation.colDelta}</th>
                  <th className="px-3 py-2">{M.reconciliation.colStatus}</th>
                  <th className="px-3 py-2">{M.reconciliation.colDocument}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.siteId}|${r.productionDate}|${r.metric}`}
                    className="border-t border-dr3-steel-light/15"
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                      {r.productionDate}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{r.siteName}</td>
                    <td className="whitespace-nowrap px-3 py-2">{METRIC_LABEL[r.metric]}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(r.referenceValue)}</td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(r.visionValue)}</td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${
                        r.delta !== null && r.delta !== 0 ? 'text-amber-200' : ''
                      }`}
                    >
                      {signed(r.delta)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span
                        className={`rounded px-2 py-0.5 text-xs ring-1 ${STATUS_STYLE[r.status]}`}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-dr3-mist-dim">{r.documentName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-dr3-mist-dim">{M.reconciliation.referenceOnlyNote}</p>
      </section>
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'good' | 'warn' | 'bad' | 'muted';
}): JSX.Element {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-200'
        : tone === 'bad'
          ? 'text-red-300'
          : 'text-dr3-mist-dim';
  return (
    <div className="rounded bg-dr3-space/60 px-3 py-2">
      <dt className="text-[0.65rem] uppercase tracking-wide text-dr3-mist-dim">{label}</dt>
      <dd className={`mt-0.5 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</dd>
    </div>
  );
}
