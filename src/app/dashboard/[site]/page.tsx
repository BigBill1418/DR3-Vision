import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { DockTile } from './dock-tile';
import { OverviewPoller } from './overview/OverviewPoller';
import { OpsOverviewPanel } from './overview/OpsOverviewPanel';
import { computeOpsOverview } from '@/lib/dashboard/ops-overview';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate } from '@/i18n/dictionary';

// Operations Dashboard — per-site surface (ADR-0020 tile re-enable, 2026-07-22).
//
// Was the T-010 live-dock view; now leads with the comprehensive OpsOverview
// (today's load activity, processing close, inventory, equipment, contract
// rates, compliance slate, commodity aging, bonus, MyMRC sync freshness) and
// keeps the live per-operator dock grid below it. Site-scoped per CLAUDE.md hard
// rule #2: every read is bound to this site's id; a single-site manager hitting
// another site's URL still gets the 403 below. Refreshes on the 30s ops cadence
// (OverviewPoller) — lighter than the old 5s dock poll, which is wasteful for the
// heavier analytics. Manager surfaces stay on the dark Vision palette (ADR-0014).

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

const OPERATOR_ACTIVE_STATUSES = [
  'arrived',
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

export default async function SiteDashboardPage({ params }: Props) {
  const { site: siteCode } = await params;
  const session = await auth();
  if (!session?.user) redirect('/login');

  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t = (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true, jurisdiction: true },
  });
  if (!site) notFound();

  const isAdmin = session.user.role === 'admin';
  const isAssigned = session.user.primary_site_id === site.id || session.user.all_sites === true;
  if (!isAdmin && !isAssigned) {
    // A manager scoped to Eugene hitting /dashboard/woodland sees a 403, not a
    // redirect or a misleading 404 (an all-sites manager reaches every site).
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">{t('dashboard.forbidden_heading')}</h1>
        <p className="mt-2 text-dr3-mist-dim">
          {t('dashboard.forbidden_body', { name: site.name })}
        </p>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {t('dashboard.back_to_sites')}
        </Link>
      </main>
    );
  }

  // The full operations picture. Every panel degrades to null on read failure —
  // a site with no data renders cleanly rather than throwing (see ops-overview).
  const overview = await computeOpsOverview({
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    jurisdiction: site.jurisdiction,
  }).catch(() => null);

  // Operator-active loads for the live per-operator dock grid, oldest-arrival
  // first so the tile order matches the order operators got on the dock.
  const loads = await prisma.inboundLoad.findMany({
    where: { site_id: site.id, status: { in: [...OPERATOR_ACTIVE_STATUSES] } },
    select: {
      id: true,
      bol_number: true,
      status: true,
      arrived_at: true,
      assigned_operator: { select: { name: true } },
      source: { select: { name: true } },
    },
    orderBy: { arrived_at: 'asc' },
  });

  return (
    <main className="min-h-screen bg-dr3-space px-4 py-8 text-dr3-mist sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Link
          href="/dashboard"
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {t('dashboard.back_to_sites')}
        </Link>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{site.name}</h1>
            <p className="text-sm capitalize text-dr3-mist-dim">
              {t('site_dashboard.subtitle', { jurisdiction: site.jurisdiction })}
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <NavLink href={`/dashboard/${site.code}/loads`} label={t('loads.heading')} />
            <NavLink href={`/dashboard/${site.code}/loads-inventory`} label="Loads & inventory" />
            <NavLink href={`/dashboard/${site.code}/equipment`} label="Equipment" />
            <NavLink href={`/dashboard/${site.code}/compliance`} label={t('compliance.heading')} />
            <NavLink
              href={`/dashboard/${site.code}/reconciliation`}
              label="Reconciliation"
              testId="dashboard-reconciliation-link"
            />
            {site.jurisdiction === 'california' && (
              <NavLink
                href={`/dashboard/${site.code}/cor`}
                label="COR"
                testId="dashboard-cor-link"
              />
            )}
            <NavLink
              href={`/dashboard/${site.code}/ops`}
              label="Ops ledger"
              testId="dashboard-ops-link"
            />
            {/* ADR-0068 — the Employee Reimbursement tile. This is the entry point
                that retires the paper form: the submitter is authenticated, so
                Vision knows who ORIGINATED the request as a fact rather than as
                ink inside a scanned PDF, which is what makes "the submitter
                cannot approve" a constraint instead of a detection problem. */}
            <NavLink
              href={`/dashboard/${site.code}/reimbursements`}
              label="Employee reimbursement"
              testId="dashboard-reimbursements-link"
            />
          </nav>
        </header>

        <OverviewPoller>
          {overview ? (
            <OpsOverviewPanel data={overview} />
          ) : (
            <div className="rounded-lg border border-dashed border-dr3-steel-light/25 bg-dr3-space-2 p-8 text-center text-dr3-mist-dim">
              The operations overview could not be loaded right now. The live dock below is
              unaffected.
            </div>
          )}

          {/* Live per-operator dock grid — who is physically on the dock now. */}
          <section aria-label="Live dock" className="flex flex-col gap-3">
            <h2 className="flex items-center gap-3 text-xs font-bold uppercase tracking-[0.28em] text-dr3-cyan">
              <span className="h-px w-6 bg-dr3-cyan/50" aria-hidden="true" />
              Live dock
            </h2>
            {loads.length === 0 ? (
              <div className="rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-8 text-center">
                <p className="text-lg font-medium">{t('site_dashboard.no_active_loads_heading')}</p>
                <p className="mt-2 text-sm text-dr3-mist-dim">
                  {t('site_dashboard.no_active_loads_body')}
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {loads.map((l) => (
                  <li key={l.id}>
                    <DockTile
                      siteCode={site.code}
                      load={{
                        id: l.id,
                        bol_number: l.bol_number,
                        status: l.status,
                        arrived_at: l.arrived_at,
                        operatorName:
                          l.assigned_operator?.name ?? t('site_dashboard.tile_unassigned'),
                        sourceName: l.source?.name ?? t('site_dashboard.tile_unknown_source'),
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </OverviewPoller>
      </div>
    </main>
  );
}

function NavLink({ href, label, testId }: { href: string; label: string; testId?: string }) {
  return (
    <Link
      href={href}
      data-testid={testId}
      className="inline-flex min-h-[44px] items-center rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
    >
      {label}
    </Link>
  );
}
