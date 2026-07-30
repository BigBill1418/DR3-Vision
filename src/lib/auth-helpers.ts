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
// ADR-0060 — floor (operator) guard for the iPad inventory-validation surfaces
//
// `requireOperatorForSite` is the canonical guard for the floor write path
// (`/api/operator/[site]/**` and the `/operator/[site]/{today,inbound,count,processed}`
// pages). It mirrors `requireManagerForSite` and the inline `ctx()` pattern in
// `src/app/operator/[site]/actions.ts`, but is OPERATORS-ONLY on purpose:
//
//   - no session               -> 401
//   - role !== 'operator'       -> 403  (managers/admins use the DESKTOP surfaces;
//                                        granting them the floor path would make the
//                                        audit actor ambiguous — ADR-0060 D2)
//   - unknown site code         -> 404
//   - operator off their site   -> 403  (operators are always single-site —
//                                        all_sites:false per ADR-0030 — so there is
//                                        no cross-site branch here)
//
// Every floor write re-derives operator + site from the session server-side; a
// client-supplied siteId/userId is NEVER trusted (same rule as actions.ts).
// ────────────────────────────────────────────────────────────────────

export interface OperatorSiteContext {
  siteId: string;
  siteCode: string;
  siteName: string;
  userId: string;
}

/**
 * Guard for /api/operator/* + the floor pages. Throws a `Response` on failure so
 * route handlers can `return` it directly; on success returns the resolved site +
 * operator identity.
 */
export async function requireOperatorForSite(siteCode: string): Promise<OperatorSiteContext> {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Response('unauthenticated', { status: 401 });
  }
  if (session.user.role !== 'operator') {
    throw new Response('forbidden', { status: 403 });
  }
  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true },
  });
  if (!site) {
    throw new Response('site not found', { status: 404 });
  }
  // Operators are hard-scoped to their primary site (ADR-0030 — never all_sites).
  if (session.user.primary_site_id !== site.id) {
    throw new Response('forbidden', { status: 403 });
  }
  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    userId: session.user.id,
  };
}

/**
 * Pre-page-render variant of {@link requireOperatorForSite}. Same access rules but
 * returns a tagged discriminated result instead of throwing, so a floor page can
 * redirect to `/operator/[site]` (re-auth) on failure rather than rendering a raw 403.
 */
export type OperatorSiteResult =
  | { ok: true; ctx: OperatorSiteContext }
  | { ok: false; status: 401 | 403 | 404 };

export async function checkOperatorForSite(siteCode: string): Promise<OperatorSiteResult> {
  try {
    const ctx = await requireOperatorForSite(siteCode);
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

// ────────────────────────────────────────────────────────────────────────
// AP invoice-history read gate (ADR-0046 Amendment 5, D-M5-5)
//
// One gate for the single read surface `/admin/ap/history` (the union of Vision
// invoices + Bill's imported AP history). Grants iff `role === 'admin'` OR the
// caller's fresh-from-DB `can_view_ap_history` flag is true — the same
// scoped-flag shape as can_view_billing_verify (hard rule #2: the flag unlocks
// exactly this page and no admin power). The intended grantees are the DESIGNATED
// SECOND APPROVERS (Bill implicitly via admin; Shannon via the flag), NOT the
// general ap_approvers roster (operators must never see historical AP data). The
// flag is read fresh every request, never carried in the session token, and is
// consulted NOWHERE ELSE.
// ────────────────────────────────────────────────────────────────────────

export interface ApHistoryContext {
  userId: string;
  /** How access was granted — for the log line. */
  via: 'admin' | 'can_view_ap_history';
}

/** READ gate for /admin/ap/history. no session → 401; ungranted → 403. */
export async function requireApHistoryRead(): Promise<ApHistoryContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  if (session.user.role === 'admin') {
    return { userId: session.user.id, via: 'admin' };
  }
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { can_view_ap_history: true },
  });
  if (u?.can_view_ap_history) {
    return { userId: session.user.id, via: 'can_view_ap_history' };
  }
  throw new Response('forbidden', { status: 403 });
}

export type ApHistoryResult =
  | { ok: true; ctx: ApHistoryContext }
  | { ok: false; status: 401 | 403 };

export async function checkApHistoryRead(): Promise<ApHistoryResult> {
  try {
    return { ok: true, ctx: await requireApHistoryRead() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// AP equipment-request resolution gate (ADR-0046 Amendment 9, §2.5)
//
// `/admin/ap/equipment-requests` is a DELIBERATE, documented exception to
// "/admin/* is admin-only". It is the one `/admin` surface whose whole point is
// that a NON-admin acts on it: the people who know whether "the yellow forklift
// unit 7" is already on the books are the SITE MANAGERS, not Bill. Routing every
// unknown asset through the single admin recreates exactly the bottleneck the
// escape hatch exists to remove — the requests would queue behind one person and
// the approvers would go back to ticking "Not equipment-related".
//
// It is scoped the same narrow way as `can_view_ap_history` /
// `can_view_billing_verify`, and the discipline of hard rule #2 is intact:
//   - admin POWERS still gate on `role === 'admin'` — this flag unlocks exactly
//     this worklist and its resolve/reject writes, and NOTHING else. It does not
//     open /admin/users, /admin/equipment's CRUD screen, bonus override, or any
//     other /admin route.
//   - it is read FRESH from Postgres on every request, never carried in the JWT.
//   - it is NOT the `ap_approvers` roster. An approver FILES a request; a site
//     manager RESOLVES it. Deliberately different sets — the person who could not
//     find the asset is not the person who decides what it is.
//   - SITE REACH still applies (hard rule #2's cross-site clause): the context
//     carries the caller's reach so the page and the writes scope to it. A
//     single-site manager sees and resolves only their own site's requests; admins
//     and `all_sites` managers see both.
// ────────────────────────────────────────────────────────────────────────

export interface EquipmentRequestContext {
  userId: string;
  /** How access was granted — for the log line. */
  via: 'admin' | 'can_resolve_equipment_requests';
  /** Cross-site reach (admin, or manager with all_sites — ADR-0024). */
  allSites: boolean;
  /** The manager's primary site id when reach is single-site; null for admin. */
  primarySiteId: string | null;
}

/** Gate for /admin/ap/equipment-requests + its API. no session → 401; ungranted → 403. */
export async function requireEquipmentRequestAccess(): Promise<EquipmentRequestContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  if (session.user.role === 'admin') {
    return { userId: session.user.id, via: 'admin', allSites: true, primarySiteId: null };
  }
  if (session.user.role === 'manager') {
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { can_resolve_equipment_requests: true, all_sites: true, primary_site_id: true },
    });
    if (u?.can_resolve_equipment_requests) {
      return {
        userId: session.user.id,
        via: 'can_resolve_equipment_requests',
        allSites: u.all_sites,
        primarySiteId: u.primary_site_id,
      };
    }
  }
  throw new Response('forbidden', { status: 403 });
}

export type EquipmentRequestResult =
  | { ok: true; ctx: EquipmentRequestContext }
  | { ok: false; status: 401 | 403 };

export async function checkEquipmentRequestAccess(): Promise<EquipmentRequestResult> {
  try {
    return { ok: true, ctx: await requireEquipmentRequestAccess() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}

/**
 * The site-id filter implied by a caller's reach, for
 * `listEquipmentRequests({ siteIds })`.
 *
 * `undefined` = every site. A single-site manager with a null `primary_site_id`
 * (California-ops shape) gets an EMPTY array — no reach, no rows — rather than
 * `undefined`, because defaulting a reach-less caller to "all sites" is precisely
 * the direction that leaks across the Eugene/Woodland boundary.
 */
export function siteScopeFor(ctx: EquipmentRequestContext): string[] | undefined {
  if (ctx.allSites) return undefined;
  return ctx.primarySiteId ? [ctx.primarySiteId] : [];
}

// ────────────────────────────────────────────────────────────────────────
// ADR-0069 — read gate for /admin/doc-ingest/reconciliation
//
// Deliberately a MANAGER-reachable surface, unlike the rest of /admin/doc-ingest.
// Those pages are admin-only for a specific reason: they list sources whose
// `site_id` is NULL, and an unclassified document must not appear in any
// site-scoped view. That reason does not apply here. Every row on the
// reconciliation screen comes from `doc_reference_rows`, whose `site_id` is NOT
// NULL by schema constraint — absorption refuses an unclassified document rather
// than guessing a site — so there is nothing unscoped to leak.
//
// And the audience is right: the person who can say whether the spreadsheet or
// Vision is correct for a given day is the site manager who was there, not Bill.
//
// Site REACH still applies in full (hard rule #2): admin and `all_sites` managers
// see both sites; a plain manager sees their own. No admin POWER is granted —
// this gate unlocks exactly this read and nothing else.
// ────────────────────────────────────────────────────────────────────────

export interface ReconciliationReadContext {
  userId: string;
  /** How access was granted — for the log line. */
  via: 'admin' | 'manager';
  /** Cross-site reach (admin, or manager with all_sites — ADR-0024). */
  allSites: boolean;
  /** The manager's primary site id when reach is single-site; null for admin. */
  primarySiteId: string | null;
}

export async function requireReconciliationRead(): Promise<ReconciliationReadContext> {
  const session = await auth();
  if (!session?.user?.id) throw new Response('unauthenticated', { status: 401 });
  if (session.user.role === 'admin') {
    return { userId: session.user.id, via: 'admin', allSites: true, primarySiteId: null };
  }
  if (session.user.role === 'manager') {
    // Read FRESH from Postgres, never from the JWT: a reach change must take
    // effect on the next request, not on the next sign-in.
    const u = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { all_sites: true, primary_site_id: true },
    });
    if (u) {
      return {
        userId: session.user.id,
        via: 'manager',
        allSites: u.all_sites,
        primarySiteId: u.primary_site_id,
      };
    }
  }
  throw new Response('forbidden', { status: 403 });
}

export type ReconciliationReadResult =
  | { ok: true; ctx: ReconciliationReadContext }
  | { ok: false; status: 401 | 403 };

export async function checkReconciliationRead(): Promise<ReconciliationReadResult> {
  try {
    return { ok: true, ctx: await requireReconciliationRead() };
  } catch (e) {
    if (e instanceof Response && (e.status === 401 || e.status === 403)) {
      return { ok: false, status: e.status };
    }
    throw e;
  }
}

/**
 * Resolve a reconciliation caller's reach to concrete site ids.
 *
 * Returns an EMPTY array — not "every site" — for a manager with no primary site.
 * Defaulting a reach-less caller to all sites is exactly the direction that leaks
 * across the Eugene/Woodland boundary, so the failure mode is "sees nothing".
 */
export async function reconciliationSiteIds(ctx: ReconciliationReadContext): Promise<string[]> {
  if (ctx.allSites) {
    const sites = await prisma.site.findMany({ select: { id: true }, orderBy: { name: 'asc' } });
    return sites.map((s) => s.id);
  }
  return ctx.primarySiteId ? [ctx.primarySiteId] : [];
}
