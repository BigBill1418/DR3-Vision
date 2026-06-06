// Bonus Management access guard (ADR-0019 "Routes" + ADR-0019.2 §1 Eugene
// enablement).
//
// As of the Sprint-2 addendum bonus is a MULTI-SITE surface (Woodland + Eugene).
// The access matrix (ADR-0019.2 §1) is:
//
//   - admin            (Bill, Kelsey)                       → {woodland, eugene}
//   - manager primary_site_code = woodland (Janette)        → {woodland}
//   - manager primary_site_code = eugene   (Rick)           → {eugene}
//   - manager primary_site_code = null     (Morena)         → {woodland}
//                                                             (California-ops
//                                                             scoped; NO Eugene)
//   - operator                                              → {} (denied; also
//                                                             never reaches /bonus
//                                                             — no Entra session)
//
// `checkBonusAccess(session, requestedSite?)` is the single source of truth for
// "who may see which site." It returns the allowed site list; with a
// `requestedSite` it narrows to that one site (and flips `allowed:false` if the
// caller can't reach it). No code anywhere hardcodes `siteCode === 'woodland'`;
// the site set is derived from the session role + the manager's primary site.
//
// `requireBonusAccess(requestedSite?)` is the route-handler workhorse: it runs
// the matrix, resolves the EFFECTIVE site (the requested one, else the picked
// site cookie, else the caller's first allowed site), loads that site row, and
// returns a {@link BonusContext}. It throws a `Response` on deny so handlers can
// `return` it directly. `tryBonusAccess()` is the page-friendly non-throwing
// wrapper.

import type { Session } from 'next-auth';
import { cookies } from 'next/headers';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

/** Canonical bonus site codes (mirror `sites.code`). */
export type SiteCode = 'woodland' | 'eugene';

/** Cookie that persists an admin's picked site across `/bonus/**` routes. */
export const BONUS_SITE_COOKIE = 'dr3_bonus_site' as const;

/**
 * Default site for callers who can reach more than one and haven't picked yet
 * (admins landing on a sub-route directly). Pages render a picker first; this is
 * only the route-layer fallback so an admin deep-linking an API never 400s.
 */
export const BONUS_SITE_CODE: SiteCode = 'woodland';

export interface BonusAccess {
  /** True if the caller may see at least one (or the requested) bonus site. */
  allowed: boolean;
  /** The site codes the caller may see. Empty when `allowed` is false. */
  sites: SiteCode[];
}

type SessionLike = Pick<Session, 'user'> | null | undefined;

function isSiteCode(v: string | null | undefined): v is SiteCode {
  return v === 'woodland' || v === 'eugene';
}

/**
 * Resolve which bonus sites a manager's `primary_site_id` grants. The session
 * carries the site *id* (a uuid), so we map id → code via the site table. A
 * `null` primary site is the California-ops manager (Morena): Woodland only.
 */
async function managerSitesFor(primarySiteId: string | null): Promise<SiteCode[]> {
  // Morena (null primary site) is California-ops scoped → Woodland only, no Eugene.
  if (primarySiteId === null || primarySiteId === undefined) return ['woodland'];

  const site = await prisma.site.findUnique({
    where: { id: primarySiteId },
    select: { code: true },
  });
  if (site && isSiteCode(site.code)) return [site.code];

  // Unknown / unmapped primary site → no access (defensive; should not happen
  // for a seeded manager).
  return [];
}

/**
 * ADR-0019.2 §1 access matrix. Pure over the session plus a single site lookup.
 *
 * @param session       the authenticated session (null/operator → denied)
 * @param requestedSite if set, narrow `sites` to just this one and flip
 *                      `allowed:false` when the caller can't reach it
 */
export async function checkBonusAccess(
  session: SessionLike,
  requestedSite?: SiteCode,
): Promise<BonusAccess> {
  const user = session?.user;
  if (!user?.id) return { allowed: false, sites: [] };

  const role = user.role;
  if (role !== 'manager' && role !== 'admin') return { allowed: false, sites: [] };

  // Admins (Bill, Kelsey) see both sites unconditionally.
  let sites: SiteCode[];
  if (role === 'admin') {
    sites = ['woodland', 'eugene'];
  } else {
    sites = await managerSitesFor(user.primary_site_id ?? null);
  }

  if (requestedSite) {
    if (sites.includes(requestedSite)) return { allowed: true, sites: [requestedSite] };
    return { allowed: false, sites: [] };
  }

  return { allowed: sites.length > 0, sites };
}

export interface BonusContext {
  /** The EFFECTIVE site id this request is scoped to. */
  siteId: string;
  siteCode: SiteCode;
  siteName: string;
  /** Every site code the caller may access (for shell "switch" affordances). */
  allowedSites: SiteCode[];
  /** The authenticated caller. */
  userId: string;
  name: string;
  email: string | null;
  role: 'manager' | 'admin';
  /** True for admin (Bill, Kelsey) — gates admin-only actions (amendment, override). */
  isAdmin: boolean;
  /** Caller's own primary_site_id (null = California-ops manager, Woodland-scoped). */
  primarySiteId: string | null;
}

/** Read the persisted picked-site cookie (admins), if any and valid. */
async function pickedSiteFromCookie(): Promise<SiteCode | undefined> {
  try {
    const store = await cookies();
    const v = store.get(BONUS_SITE_COOKIE)?.value;
    return isSiteCode(v) ? v : undefined;
  } catch {
    // Outside a request context (build) — no cookie.
    return undefined;
  }
}

/**
 * Route-handler guard. Throws a `Response` on deny:
 *   - no session                                  → 401
 *   - operator role                               → 403
 *   - caller can't reach the requested/effective site → 403
 *   - site row missing (misseed)                  → 404
 *
 * The effective site is, in precedence order: the explicit `requestedSite`
 * argument (a `?site=` param), then the picked-site cookie, then the caller's
 * first allowed site. On allow, returns the site-scoped {@link BonusContext}.
 */
export async function requireBonusAccess(requestedSite?: SiteCode): Promise<BonusContext> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }

  // First: does the caller have ANY bonus access at all?
  const base = await checkBonusAccess(session);
  if (!base.allowed) {
    throw new Response('forbidden', { status: 403 });
  }

  // Choose the effective site. An explicit request wins; otherwise the picked
  // cookie (admins); otherwise the caller's first allowed site.
  const cookieSite = requestedSite ? undefined : await pickedSiteFromCookie();
  const candidate = requestedSite ?? cookieSite ?? base.sites[0]!;

  // Re-check the candidate against the matrix (an admin's stale cookie is fine
  // because both sites are allowed; a manager can never escape their site).
  const scoped = await checkBonusAccess(session, candidate);
  if (!scoped.allowed) {
    throw new Response('forbidden', { status: 403 });
  }
  const effective = scoped.sites[0]!;

  const site = await prisma.site.findUnique({
    where: { code: effective },
    select: { id: true, code: true, name: true },
  });
  if (!site || !isSiteCode(site.code)) {
    throw new Response('bonus site not found', { status: 404 });
  }

  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    allowedSites: base.sites,
    userId: session.user.id,
    name: session.user.name ?? '',
    email: session.user.email ?? null,
    role: session.user.role as 'manager' | 'admin',
    isAdmin: session.user.role === 'admin',
    primarySiteId: session.user.primary_site_id ?? null,
  };
}

export type BonusAccessResult =
  | { ok: true; ctx: BonusContext }
  | { ok: false; status: 401 | 403 | 404 };

/** Page-friendly variant: discriminated result, never throws on access denial. */
export async function tryBonusAccess(requestedSite?: SiteCode): Promise<BonusAccessResult> {
  try {
    const ctx = await requireBonusAccess(requestedSite);
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof Response) {
      const s = e.status;
      if (s === 401 || s === 403 || s === 404) return { ok: false, status: s };
    }
    throw e;
  }
}

/** Narrow an arbitrary string (e.g. a `?site=` param) to a {@link SiteCode}. */
export function parseSiteCode(raw: string | null | undefined): SiteCode | undefined {
  return isSiteCode(raw) ? raw : undefined;
}

/** Pull a `?site=` {@link SiteCode} off a route Request URL, if present + valid. */
export function siteFromRequest(req: Request): SiteCode | undefined {
  try {
    return parseSiteCode(new URL(req.url).searchParams.get('site'));
  } catch {
    return undefined;
  }
}
