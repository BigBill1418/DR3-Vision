// T-107 (ADR-0020) — Vision Dashboard tile landing at `/`.
//
// Replaces the Sprint-1 "coming soon" splash. Self-gating server component:
//   - unauthenticated          → redirect('/login')
//   - role 'operator'          → redirect('/operator') (operators never see the
//                                manager launcher; they have the PIN/iPad flow)
//   - manager / admin          → render the role-aware tile launcher
//
// `/` is still in the middleware public-paths set today, so this page must
// enforce its own auth (the redirects above). The orchestrator will also remove
// `/` from PUBLIC_PATHS so the edge gates it too — see middlewareIntegration in
// the ticket result.
//
// Tile visibility is the ADR-0020 matrix (src/lib/dashboard-tiles.ts). The
// bonus tile keys off Woodland's site id, so we resolve it once from Prisma and
// thread it through `canSeeTile` — matching `requireBonusAccess` exactly. Tiles
// the user can't access are omitted entirely.
//
// `[site]` route templates (compliance, reconciliation) are resolved to a
// concrete site code: the manager's own site, or Woodland as the default for
// admins / both-sites managers.

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { BONUS_SITE_CODE } from '@/lib/bonus/access';
import { DASHBOARD_TILES, canSeeTile, type DashboardTile } from '@/lib/dashboard-tiles';
import { VisionShell } from '@/app/_components/vision-shell';
import { VisionTile } from '@/app/_components/vision-tile';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect('/login');
  }
  if (session.user.role === 'operator') {
    redirect('/operator');
  }

  // Resolve Woodland (for the bonus rule) + the caller's own site code (for
  // [site] route templates) in one round-trip.
  const sites = await prisma.site.findMany({ select: { id: true, code: true } });
  const woodland = sites.find((s) => s.code === BONUS_SITE_CODE) ?? null;
  const woodlandSiteId = woodland?.id ?? null;

  const ownSiteCode =
    sites.find((s) => s.id === session.user.primary_site_id)?.code ?? BONUS_SITE_CODE;

  const isSuperAdmin = session.user.is_super_admin === true;

  const visible = DASHBOARD_TILES.filter((t) =>
    canSeeTile(session, t, woodlandSiteId, isSuperAdmin),
  ).map((t) => resolveRoute(t, ownSiteCode));

  const active = visible.filter((t) => t.status === 'active');
  const comingSoon = visible.filter((t) => t.status === 'coming-soon');

  return (
    <VisionShell
      userName={session.user.name}
      userEmail={session.user.email}
      role={session.user.role}
      activeSection={active.map((t) => (
        <VisionTile key={t.key} tile={t} />
      ))}
      comingSoonSection={comingSoon.map((t) => (
        <VisionTile key={t.key} tile={t} />
      ))}
    />
  );
}

/** Replace the `[site]` placeholder in a tile route with a concrete code. */
function resolveRoute(tile: DashboardTile, siteCode: string): DashboardTile {
  if (!tile.route.includes('[site]')) return tile;
  return { ...tile, route: tile.route.replace('[site]', siteCode) };
}
