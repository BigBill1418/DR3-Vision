// T-107 (ADR-0020) — Vision Dashboard tile registry + visibility matrix.
//
// The single source of truth for the role-aware tile launcher rendered at
// `/`. Each tile declares its route, status, and a `scope` describing who may
// see it. `canSeeTile` evaluates the ADR-0020 visibility matrix against a
// session.
//
// Bonus visibility intentionally mirrors `src/lib/bonus/access.ts` to the
// letter: admin OR a manager whose `primary_site_id` is Woodland (Janette) or
// `null` (both-sites operations manager, Morena). A manager bound to Eugene
// (Rick) does NOT see the Bonus tile. Because the bonus rule keys off the
// Woodland *site id* (not a code), and the session only carries
// `primary_site_id`, callers must resolve Woodland's id once (server-side) and
// pass it in — exactly as `requireBonusAccess` looks it up from Prisma. This
// keeps the matrix a pure function and avoids a DB read per tile.
//
// Tiles the caller may NOT access are OMITTED from the launcher entirely (not
// greyed) — ADR-0020. Coming-soon tiles are visible to everyone who passes the
// base manager/admin gate (no operator ever reaches `/`; they redirect to
// `/operator`).

import type { Session } from 'next-auth';

export type TileStatus = 'active' | 'coming-soon';

/**
 * Who may see a tile.
 *   - 'manager+'   → any manager or admin (the base /-gate audience)
 *   - 'admin-only' → admin role only (Admin & Audit)
 *   - 'bonus'      → the bonus access rule (admin OR Woodland/both-sites manager)
 */
export type TileScope = 'manager+' | 'admin-only' | 'bonus';

export interface DashboardTile {
  /** Stable key (also used as the React list key + test selector). */
  key: string;
  label: string;
  /** Short supporting line under the label. */
  description: string;
  /** lucide-react icon name (resolved to a component in the tile UI). */
  icon: string;
  route: string;
  status: TileStatus;
  scope: TileScope;
  /** Featured tile gets the chartreuse treatment + a NEW pill. */
  featured?: boolean;
}

// ── Registry, grouped by ADR-0020 origin ──────────────────────────────
// NOTE: the launcher at `/` sorts tiles by `status`, not by which array they
// live in. As of 2026-06-06 three tiles here carry `status: 'coming-soon'`
// (operations, compliance, reconciliation) — paused at operator request while
// the underlying surfaces are reworked. Their routes are preserved so a future
// re-enable is a one-field flip back to 'active'.
const ACTIVE_TILES: readonly DashboardTile[] = [
  {
    key: 'bonus',
    label: 'Bonus Management',
    description: 'Woodland processor bonus — daily entry, monthly close, payroll export.',
    icon: 'Coins',
    route: '/bonus',
    status: 'active',
    scope: 'bonus',
    featured: true,
  },
  {
    key: 'operations',
    label: 'Operations Dashboard',
    description: 'Live load activity, photos, and processing throughput by site.',
    icon: 'LayoutDashboard',
    // Route preserved (the /dashboard site picker still exists and is reachable
    // from sub-pages); only the launcher entry point is paused — flip back to
    // 'active' to restore the tile.
    route: '/dashboard',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'compliance',
    label: 'Compliance',
    description: 'Contract-tracked metrics and the seven-tile compliance slate.',
    icon: 'ShieldCheck',
    // Route preserved; flip back to 'active' to restore the tile.
    route: '/dashboard/[site]/compliance',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'reconciliation',
    label: 'Reconciliation',
    description: 'Reconcile recorded loads against MyMRC settlement records.',
    icon: 'Scale',
    // Route preserved; flip back to 'active' to restore the tile.
    route: '/dashboard/[site]/reconciliation',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'exports',
    label: 'Exports & Reports',
    description: 'Generate and download CSV exports and period reports.',
    icon: 'FileSpreadsheet',
    route: '/dashboard/exports',
    status: 'active',
    scope: 'manager+',
  },
  {
    key: 'admin',
    label: 'Admin & Audit',
    description: 'User management, role assignment, and the append-only audit log.',
    icon: 'UserCog',
    route: '/admin',
    status: 'active',
    scope: 'admin-only',
  },
];

// ── Coming-soon tiles (visible to everyone who passes the base gate) ───
const COMING_SOON_TILES: readonly DashboardTile[] = [
  {
    key: 'bulk-upload',
    label: 'Bulk Data Upload',
    description: 'Import historical loads and processor records from spreadsheets.',
    icon: 'Upload',
    route: '#',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'photo-annotation',
    label: 'Photo Annotation Canvas',
    description: 'Mark up load photos for compliance review and dispute evidence.',
    icon: 'PenTool',
    route: '#',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'processor-workflow',
    label: 'Processor Form Workflow',
    description: 'Guided processor intake and per-shift form completion.',
    icon: 'ClipboardList',
    route: '#',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'cip-capture',
    label: 'CIP Capture',
    description: 'Capture customer-identifying program data at intake.',
    icon: 'IdCard',
    route: '#',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'mrc-api',
    label: 'MRC API Integration',
    description: 'Direct MyMRC API sync for settlements and tonnage.',
    icon: 'Plug',
    route: '#',
    status: 'coming-soon',
    scope: 'manager+',
  },
  {
    key: 'observability',
    label: 'Observability',
    description: 'System health, ingest status, and operational metrics.',
    icon: 'Activity',
    // Lit up 2026-06-06: the observability backend is fully wired (T-123) —
    // Prometheus scrape, OTel traces → Tempo, errors → GlitchTip, Grafana
    // dashboard. Grafana isn't publicly exposed, so the tile opens the fleet
    // status surface for DR3 (reachable, CF-Access-gated). Admin-only; external
    // route → opens in a new tab (see VisionTile).
    route: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    status: 'active',
    scope: 'admin-only',
  },
];

/** The full ordered tile registry. */
export const DASHBOARD_TILES: readonly DashboardTile[] = [...ACTIVE_TILES, ...COMING_SOON_TILES];

type SessionLike = Pick<Session, 'user'> | null | undefined;

/**
 * ADR-0020 visibility matrix as a pure function.
 *
 * @param session        the authenticated session (null/operator → no tiles)
 * @param tile           the tile under test
 * @param woodlandSiteId Woodland's resolved site id (from Prisma), needed only
 *                       for the 'bonus' scope. Pass it for every call so the
 *                       bonus rule matches `src/lib/bonus/access.ts` exactly.
 */
export function canSeeTile(
  session: SessionLike,
  tile: DashboardTile,
  woodlandSiteId: string | null = null,
): boolean {
  const user = session?.user;
  if (!user?.id) return false;

  const role = user.role;
  // Operators never reach `/` (page redirects them to /operator); defend anyway.
  if (role !== 'manager' && role !== 'admin') return false;

  switch (tile.scope) {
    case 'manager+':
      return true;
    case 'admin-only':
      return role === 'admin';
    case 'bonus':
      if (role === 'admin') return true;
      // manager: Woodland-bound or both-sites (null) only — mirrors access.ts.
      return user.primary_site_id === woodlandSiteId || user.primary_site_id === null;
    default:
      return false;
  }
}

/**
 * Convenience: the tiles a session may see, in registry order.
 */
export function visibleTiles(
  session: SessionLike,
  woodlandSiteId: string | null = null,
): DashboardTile[] {
  return DASHBOARD_TILES.filter((t) => canSeeTile(session, t, woodlandSiteId));
}
