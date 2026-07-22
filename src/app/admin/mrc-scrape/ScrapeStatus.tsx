'use client';

// ADR-0057 — MRC-Scrape status section for /admin/mrc-scrape.
//
// A self-contained client panel: it fetches /api/admin/mrc-scrape/status on
// mount and renders credential state, the last sync run, and per-object mirror
// counts. Lives in its own file (imported by the page shell the tile agent owns)
// so the two surfaces never collide. Copy is inlined locally rather than added
// to the shared adminMessages table for the same isolation reason.
//
// Vision has NEVER pulled from MyMRC, so the ledger is empty on first load. The
// `neverRun` flag drives an honest "no sync has run yet" empty state — never a
// fabricated "healthy". The password is never fetched, rendered, or held here;
// the API deliberately omits it. Deep-space theme to match the admin surfaces.
//
// Pass a changing `refreshKey` (e.g. bumped after the credential form saves) to
// force a refetch; the panel also exposes a manual Refresh control.

import { useCallback, useEffect, useState } from 'react';
import type {
  MrcScrapeStatusResponse,
  MrcLastRun,
} from '@/app/api/admin/mrc-scrape/status/route';

const M = {
  heading: 'Scrape status',
  loading: 'Loading status…',
  loadFailed: 'Could not load scrape status',
  refresh: 'Refresh',
  credHeading: 'Credentials',
  credConfigured: 'Configured',
  credMissing: 'Not configured',
  credMissingHint: 'Enter MyMRC admin credentials above to enable the first pull.',
  credUser: 'Login',
  credUpdated: 'Updated',
  credUpdatedBy: 'by',
  lastRunHeading: 'Last sync run',
  neverRun: 'No sync has run yet — enter credentials to enable the first pull.',
  running: 'in progress',
  rowsListed: 'listed',
  rowsUpserted: 'upserted',
  detailsFetched: 'details',
  objectsHeading: 'Mirror objects',
  objRows: 'rows',
  objLastSeen: 'freshest',
  objNever: 'no rows yet',
} as const;

// Render an instant in Bill's Pacific wall clock (+ ' PT'), never the browser's
// zone — matches every other DR3 surface.
function fmt(iso: string | null): string {
  if (!iso) return '—';
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}

const RUN_STATUS_LABEL: Record<MrcLastRun['status'], string> = {
  ok: 'OK',
  auth_failed: 'Auth failed',
  contract_drift: 'Contract drift',
  error: 'Error',
};
const RUN_STATUS_STYLE: Record<MrcLastRun['status'], string> = {
  ok: 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30',
  auth_failed: 'bg-red-500/15 text-red-300 ring-red-500/30',
  contract_drift: 'bg-amber-400/15 text-amber-300 ring-amber-400/30',
  error: 'bg-red-500/15 text-red-300 ring-red-500/30',
};

function Pill({ children, style }: { children: string; style: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ${style}`}
    >
      {children}
    </span>
  );
}

export function ScrapeStatus({ refreshKey }: { refreshKey?: number }) {
  const [data, setData] = useState<MrcScrapeStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/mrc-scrape/status', { cache: 'no-store' });
      if (!res.ok) {
        setError(`${M.loadFailed} (${res.status})`);
        return;
      }
      setData((await res.json()) as MrcScrapeStatusResponse);
    } catch {
      setError(M.loadFailed);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <section
      data-testid="scrape-status"
      className="flex flex-col gap-4 rounded-2xl border border-dr3-steel-light/25 bg-dr3-space-2/70 p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-dr3-mist">{M.heading}</h2>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline disabled:opacity-40"
        >
          {M.refresh}
        </button>
      </div>

      {loading && !data ? (
        <p className="text-sm text-dr3-mist-dim">{M.loading}</p>
      ) : error ? (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-300 ring-1 ring-red-500/30">
          {error}
        </p>
      ) : data ? (
        <div className="flex flex-col gap-5">
          {/* Credential state */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">
                {M.credHeading}
              </h3>
              <Pill
                style={
                  data.credential.configured
                    ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
                    : 'bg-dr3-steel-light/10 text-dr3-mist-dim ring-dr3-steel-light/25'
                }
              >
                {data.credential.configured ? M.credConfigured : M.credMissing}
              </Pill>
            </div>
            {data.credential.configured ? (
              <p className="text-sm text-dr3-mist-dim">
                {M.credUser}: <span className="text-dr3-mist">{data.credential.username}</span>
                {data.credential.updatedAt && (
                  <>
                    {' · '}
                    {M.credUpdated} {fmt(data.credential.updatedAt)}
                    {data.credential.updatedBy && ` ${M.credUpdatedBy} ${data.credential.updatedBy}`}
                  </>
                )}
              </p>
            ) : (
              <p className="text-sm text-dr3-mist-dim">{M.credMissingHint}</p>
            )}
          </div>

          {/* Last sync run */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">
              {M.lastRunHeading}
            </h3>
            {data.neverRun || !data.lastRun ? (
              <p
                data-testid="scrape-status-never-run"
                className="rounded-lg border border-dr3-steel-light/20 bg-dr3-space/50 px-3 py-2 text-sm text-dr3-mist-dim"
              >
                {M.neverRun}
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill style={RUN_STATUS_STYLE[data.lastRun.status]}>
                    {RUN_STATUS_LABEL[data.lastRun.status]}
                  </Pill>
                  <span className="text-sm text-dr3-mist">{data.lastRun.feed}</span>
                  <span className="text-xs text-dr3-mist-dim">
                    {fmt(data.lastRun.startedAt)}
                    {data.lastRun.finishedAt
                      ? ` → ${fmt(data.lastRun.finishedAt)}`
                      : ` · ${M.running}`}
                  </span>
                </div>
                <p className="text-xs text-dr3-mist-dim">
                  {data.lastRun.rowsListed} {M.rowsListed} · {data.lastRun.rowsUpserted}{' '}
                  {M.rowsUpserted} · {data.lastRun.detailsFetched} {M.detailsFetched}
                </p>
                {data.lastRun.error && (
                  <p className="rounded-lg bg-red-500/10 px-3 py-1.5 text-xs text-red-300 ring-1 ring-red-500/30">
                    {data.lastRun.error}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Per-object mirror counts */}
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">
              {M.objectsHeading}
            </h3>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {data.objectCounts.map((o) => (
                <li
                  key={o.object}
                  data-testid={`scrape-object-${o.object}`}
                  className="rounded-xl border border-dr3-steel-light/20 bg-dr3-space/50 p-3"
                >
                  <p className="text-sm font-semibold capitalize text-dr3-mist">{o.object}</p>
                  <p className="mt-0.5 text-xs text-dr3-mist-dim">
                    {o.count} {M.objRows}
                  </p>
                  <p className="text-xs text-dr3-mist-dim">
                    {o.lastSeenAt ? `${M.objLastSeen} ${fmt(o.lastSeenAt)}` : M.objNever}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  );
}
