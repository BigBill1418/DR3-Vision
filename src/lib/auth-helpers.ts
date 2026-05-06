// Sprint-1 T-013 - shared auth guards for manager/admin-scoped surfaces.
//
// `requireManagerForSite` is the canonical guard for any handler or
// page that must:
//   - reject anonymous visitors (401-ish via Response or redirect)
//   - reject the operator role (403)
//   - allow admin role unconditionally
//   - allow manager role only if their primary_site_id matches the
//     site whose code is in the request
//
// CLAUDE.md hard-rule #2 - "Eugene and Woodland are strictly separated.
// Every query, list, export, alert is scoped to one site by default.
// Cross-site rollups require admin role." This guard is one of the
// places that rule lives.
//
// T-010 + T-011 both need a similar guard for the manager workflow
// pages they're building in parallel; this module is intentionally
// route-handler-friendly (throws Response on failure) rather than
// page-friendly (would redirect). Pages catch the Response and decide
// whether to redirect or render their own 403 surface.

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export interface ManagerSiteContext {
  siteId: string;
  siteCode: string;
  siteName: string;
  userId: string;
  role: 'manager' | 'admin';
}

/**
 * Guard for /api/exports/* and /dashboard/exports.
 *
 * Throws a `Response` on failure so route handlers can `return` it
 * directly. On success, returns the resolved site + caller identity.
 *
 * Failure modes:
 *  - no session            -> 401
 *  - operator role         -> 403
 *  - unknown site code     -> 404
 *  - manager off-site      -> 403
 */
export async function requireManagerForSite(siteCode: string): Promise<ManagerSiteContext> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') {
    throw new Response('forbidden', { status: 403 });
  }
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) {
    throw new Response('site not found', { status: 404 });
  }
  if (role === 'manager' && session.user.primary_site_id !== site.id) {
    throw new Response('forbidden', { status: 403 });
  }
  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    userId: session.user.id,
    role,
  };
}

/**
 * Pre-page-render variant. Same access rules but on failure returns a
 * tagged discriminated result instead of throwing - so the page can
 * choose between redirecting and rendering its own forbidden surface.
 */
export type ManagerSiteResult =
  | { ok: true; ctx: ManagerSiteContext }
  | { ok: false; status: 401 | 403 | 404 };

export async function checkManagerForSite(siteCode: string): Promise<ManagerSiteResult> {
  try {
    const ctx = await requireManagerForSite(siteCode);
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof Response) {
      const s = e.status;
      if (s === 401 || s === 403 || s === 404) return { ok: false, status: s };
    }
    throw e;
  }
}
