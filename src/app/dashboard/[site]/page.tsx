import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { DockPoller } from './dock-poller';
import { DockTile } from './dock-tile';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate } from '@/i18n/dictionary';

// Per-site live dock view per SPRINT-1-PLAN T-010. Replaces the T-003
// access-control placeholder with the real manager surface: tiles for
// every currently-active operator session at the site, refreshing
// every 5 seconds via `DockPoller`. Tap a tile → load detail.
//
// Per-site separation per CLAUDE.md hard rule #2: every Prisma read
// scopes by `site_id`. The 403 page below is preserved verbatim from
// the placeholder so off-site managers see the same gate.
//
// Manager surfaces stay on the green palette per ADR-0014 (auth
// surfaces black; working surfaces green).

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ site: string }> };

// Operator-active states only — the dock view is "who is on the dock
// right now". Once a load is `submitted` the operator is done; once
// it's `verified` / `submitted_to_mymrc` / `processed` it's a manager-
// portal record, not a dock event. T-011's load list covers the rest.
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
  const isAssigned = session.user.primary_site_id === site.id;
  if (!isAdmin && !isAssigned) {
    // Per acceptance: a manager scoped to Eugene hitting /dashboard/woodland
    // sees a 403, not a redirect or a misleading 404.
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
        <h1 className="text-2xl font-semibold">{t('dashboard.forbidden_heading')}</h1>
        <p className="mt-2 text-dr3-cream/70">
          {t('dashboard.forbidden_body', { name: site.name })}
        </p>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          {t('dashboard.back_to_sites')}
        </Link>
      </main>
    );
  }

  // Operator-active loads at this site, oldest-arrival first so the
  // tile order matches the order the operators got on the dock.
  const loads = await prisma.inboundLoad.findMany({
    where: {
      site_id: site.id,
      status: { in: [...OPERATOR_ACTIVE_STATUSES] },
    },
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
    <main className="min-h-screen bg-dr3-green-deep px-6 py-8 text-dr3-cream">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        <Link
          href="/dashboard"
          className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          {t('dashboard.back_to_sites')}
        </Link>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{site.name}</h1>
            <p className="text-sm capitalize text-dr3-cream/70">
              {t('site_dashboard.subtitle', { jurisdiction: site.jurisdiction })}
            </p>
          </div>
          <nav className="flex flex-wrap gap-2 text-sm">
            <Link
              href={`/dashboard/${site.code}/loads`}
              className="rounded-md bg-dr3-green-dark/40 px-3 py-1.5 text-dr3-cream transition-colors hover:bg-dr3-green-dark/70"
            >
              {t('loads.heading')}
            </Link>
            <Link
              href={`/dashboard/${site.code}/compliance`}
              className="rounded-md bg-dr3-green-dark/40 px-3 py-1.5 text-dr3-cream transition-colors hover:bg-dr3-green-dark/70"
            >
              {t('compliance.heading')}
            </Link>
            <Link
              href={`/dashboard/${site.code}/reconciliation`}
              className="rounded-md bg-dr3-green-dark/40 px-3 py-1.5 text-dr3-cream transition-colors hover:bg-dr3-green-dark/70"
              data-testid="dashboard-reconciliation-link"
            >
              Reconciliation
            </Link>
          </nav>
        </header>

        <DockPoller>
          {loads.length === 0 ? (
            <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
              <p className="text-lg font-medium">{t('site_dashboard.no_active_loads_heading')}</p>
              <p className="mt-2 text-sm text-dr3-cream/70">
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
                      operatorName: l.assigned_operator?.name ?? t('site_dashboard.tile_unassigned'),
                      sourceName: l.source?.name ?? t('site_dashboard.tile_unknown_source'),
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </DockPoller>
      </div>
    </main>
  );
}
