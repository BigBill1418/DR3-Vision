// ADR-0019.4 §4 — /admin/bonus-chain-health.
//
// The standing readable surface for `bonus_signature_chains`. Server-rendered,
// no client state: everything here is a read.
//
// Why a page and not just the ntfy: the 08:30 PT auto-override already refuses
// to sign as an inactive actor and pages when it does. That guard speaks at the
// point of failure — thirty minutes before an immovable payroll deadline — and
// only through the alert channel. On 2026-08-05 the app logged
// `stranded ntfy dropped (primary+fallback failed)` and the period was signed
// ~25h late: the one page that would have said so was itself lost. A check whose
// only output is a page can be silenced by the pager. This one is state.
//
// The ordering is the argument — LIVE CHAIN STATE first, ledger second. A page
// that led with "20 checks recorded" would look healthy while the chain the
// checks describe was broken, which is precisely the illusion this exists to
// prevent (the same failure shape as ADR-0057 D9).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { checkAdmin } from '@/lib/auth-helpers';
import { loadChainHealth, type ChainStatus } from '@/lib/bonus/chain-health';
import { formatPacificDateTime } from '@/lib/time';

export const dynamic = 'force-dynamic';

/** How many ledger rows the "Recent checks" table shows. */
const RECENT_RUN_LIMIT = 20;

/**
 * Panel chrome per status. Kept as a table rather than string concatenation so
 * Tailwind sees every class literally and does not tree-shake them out of the
 * build.
 */
const PANEL: Record<ChainStatus, string> = {
  green: 'bg-emerald-400/10 ring-emerald-400/30',
  amber: 'bg-amber-400/10 ring-amber-400/30',
  red: 'bg-red-500/10 ring-red-500/40',
};

const STATUS_TEXT: Record<ChainStatus, string> = {
  green: 'text-emerald-300',
  amber: 'text-amber-300',
  red: 'text-red-300',
};

const DOT: Record<ChainStatus, string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-400',
  red: 'bg-red-400',
};

/** The headline sentence. It names the consequence, not just the colour. */
const OVERALL_HEADLINE: Record<ChainStatus, string> = {
  green: 'Signature chain healthy — override actor available',
  amber: 'Signature chain DEGRADED — a safety property has been lost',
  red: 'Signature chain BROKEN',
};

const OVERALL_BODY: Record<ChainStatus, string> = {
  green:
    'Every signer, override actor, and auto-override actor resolves to a live account. The 08:30 AM PT auto-override has someone to sign as.',
  amber:
    'Every reference still resolves to a live account, so the 08:30 AM PT auto-override can sign — but the chain has lost a backstop or its four-eyes property. Fix before it is load-bearing.',
  red: 'At least one reference cannot sign. The 08:30 AM PT auto-override will refuse, and the 09:00 AM PT payroll deadline will be missed unless a human signs manually.',
};

/**
 * A ledger status read back out of Postgres is a bare `String` (the column is
 * TEXT so a new tier never needs a migration — schema.prisma:1800). Narrow it
 * here rather than casting, so an unrecognised value renders as itself instead
 * of silently picking up green styling.
 */
function isChainStatus(s: string): s is ChainStatus {
  return s === 'green' || s === 'amber' || s === 'red';
}

function StatusDot({ status }: { status: ChainStatus }) {
  return (
    <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[status]}`} />
  );
}

export default async function BonusChainHealthPage() {
  const gate = await checkAdmin();
  if (!gate.ok) {
    if (gate.status === 401) redirect('/login?next=/admin/bonus-chain-health');
    redirect('/admin');
  }

  // Live evaluation, not the last ledger row. The ledger says what was true at
  // 06:30 PT; this says what is true now, and a chain can break at any hour.
  const health = await loadChainHealth(prisma);

  const runs = await prisma.bonusChainHealthRun.findMany({
    orderBy: { observed_at: 'desc' },
    take: RECENT_RUN_LIMIT,
    select: {
      id: true,
      observed_at: true,
      status: true,
      paged: true,
      site: { select: { code: true, name: true } },
    },
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-1">
          <Link
            href="/admin"
            className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
          >
            ← Admin
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Bonus signature chain health</h1>
          <p className="text-sm text-dr3-mist-dim">
            Whether every signer and override actor on{' '}
            <code className="text-dr3-mist">bonus_signature_chains</code> still resolves to a live
            account — checked live on load, and once a day at 06:30 AM PT (ADR-0019.4).
          </p>
        </header>

        {/* THE headline. Everything else on this page is secondary to it. */}
        <section className={`rounded-lg p-4 ring-1 ${PANEL[health.overall]}`}>
          <h2 className={`text-xl font-semibold ${STATUS_TEXT[health.overall]}`}>
            {OVERALL_HEADLINE[health.overall]}
          </h2>
          <p className="mt-2 text-sm text-dr3-mist">{OVERALL_BODY[health.overall]}</p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Per site</h2>
          {/*
            `loadChainHealth` emits a red result for a site with NO chain row
            rather than omitting it, so an empty list here means there are no
            SITES at all — which `worstChainStatus` has already reported as red
            in the banner above. Say so rather than rendering nothing.
          */}
          {health.sites.length === 0 ? (
            <p className="text-sm text-red-200">
              No sites were found, so no signature chain could be evaluated. Nothing can be signed
              anywhere.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {health.sites.map((site) => (
                <div
                  key={site.siteCode}
                  data-testid={`chain-site-${site.siteCode}`}
                  className={`flex flex-col gap-3 rounded-2xl p-5 ring-1 ${PANEL[site.status]}`}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={site.status} />
                    <h3 className="text-lg font-semibold">{site.siteName}</h3>
                    <span
                      className={`ml-auto text-xs font-bold uppercase tracking-wide ${STATUS_TEXT[site.status]}`}
                    >
                      {site.status}
                    </span>
                  </div>

                  <p className="text-sm text-dr3-mist-dim">
                    Auto-override actor:{' '}
                    {site.autoOverrideActorName ? (
                      <span className="font-medium text-dr3-mist">
                        {site.autoOverrideActorName}
                      </span>
                    ) : (
                      // Distinct from "green with an actor": an unresolvable
                      // actor is the exact condition that stranded Eugene.
                      <span className="font-medium text-red-300">
                        unresolvable — no account matches the configured id
                      </span>
                    )}
                  </p>

                  {site.findings.length === 0 ? (
                    <p className="text-sm text-emerald-200">
                      Every signer and override actor resolves to a live account.
                      {site.autoOverrideActorName
                        ? ` ${site.autoOverrideActorName} can sign at 08:30 AM PT if nobody else has.`
                        : ''}
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-2 text-sm">
                      {site.findings.map((f, i) => (
                        <li
                          key={`${f.slot}:${f.reason}:${f.userId ?? i}`}
                          className="flex flex-col"
                        >
                          <span className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                            {f.slot.replace(/_/g, ' ')} — {f.reason.replace(/_/g, ' ')}
                          </span>
                          <span className="leading-relaxed">{f.detail}</span>
                          {f.userId ? (
                            <span className="break-all font-mono text-xs text-dr3-mist-dim">
                              {f.userId}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}

                  {/*
                    ADR-0019.3 §2 — separation-of-duties exclusions. Rendered
                    OUTSIDE the findings list, and on a green card too, because
                    an exclusion is not a defect: it is the guard working as
                    designed. Showing it here answers the question an operator
                    would otherwise have to read an ADR to answer — "why did an
                    override actor sign that period instead of its signer?"
                  */}
                  {site.sodExclusions.length > 0 ? (
                    <p className="mt-3 border-l-2 border-dr3-mist-dim/40 pl-3 text-sm text-dr3-mist-dim">
                      {site.sodExclusions.map((e) => (
                        <span key={e.userId} className="block leading-relaxed">
                          <strong>{e.employeeName}</strong> holds the{' '}
                          {e.slot === 'ops_signer' ? 'ops' : 'facility'} slot and is also a bonus
                          subject, so they cannot sign periods containing their own entries. Those
                          periods route to the override chain by design (ADR-0019.3 §2) — this is
                          not a fault.
                        </span>
                      ))}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">Recent checks</h2>
          {/*
            The ledger answers a question the live evaluation above cannot: is
            the check still RUNNING? An empty table is therefore never allowed to
            render as a quiet, healthy-looking blank — silence and health look
            identical, and only one of them is safe.
          */}
          {runs.length === 0 ? (
            <div
              data-testid="chain-runs-empty"
              className="rounded-lg bg-amber-400/10 p-4 text-sm ring-1 ring-amber-400/30"
            >
              <p className="font-semibold text-amber-300">No checks recorded yet.</p>
              <p className="mt-2 text-dr3-mist">
                Nothing has ever written a row to <code>bonus_chain_health_runs</code>, so the 06:30
                AM PT cron may not have run. This is not evidence that the chain is healthy — it
                means nobody has been watching it, and a break between now and the next 08:30 AM PT
                auto-override would go unannounced.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-dr3-mist-dim">
                  <tr>
                    <th className="py-2 pr-4">Observed (PT)</th>
                    <th className="py-2 pr-4">Site</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2">Paged</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-dr3-steel-light/15">
                      <td className="py-2 pr-4">{formatPacificDateTime(r.observed_at)} PT</td>
                      <td className="py-2 pr-4">{r.site.code}</td>
                      <td
                        className={`py-2 pr-4 font-medium ${
                          isChainStatus(r.status) ? STATUS_TEXT[r.status] : 'text-dr3-mist-dim'
                        }`}
                      >
                        {r.status}
                      </td>
                      {/*
                        "no" against a red row is not a defect to hide: the sweep
                        pages on the LEADING edge only, and re-pages at most once
                        a day, so a persisting red is expected to show `no` here.
                      */}
                      <td className="py-2">{r.paged ? 'yes' : 'no'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-xs text-dr3-mist-dim">
                Newest first, last {RECENT_RUN_LIMIT} observations across all sites. One row is
                written per site per poll regardless of status — a gap in these timestamps means the
                check stopped running.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
