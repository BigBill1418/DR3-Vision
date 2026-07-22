// ADR-0046 Amendment 5 (D-M5-3) — second-approval routing + eligibility (leaf).
//
// Pure threshold + routing/eligibility helpers, kept dependency-free of
// `approvals.ts` so BOTH the first-leg (`decideRequest`, which routes a >= $1,000
// Approve to `pending_second_approval`) and the second-leg (`decideSecondApproval`)
// can import them without a circular module reference.

import type { PrismaClient } from '@prisma/client';

/** The confirmed-amount threshold (cents) that triggers a second approval. */
export const SECOND_APPROVAL_THRESHOLD_CENTS = 100_000; // $1,000.00

/** Spec §D-M5-3 decision (c) — minimum wait between first + self-second click. */
export const SECOND_APPROVAL_SELF_MIN_WAIT_MS = 30_000;

/** True when a confirmed amount requires a second approval (>= $1,000). */
export function requiresSecondApproval(confirmedAmountCents: number | null | undefined): boolean {
  return (
    typeof confirmedAmountCents === 'number' &&
    confirmedAmountCents >= SECOND_APPROVAL_THRESHOLD_CENTS
  );
}

/** The active OR clause for an `ap_second_approvers` row: no expiry, or in the future. */
function activeWhere(now: Date) {
  return { active: true, OR: [{ active_until: null }, { active_until: { gt: now } }] };
}

/**
 * The active second approvers for a site CODE ('woodland' | 'eugene'), resolved to
 * user ids + emails — the routing target for the entry notification. Empty for a
 * site with no rostered second approver (Woodland relies on admin-eligibility; the
 * notification then falls back to admins via the ap_notify pilot gate).
 */
export async function activeSecondApproversForSite(
  prisma: PrismaClient,
  siteCode: string,
  now: Date = new Date(),
): Promise<{ userIds: string[]; emails: string[] }> {
  const rows = await prisma.apSecondApprover.findMany({
    where: { site_id: siteCode, ...activeWhere(now) },
    select: { user_id: true },
  });
  const userIds = rows.map((r) => r.user_id);
  if (userIds.length === 0) return { userIds: [], emails: [] };
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, is_active: true, email: { not: null } },
    select: { email: true },
  });
  return { userIds, emails: users.map((u) => u.email).filter((e): e is string => !!e) };
}

/**
 * Can this actor fulfill the second approval for a request filed against `siteCode`?
 * Admin role is ALWAYS eligible (Bill — spec §D-M5-3 "Woodland → Bill, always
 * eligible"); otherwise the actor must hold an active `ap_second_approvers` row for
 * that site (Shannon for Eugene). Server-authoritative — the route never trusts the
 * client. NOT-DR3 requests never reach here (no site code).
 */
export async function canFulfillSecondApproval(
  prisma: PrismaClient,
  actor: { userId: string; role: string },
  siteCode: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (actor.role === 'admin') return true;
  const row = await prisma.apSecondApprover.findFirst({
    where: { user_id: actor.userId, site_id: siteCode, ...activeWhere(now) },
    select: { id: true },
  });
  return row !== null;
}

/** A human label for the routed second approver, for the first approver's UI
 * confirmation ("sent to Eugene → Shannon Rockwell"). */
export function secondApproverSiteLabel(siteCode: string): string {
  if (siteCode === 'woodland') return 'Woodland (Bill)';
  if (siteCode === 'eugene') return 'Eugene (Shannon Rockwell)';
  return siteCode;
}

/**
 * D-M5-3 — the "awaiting 2nd approval" badge count for THIS actor (spec: a distinct
 * count for second approvers). An admin (Bill) sees every request awaiting second
 * approval; a rostered second approver sees only the ones filed against the site(s)
 * they cover. Anyone who is neither sees 0 (they never fulfill a second approval).
 */
export async function awaitingSecondApprovalCount(
  prisma: PrismaClient,
  actor: { userId: string; role: string },
  now: Date = new Date(),
): Promise<number> {
  if (actor.role === 'admin') {
    return prisma.apRequest.count({ where: { status: 'pending_second_approval' } });
  }
  const rows = await prisma.apSecondApprover.findMany({
    where: { user_id: actor.userId, ...activeWhere(now) },
    select: { site_id: true },
  });
  const codes = Array.from(new Set(rows.map((r) => r.site_id)));
  if (codes.length === 0) return 0;
  const sites = await prisma.site.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });
  const siteIds = sites.map((s) => s.id);
  if (siteIds.length === 0) return 0;
  return prisma.apRequest.count({
    where: { status: 'pending_second_approval', site_id: { in: siteIds } },
  });
}
