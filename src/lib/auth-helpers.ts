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
  // A plain manager is hard-scoped to their primary site; an all-sites manager
  // (ADR-0024) reaches any site, like an admin, but without the admin role.
  if (
    role === 'manager' &&
    session.user.primary_site_id !== site.id &&
    session.user.all_sites !== true
  ) {
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

// ────────────────────────────────────────────────────────────────────
// Admin-only guard
//
// `/admin/*` (settings panel for user seeding) is gated to role=admin.
// Manager + operator both 403. Mirrors `requireManagerForSite` shape:
// throws Response on deny, returns the caller identity on allow.
// ────────────────────────────────────────────────────────────────────

export interface AdminContext {
  userId: string;
  email: string | null;
  name: string;
}

/**
 * Guard for /api/admin/* + /admin/* server pages.
 *
 * Throws a `Response` on failure so route handlers can `return` it
 * directly:
 *  - no session            -> 401
 *  - non-admin role        -> 403
 */
export async function requireAdmin(): Promise<AdminContext> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }
  if (session.user.role !== 'admin') {
    throw new Response('forbidden', { status: 403 });
  }
  return {
    userId: session.user.id,
    email: session.user.email ?? null,
    name: session.user.name ?? '',
  };
}

/** Page-friendly variant: discriminated result, no throw. */
export type AdminResult = { ok: true; ctx: AdminContext } | { ok: false; status: 401 | 403 };

export async function checkAdmin(): Promise<AdminResult> {
  try {
    const ctx = await requireAdmin();
    return { ok: true, ctx };
  } catch (e) {
    if (e instanceof Response) {
      const s = e.status;
      if (s === 401 || s === 403) return { ok: false, status: s };
    }
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// ADR-0040 D5 — scoped rate-table access
//
// Two gates for the four billing-rate tables (transport_rate_tiers,
// account_haul_rates, container_rental_sites, fuel_prices):
//   - READ  = manager OR admin (`requireRateRead`)
//   - WRITE = admin OR the `can_manage_rates` flag (`requireRateManager`)
//
// `can_manage_rates` is read FRESH from the DB on every write (never carried in the
// session token) and is consulted NOWHERE ELSE — it grants exactly these four
// tables' writes and NEVER any admin power (hard rule #2 discipline). Because
// `requireAdmin()` above checks `role === 'admin'` only, the flag cannot unlock any
// `/admin/*` surface by construction.
// ────────────────────────────────────────────────────────────────────────

export interface RateReadContext {
  userId: string;
  role: 'manager' | 'admin';
}

/** READ gate for the rate tables. no session → 401; operator → 403. */
export async function requireRateRead(): Promise<RateReadContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') throw new Response('forbidden', { status: 403 });
  return { userId: session.user.id, role };
}

export interface RateManagerContext {
  userId: string;
  role: 'manager' | 'admin';
  /** How write access was granted — for the audit/log line. */
  via: 'admin' | 'can_manage_rates';
}

/**
 * WRITE gate for the rate tables. Grants iff `role === 'admin'` OR the caller's
 * (fresh-from-DB) `can_manage_rates` flag is true. no session → 401; anyone else
 * (operator, or a manager without the flag) → 403.
 */
export async function requireRateManager(): Promise<RateManagerContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  const role = session.user.role;
  if (role === 'admin') return { userId: session.user.id, role, via: 'admin' };
  if (role === 'manager') {
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { can_manage_rates: true },
    });
    if (u?.can_manage_rates) return { userId: session.user.id, role, via: 'can_manage_rates' };
  }
  throw new Response('forbidden', { status: 403 });
}

export type RateReadResult = { ok: true; ctx: RateReadContext } | { ok: false; status: 401 | 403 };

export async function checkRateRead(): Promise<RateReadResult> {
  try {
    return { ok: true, ctx: await requireRateRead() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}

export type RateManagerResult =
  | { ok: true; ctx: RateManagerContext }
  | { ok: false; status: 401 | 403 };

export async function checkRateManager(): Promise<RateManagerResult> {
  try {
    return { ok: true, ctx: await requireRateManager() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// 2026-07-09 rollup §1.2 — read-only billing-verify access
//
// One gate for the single read surface `/admin/billing/verify` (invoices ready
// for GP entry + the ADR-0039 findings touching their windows). Grants iff
// `role === 'admin'` OR a MANAGER whose fresh-from-DB `can_view_billing_verify`
// flag is true — exactly the `can_manage_rates` shape (hard rule #2: admin
// powers stay `role === 'admin'`; a scoped manager flag grants exactly one
// surface and no admin power; operators never). The context carries the
// caller's SITE REACH so the page scopes what it renders (rule #2's cross-site
// clause): admin or manager+`all_sites` → both sites; a single-site manager
// sees only their primary site. Mary's intended grant is therefore manager +
// `all_sites` + this flag (she bills both CA and OR). The flag is read fresh
// on every request, never carried in the session token, and consulted
// NOWHERE ELSE.
// ────────────────────────────────────────────────────────────────────────

export interface BillingVerifyContext {
  userId: string;
  /** How access was granted — for the log line. */
  via: 'admin' | 'can_view_billing_verify';
  /** Cross-site reach (admin, or manager with all_sites — ADR-0024). */
  allSites: boolean;
  /** The manager's primary site id when reach is single-site; null for admin. */
  primarySiteId: string | null;
}

/** READ gate for /admin/billing/verify. no session → 401; ungranted → 403. */
export async function requireBillingVerifyRead(): Promise<BillingVerifyContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  if (session.user.role === 'admin') {
    return { userId: session.user.id, via: 'admin', allSites: true, primarySiteId: null };
  }
  if (session.user.role === 'manager') {
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { can_view_billing_verify: true, all_sites: true, primary_site_id: true },
    });
    if (u?.can_view_billing_verify) {
      return {
        userId: session.user.id,
        via: 'can_view_billing_verify',
        allSites: u.all_sites,
        primarySiteId: u.primary_site_id,
      };
    }
  }
  throw new Response('forbidden', { status: 403 });
}

export type BillingVerifyResult =
  | { ok: true; ctx: BillingVerifyContext }
  | { ok: false; status: 401 | 403 };

export async function checkBillingVerifyRead(): Promise<BillingVerifyResult> {
  try {
    return { ok: true, ctx: await requireBillingVerifyRead() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}
