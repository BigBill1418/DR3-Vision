import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { computeSiteSummary } from '@/lib/dashboard/ops-overview';
import type { SiteSummary } from '@/lib/dashboard/ops-overview';
import { getLocale } from '@/i18n/get-locale';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import { getManagerDictionary } from '@/i18n/dictionary';
import { translate } from '@/i18n/dictionary';

// Dashboard landing post-login. Server component. For a single-site manager it
// is the site picker → /dashboard/[site]. For an admin / all-sites manager it
// leads with a COMBINED both-sites operations summary (ADR-0020 re-enable) so
// the whole operation is visible at a glance before drilling into one site.

export const dynamic = 'force-dynamic';

const nf = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d });
const usd = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const TONE_TEXT: Record<string, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  alert: 'text-rose-300',
  neutral: 'text-dr3-mist-dim',
};
const TONE_DOT: Record<string, string> = {
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  alert: 'bg-rose-400',
  neutral: 'bg-dr3-mist-dim/50',
};

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t = (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);

  const sites = await prisma.site.findMany({
    select: { id: true, code: true, name: true, jurisdiction: true },
    orderBy: { name: 'asc' },
  });

  // Admins and all-sites managers (ADR-0024) see every site; a plain manager
  // sees only their primary site.
  const canSeeAll = session.user.role === 'admin' || session.user.all_sites === true;
  const visibleSites = canSeeAll
    ? sites
    : sites.filter((s) => s.id === session.user.primary_site_id);

  // ── ADR-0068 Amendment 2 — reimbursements belong on the PRIMARY dashboard ───
  // Operator directive 2026-07-30: "the reimbursement tile is NOT an ipad surface
  // it is a manager surface in the primary dashboard."
  //
  // It shipped only on the per-site dashboard, which looked fine in testing
  // because a plain manager lands on their own site page. Bill does not: his
  // account is `admin` with `primary_site_id = NULL` and `all_sites = false`, so
  // he always lands HERE, on the picker, and never saw the tile at all. A surface
  // reachable only by first clicking into a site is not "in the primary
  // dashboard".
  //
  // One entry PER REACHABLE SITE, because the form is site-scoped (the site is
  // auto-filled from the submitter and is not user-editable). The pending count
  // makes it an action item rather than a link — "2 waiting" is the reason to
  // click; a bare label is not.
  const reimbursementEntries = await Promise.all(
    visibleSites.map(async (s) => {
      // The per-site UI gate still governs visibility, so Bill can ramp one site
      // without the other. Unregistered/pilot ⇒ hidden (fail-safe for a
      // visibility gate).
      const live = await isUiSurfaceLive(UI_SURFACE.REIMBURSEMENT_TILE, s.id);
      if (!live) return null;
      const [pending, mine] = await Promise.all([
        prisma.reimbursementRequest.count({
          where: { site_id: s.id, status: 'pending_second_approval' },
        }),
        // "Waiting on YOU" is the number that changes behaviour. Counted from
        // `routed_to_user_id`, which is who the shared resolver actually routed
        // it to — never a guess from the site roster.
        prisma.reimbursementRequest.count({
          where: {
            site_id: s.id,
            status: 'pending_second_approval',
            routed_to_user_id: session.user.id,
          },
        }),
      ]);
      return { code: s.code, name: s.name, pending, mine };
    }),
  ).then((rows) => rows.filter((r): r is NonNullable<typeof r> => r != null));

  // Combined both-sites summary — only for the multi-site audience, and only when
  // more than one site is in reach (otherwise it duplicates the single-site page).
  const summaries: SiteSummary[] =
    canSeeAll && visibleSites.length > 1
      ? await Promise.all(
          visibleSites.map((s) =>
            computeSiteSummary({
              siteId: s.id,
              siteCode: s.code,
              siteName: s.name,
              jurisdiction: s.jurisdiction,
            }).catch(() => null),
          ),
        ).then((rows) => rows.filter((r): r is SiteSummary => r != null))
      : [];

  return (
    <main className="min-h-screen bg-dr3-space px-4 py-10 text-dr3-mist sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{t('dashboard.header_title')}</h1>
              <p className="text-sm text-dr3-mist-dim">
                {t('dashboard.signed_in_as', {
                  name: session.user.name ?? '',
                  role: session.user.role,
                })}
              </p>
            </div>
            {session.user.role === 'admin' ? (
              <Link
                href="/admin/users"
                className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-sm font-medium text-dr3-mist transition-colors hover:bg-dr3-steel/40"
                data-testid="dashboard-admin-link"
              >
                {t('dashboard.admin_link')}
              </Link>
            ) : null}
          </div>
        </header>

        {summaries.length > 0 && (
          <section className="flex flex-col gap-3" data-testid="combined-overview">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.28em] text-dr3-cyan">
              <span className="h-px w-6 bg-dr3-cyan/50" aria-hidden="true" />
              Both sites at a glance
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {summaries.map((s) => (
                <SiteSummaryCard key={s.siteCode} s={s} />
              ))}
            </div>
          </section>
        )}

        {reimbursementEntries.length > 0 && (
          <section className="flex flex-col gap-3" data-testid="dashboard-reimbursements">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.28em] text-dr3-cyan">
              <span className="h-px w-6 bg-dr3-cyan/50" aria-hidden="true" />
              Employee reimbursements
            </h2>
            <p className="text-sm text-dr3-mist-dim">
              Every reimbursement needs two signatures from two different people, whatever the
              amount. Submitting one is the first signature — you cannot also approve it.
            </p>
            <ul className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {reimbursementEntries.map((r) => (
                <li key={r.code}>
                  <Link
                    href={`/dashboard/${r.code}/reimbursements`}
                    className="flex min-h-[44px] items-center justify-between gap-3 rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-3 transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
                    data-testid={`dashboard-reimbursements-${r.code}`}
                  >
                    <span className="font-medium text-dr3-mist">{r.name}</span>
                    {r.mine > 0 ? (
                      // Waiting on THIS person — the only count that changes what
                      // they do next, so it gets the alerting colour.
                      <span className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/30">
                        {r.mine} waiting for your signature
                      </span>
                    ) : r.pending > 0 ? (
                      <span className="rounded-full bg-dr3-steel/40 px-2.5 py-0.5 text-xs text-dr3-mist-dim ring-1 ring-dr3-steel-light/25">
                        {r.pending} awaiting a second signature
                      </span>
                    ) : (
                      <span className="text-xs text-dr3-mist-dim">Reimburse an employee →</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-xl font-semibold">{t('dashboard.sites_heading')}</h2>
          {visibleSites.length === 0 ? (
            <p className="text-dr3-mist-dim">{t('dashboard.sites_empty')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleSites.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/${s.code}`}
                    className="flex min-h-[44px] items-center rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-4 py-3 text-lg font-medium text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
                  >
                    {s.name} <span className="ml-2 text-sm text-dr3-mist-dim">({s.code})</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function SiteSummaryCard({ s }: { s: SiteSummary }) {
  const processedTone = s.processedTodayClosed ? 'ok' : s.processedFoundToday ? 'warn' : 'neutral';
  const processedLabel = s.processedTodayClosed
    ? 'Closed'
    : s.processedFoundToday
      ? 'Open'
      : 'No entry';
  return (
    <Link
      href={`/dashboard/${s.siteCode}`}
      className="flex flex-col gap-4 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-5 transition-colors hover:border-dr3-cyan/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-dr3-cyan"
      data-testid={`summary-${s.siteCode}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-lg font-semibold text-dr3-mist">{s.siteName}</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-dr3-mist-dim">
          <span
            className={`h-2 w-2 rounded-full ${TONE_DOT[s.mirrorWorst.tone]}`}
            aria-hidden="true"
          />
          <span className={TONE_TEXT[s.mirrorWorst.tone]}>MyMRC {s.mirrorWorst.relative}</span>
        </span>
      </div>
      {/* 2×2 on narrow / half-width cards; 4-up only at lg where the card is wide
          enough. `min-w-0` lets each cell shrink so a wide value wraps inside its
          own track instead of overflowing into the neighbour (the 768px overlap
          bug). The Open/Closed status renders at a smaller scale than the numeric
          stats so it is never the widest/largest element in the card. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 lg:grid-cols-4">
        <Metric label="On dock now" value={nf(s.loadsActive)} unit="loads" />
        <Metric label="Arrived today" value={nf(s.loadsArrivedToday)} unit="loads" />
        <Metric
          label="On floor"
          value={s.floorTotal == null ? '—' : nf(s.floorTotal, 0)}
          unit="units"
        />
        <Metric
          label="Processing"
          value={processedLabel}
          unit=""
          valueClass={TONE_TEXT[processedTone] ?? 'text-dr3-mist'}
          status
        />
      </div>
      {s.commodityOutstandingUsd != null && s.commodityOutstandingUsd > 0 && (
        <div className="text-xs text-dr3-mist-dim">
          Commodity outstanding{' '}
          <strong className="text-dr3-mist">{usd(s.commodityOutstandingUsd)}</strong>
        </div>
      )}
    </Link>
  );
}

function Metric({
  label,
  value,
  unit,
  valueClass,
  status = false,
}: {
  label: string;
  value: string;
  unit: string;
  valueClass?: string;
  // A `status` metric holds a word ("Open"/"Closed") rather than a number.
  // Rendered a step down from the numeric stats so a wide word never becomes
  // the largest element and cannot overrun its grid track.
  status?: boolean;
}) {
  const valueSize = status ? 'text-base' : 'text-2xl';
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className="flex flex-wrap items-baseline gap-1">
        <span
          className={`${valueSize} font-bold tabular-nums leading-tight ${valueClass ?? 'text-dr3-mist'}`}
        >
          {value}
        </span>
        {unit ? <span className="text-xs text-dr3-mist-dim">{unit}</span> : null}
      </div>
    </div>
  );
}
