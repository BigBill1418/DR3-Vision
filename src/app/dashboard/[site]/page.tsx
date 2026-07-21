import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import Link from 'next/link';
import { DockPoller } from './dock-poller';
import { DockTile } from './dock-tile';
import { RateTiles } from './rate-tiles';
import { FloorInventoryTile } from './floor-inventory-tile';
import { computeSiteRateTiles } from '@/lib/dashboard/rate-tiles';
import { computeFloorInventoryTile } from '@/lib/dashboard/floor-inventory-tile'; // rollup §3
import { computeEquipmentTile } from '@/lib/equipment/tile'; // ADR-0044
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
  const isAssigned = session.user.primary_site_id === site.id || session.user.all_sites === true;
  if (!isAdmin && !isAssigned) {
    // Per acceptance: a manager scoped to Eugene hitting /dashboard/woodland
    // sees a 403, not a redirect or a misleading 404. (An all-sites manager —
    // ADR-0024 — reaches every site, so `isAssigned` is true for them.)
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

  // ADR-0043 — contract rate tiles (site-scoped). Never throw the whole page on
  // a rate-computation hiccup; degrade to no tiles.
  const rateTiles = await computeSiteRateTiles(site.id, site.jurisdiction).catch(() => null);

  // Rollup §3 (2026-07-21) — live floor inventory tile: program / non-program /
  // total on the floor via the ADR-0037 running balance. Same degrade rule.
  // (The page is force-dynamic and DockPoller refreshes the route every 5s,
  // so the tile stays live without its own poller.)
  const floorInventory = await computeFloorInventoryTile(site.id).catch(() => null);

  // ADR-0044 — small equipment tile (last event + 7-day units/day). Never throw
  // the page on an equipment-read hiccup; degrade to no tile.
  const equipmentTile = await computeEquipmentTile(site.id).catch(() => null);

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
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
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
            <Link
              href={`/dashboard/${site.code}/loads`}
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
            >
              {t('loads.heading')}
            </Link>
            <Link
              href={`/dashboard/${site.code}/compliance`}
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
            >
              {t('compliance.heading')}
            </Link>
            <Link
              href={`/dashboard/${site.code}/reconciliation`}
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
              data-testid="dashboard-reconciliation-link"
            >
              Reconciliation
            </Link>
            {/* ADR-0042 — COR (Exhibit 5) is a California-only surface; hidden for
                Oregon (no Exhibit 5 exists there). The page itself also 404s for OR. */}
            {site.jurisdiction === 'california' && (
              <Link
                href={`/dashboard/${site.code}/cor`}
                className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
                data-testid="dashboard-cor-link"
              >
                COR
              </Link>
            )}
            {/* ADR-0045 — ops ledger (meeting notes + task follow-ups). Reach is
                enforced on the page itself (manager of the site / all_sites / admin). */}
            <Link
              href={`/dashboard/${site.code}/ops`}
              className="rounded-md border border-dr3-steel-light/25 bg-dr3-space-2 px-3 py-1.5 text-dr3-mist transition-colors hover:border-dr3-cyan/50 hover:bg-dr3-steel/40"
              data-testid="dashboard-ops-link"
            >
              Ops ledger
            </Link>
          </nav>
        </header>

        {rateTiles && <RateTiles tiles={rateTiles} siteCode={site.code} />}

        {/* Rollup §3 — live floor inventory (Rick's "currently on the floor" ask). */}
        {floorInventory && <FloorInventoryTile tile={floorInventory} siteCode={site.code} />}

        {/* ADR-0044 — equipment tile: last event + 7-day units/day. */}
        {equipmentTile && (
          <Link
            href={`/dashboard/${site.code}/equipment`}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dr3-steel-light/25 bg-dr3-space-2 p-4 transition-colors hover:border-dr3-cyan/50"
            data-testid="dashboard-equipment-tile"
          >
            <div>
              <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">Equipment (Terex)</div>
              <div className="mt-1 text-sm">
                {equipmentTile.lastEvent ? (
                  <>
                    Last: <span className="font-semibold">{equipmentTile.lastEvent.kind}</span> on{' '}
                    {equipmentTile.lastEvent.dateISO}
                    {equipmentTile.lastEvent.hoursDown ? ` · ${equipmentTile.lastEvent.hoursDown}h down` : ''}
                  </>
                ) : (
                  <span className="text-dr3-mist-dim">No events logged yet</span>
                )}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">7-day units/day</div>
              <div className="text-2xl font-bold">
                {equipmentTile.last7UnitsPerDay == null ? '—' : equipmentTile.last7UnitsPerDay.toFixed(1)}
              </div>
            </div>
          </Link>
        )}

        <DockPoller>
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
        </DockPoller>
      </div>
    </main>
  );
}
