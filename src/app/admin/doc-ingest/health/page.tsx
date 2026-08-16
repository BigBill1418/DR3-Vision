// ADR-0067 §3.4 — /admin/doc-ingest/health.
//
// Server-rendered, no client state: everything here is a read. The ordering is
// the argument — SWEEP FRESHNESS first, subscriptions second. A page that led
// with "3 active subscriptions" would look healthy while the correctness path
// was dead, which is the precise illusion that let MyMRC ingest nothing for
// months (ADR-0057 D9).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { docIngestMessages as M } from '@/lib/doc-ingest/messages';
import { loadDocIngestHealth } from '@/lib/doc-ingest/health';

export const dynamic = 'force-dynamic';

function fmt(iso: string | null): string {
  if (!iso) return M.neverSwept;
  const at = new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return `${at} PT`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded bg-dr3-steel/20 p-3 ring-1 ring-dr3-steel-light/20">
      <p className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export default async function DocIngestHealthPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/doc-ingest/health');
    redirect('/admin');
  }

  const health = await loadDocIngestHealth(prisma);
  const sunsetPassed = health.discovery.daysRemaining <= 0;
  const reachability = health.reachability;

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin/doc-ingest"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← {M.sources.title}
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">{M.health.title}</h1>
          <p className="text-sm text-dr3-mist-dim">{M.health.subtitle}</p>
        </header>

        {/* THE headline. Everything else on this page is secondary to it. */}
        <section
          className={`rounded-lg p-4 ring-1 ${
            health.sweep.stale
              ? 'bg-red-500/10 ring-red-500/40'
              : 'bg-emerald-400/10 ring-emerald-400/30'
          }`}
        >
          <h2 className="text-xl font-semibold">
            {M.health.sweepHeading} —{' '}
            {health.sweep.stale ? (
              <span className="text-red-300">{M.health.sweepStale}</span>
            ) : (
              <span className="text-emerald-300">{M.health.sweepHealthy}</span>
            )}
          </h2>
          {health.sweep.stale ? (
            <p className="mt-2 text-sm text-red-200">{M.health.sweepStaleBody}</p>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Stat label={M.health.lastSweep} value={fmt(health.sweep.lastSuccessISO)} />
            <Stat
              label={M.health.lastAttempt}
              value={`${fmt(health.sweep.lastRunISO)}${
                health.sweep.lastStatus ? ` (${health.sweep.lastStatus})` : ''
              }`}
            />
            <Stat label={M.health.consecutiveFailures} value={health.sweep.consecutiveFailures} />
          </div>
          {health.sweep.lastError ? (
            <p className="mt-3 text-sm text-red-200">{health.sweep.lastError}</p>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">{M.health.subscriptionsHeading}</h2>
          {!health.pushProven ? (
            <p className="text-sm text-dr3-mist-dim">{M.health.pushUnproven}</p>
          ) : null}
          {health.subscriptions.length === 0 ? (
            <p className="text-sm text-dr3-mist-dim">{M.noSubscriptions}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="py-2 pr-4">Drive</th>
                    <th className="py-2 pr-4">State</th>
                    <th className="py-2 pr-4">{M.health.expires}</th>
                    <th className="py-2 pr-4">{M.health.notificationsReceived}</th>
                    <th className="py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {health.subscriptions.map((s) => (
                    <tr key={s.id} className="border-t border-dr3-steel-light/15">
                      <td className="py-2 pr-4 font-mono text-xs">{s.driveId}</td>
                      <td className="py-2 pr-4">
                        {s.state}
                        <span className="ml-2 text-xs text-dr3-mist-dim">
                          {s.validated
                            ? M.health.subscriptionValidated
                            : M.health.subscriptionUnvalidated}
                        </span>
                      </td>
                      <td className="py-2 pr-4">{fmt(s.expiresAtISO)}</td>
                      <td className="py-2 pr-4">
                        {s.notificationsReceived}
                        {s.lastNotificationISO ? (
                          <span className="ml-2 text-xs text-dr3-mist-dim">
                            {fmt(s.lastNotificationISO)}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 text-xs text-dr3-mist-dim">{s.lastError ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">{M.health.sourcesHeading}</h2>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Active" value={health.sources.active} />
            <Stat label={M.health.accessLost} value={health.sources.accessDenied} />
            <Stat label={M.health.disappearedCount} value={health.sources.disappeared} />
            <Stat label={M.health.readBlockedCount} value={health.sources.readBlocked} />
            <Stat
              label={M.health.awaitingConfirmation}
              value={health.sources.awaitingConfirmation}
            />
            <Stat label={M.sources.disabled} value={health.sources.disabled} />
            <Stat label={M.health.stagedHeading} value={health.staged.count} />
            <Stat
              label="Open anomalies"
              value={`${health.anomalies.open} (${health.anomalies.critical} critical)`}
            />
          </div>
        </section>

        {/* The deprecation, surfaced where an operator will actually meet it. */}
        <section
          className={`rounded-lg p-4 ring-1 ${
            sunsetPassed ? 'bg-red-500/10 ring-red-500/40' : 'bg-amber-400/10 ring-amber-400/30'
          }`}
        >
          <h2 className="text-xl font-semibold">{M.health.discoveryHeading}</h2>
          <p className="mt-2 text-sm">
            {sunsetPassed ? (
              <span className="text-red-200">{M.health.discoveryExpired}</span>
            ) : (
              <>
                {M.health.discoverySunset} {health.discovery.sunsetDate} —{' '}
                <strong>
                  {health.discovery.daysRemaining} {M.health.discoveryDaysLeft}
                </strong>
                .
              </>
            )}
          </p>
          {health.discovery.sunsetDateIsInferred && (
            <p className="mt-2 text-xs text-dr3-mist-dim">{M.health.discoverySunsetInferred}</p>
          )}
        </section>

        {/*
          REACHABLE vs WATCHED (ADR-0080). Placed directly under the deprecation
          because they are one story: the enumeration that is being retired is
          also the one that has been under-reporting, and this is the number that
          says by how much.

          The three states are deliberately distinct and none of them is allowed
          to look like another:
            • no scan ever    → we CANNOT say. Not "no gap".
            • scan errored    → we could not look. Not "no gap".
            • gap === 0       → genuinely nothing unwatched, in the stated scope.
        */}
        {/* ADR-0104 §D7 — DUPLICATE DOCUMENTS.
            Normally absent. A class that names ONE physical document per site
            with two ENABLED sources is about to count every one of its rows
            twice — the ADR-0077 class, on a boolean anybody can flip from the
            confirm queue one screen away. Rendered only when it fires, because
            a permanent green "0 duplicates" tile is noise the eye stops
            reading, and this must be startling on the day it appears. */}
        {health.singleInstanceViolations.length > 0 && (
          <section className="rounded-lg bg-red-500/10 p-4 ring-1 ring-red-500/40">
            <h2 className="text-xl font-semibold text-red-200">
              {M.health.duplicateSourcesHeading}
            </h2>
            <p className="mt-2 text-sm text-red-100/90">{M.health.duplicateSourcesBody}</p>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {health.singleInstanceViolations.map((v) => (
                <li key={`${v.docClass}-${v.siteId ?? 'none'}`} className="font-mono text-xs">
                  <span className="text-red-200">{v.docClass}</span> · site{' '}
                  {v.siteId ?? '(none)'} · {v.sourceIds.length} enabled:{' '}
                  {v.sourceIds.join(', ')}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section
          className={`rounded-lg p-4 ring-1 ${
            reachability === null || reachability.error !== null
              ? 'bg-dr3-steel/20 ring-dr3-steel-light/30'
              : reachability.gapCount > 0
                ? 'bg-amber-400/10 ring-amber-400/30'
                : 'bg-emerald-500/10 ring-emerald-500/30'
          }`}
        >
          <h2 className="text-xl font-semibold">{M.health.reachabilityHeading}</h2>

          {reachability === null ? (
            <p className="mt-2 text-sm text-dr3-mist-dim">{M.health.reachabilityNever}</p>
          ) : (
            <>
              {reachability.error !== null ? (
                <p className="mt-2 text-sm text-amber-200">
                  {M.health.reachabilityFailed} {reachability.error}
                </p>
              ) : reachability.gapCount === 0 ? (
                <p className="mt-2 text-sm text-emerald-200">{M.health.reachabilityClean}</p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    <Stat label="Readable" value={reachability.reachable} />
                    <Stat label="Watched" value={reachability.watched} />
                    <Stat label="Unwatched" value={reachability.gapCount} />
                  </div>
                  <p className="mt-3 text-sm">{M.health.reachabilityGapLead}</p>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {reachability.gap.map((g) => (
                      <li key={`${g.driveId}:${g.itemId}`} className="flex flex-col">
                        <span className="font-medium">{g.name}</span>
                        <span className="text-xs text-dr3-mist-dim">
                          {g.ownerHint ?? 'owner unknown'}
                          {g.lastModifiedAt ? ` — modified ${fmt(g.lastModifiedAt)}` : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {reachability.truncated && (
                    <p className="mt-2 text-sm text-amber-200">{M.health.reachabilityTruncated}</p>
                  )}
                  <p className="mt-3 text-xs text-dr3-mist-dim">
                    {M.health.reachabilityNoAutoRegister}
                  </p>
                </>
              )}

              {/* The BOUND travels with the number. A count whose scope is
                  unknown is not evidence of anything. */}
              <p className="mt-3 break-all text-xs text-dr3-mist-dim">
                {M.health.reachabilityScope}: <code>{reachability.scope}</code>
              </p>
              <p className="text-xs text-dr3-mist-dim">
                {M.health.reachabilityScanned}: {fmt(reachability.scannedAtISO)}
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
