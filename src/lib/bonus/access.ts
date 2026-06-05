// Bonus Management access guard (ADR-0019 "Routes" section + SPRINT-2-HANDOFF
// hard rule #1: bonus routes are Woodland-scoped; Rick (Eugene manager) gets 403
// on every /bonus/* route, checked at the page layer AND the API layer).
//
// Mirrors the shape of `src/lib/auth-helpers.ts` (requireManagerForSite /
// checkManagerForSite): the `require*` variant throws a `Response` so route
// handlers can `return` it directly; the `check*` variant returns a discriminated
// result so pages can choose redirect vs. render-their-own-403.
//
// WHO MAY ACCESS BONUS (ADR-0019):
//   - admin            (Bill, Kelsey)                      → allow
//   - manager, primary_site_id = Woodland (Janette)        → allow
//   - manager, primary_site_id = null  → both sites (Morena) → allow
//   - manager, primary_site_id = Eugene (Rick)             → 403
//   - operator                                             → 403 (and can't reach
//                                                            it — no Entra session)
//
// This is the single source of bonus authorization. Every /bonus page and
// /api/bonus route calls through it. The `siteId` it returns is always Woodland's
// (bonus is Woodland-only in V2); the schema is site-scoped so a future Eugene
// enablement only relaxes this guard.

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const BONUS_SITE_CODE = 'woodland' as const;

export interface BonusContext {
  /** Woodland's site id — the scope for all bonus queries. */
  siteId: string;
  siteCode: string;
  siteName: string;
  /** The authenticated caller. */
  userId: string;
  name: string;
  email: string | null;
  role: 'manager' | 'admin';
  /** True for admin (Bill, Kelsey) — gates admin-only actions (amendment, override). */
  isAdmin: boolean;
  /** Caller's own primary_site_id (null = operations manager, both sites). */
  primarySiteId: string | null;
}

/**
 * Route-handler guard. Throws a `Response` on deny:
 *   - no session                        → 401
 *   - operator role                     → 403
 *   - manager bound to a non-Woodland site (Rick) → 403
 *   - Woodland site row missing (misseed) → 404
 * On allow, returns the Woodland-scoped {@link BonusContext}.
 */
export async function requireBonusAccess(): Promise<BonusContext> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') {
    throw new Response('forbidden', { status: 403 });
  }

  const site = await prisma.site.findUnique({
    where: { code: BONUS_SITE_CODE },
    select: { id: true, code: true, name: true },
  });
  if (!site) {
    throw new Response('bonus site not found', { status: 404 });
  }

  // Managers may access bonus only if they are the Woodland manager OR the
  // both-sites operations manager (primary_site_id = null). A manager bound to
  // another site (Eugene/Rick) is denied. Admins are unconditional.
  if (role === 'manager') {
    const primary = session.user.primary_site_id;
    const isWoodlandManager = primary === site.id;
    const isBothSitesManager = primary === null || primary === undefined;
    if (!isWoodlandManager && !isBothSitesManager) {
      throw new Response('forbidden', { status: 403 });
    }
  }

  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    userId: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email ?? null,
    role,
    isAdmin: role === 'admin',
    primarySiteId: session.user.primary_site_id ?? null,
  };
}

export type BonusAccessResult =
  | { ok: true; ctx: BonusContext }
  | { ok: false; status: 401 | 403 | 404 };

/** Page-friendly variant: discriminated result, never throws on access denial. */
export async function checkBonusAccess(): Promise<BonusAccessResult> {
  try {
    const ctx = await requireBonusAccess();
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof Response) {
      const s = e.status;
      if (s === 401 || s === 403 || s === 404) return { ok: false, status: s };
    }
    throw e;
  }
}
