// ADR-0046 §3 amendment (handoff §1.6a/b) — the AP approver ROSTER as data.
//
// Supersedes the original C5 "approver set = org reach (admin OR all_sites)".
// The approvers are now an explicit, expiry-aware roster: the `ap_approvers`
// table (Morena/Rick/Janette permanent; Kelsey until 2026-08-08). Bill is admin
// and therefore always permitted without a roster row. A single-site MANAGER who
// is on the roster (Rick/Janette) is a valid approver even though they lack
// `all_sites` — permission here is roster membership, not site reach.
//
// A row is ACTIVE when `active_until IS NULL OR active_until > now()`. Expired
// rows are excluded from every resolution here (and reaped daily by the expiry
// job, ADR-0046 §3 amendment / handoff §1.6f).

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import type { OpsIdentity } from '@/lib/ops/viewer';

/** The active OR clause: no expiry, or an expiry strictly in the future. */
function activeWhere(now: Date) {
  return { OR: [{ active_until: null }, { active_until: { gt: now } }] };
}

/** User ids of all currently-active approvers (expiry-aware). */
export async function activeApproverUserIds(
  prisma: PrismaClient = defaultPrisma,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await prisma.apApprover.findMany({
    where: activeWhere(now),
    select: { user_id: true },
  });
  return rows.map((r) => r.user_id);
}

/**
 * The approver set as email addresses (ADR-0046 §3 amendment). Resolves the
 * active roster's user ids to active users with a non-null email. REPLACES the
 * old all_sites-based `apApproverEmails` in approvals.ts (re-exported there so
 * poll.ts keeps importing it from `./approvals`).
 */
export async function apApproverEmails(prisma: PrismaClient = defaultPrisma): Promise<string[]> {
  const ids = await activeApproverUserIds(prisma);
  if (ids.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { id: { in: ids }, is_active: true, email: { not: null } },
    select: { email: true },
  });
  return rows.map((r) => r.email).filter((e): e is string => !!e);
}

/** True when `userId` is an active approver (roster membership, expiry-aware). */
export async function isActiveApprover(
  prisma: PrismaClient = defaultPrisma,
  userId: string,
): Promise<boolean> {
  const row = await prisma.apApprover.findFirst({
    where: { user_id: userId, ...activeWhere(new Date()) },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Can this identity act on an AP request? Admin (Bill) always may; otherwise the
 * caller must be an active roster approver. A single-site manager who is on the
 * roster passes here even without `all_sites` (permission is roster membership,
 * not site reach — hard rule #2: this is neither an admin power nor site reach).
 */
export async function canActOnApRequest(
  identity: { role: string; userId: string },
  prisma: PrismaClient = defaultPrisma,
): Promise<boolean> {
  if (identity.role === 'admin') return true;
  return isActiveApprover(prisma, identity.userId);
}

/**
 * Guard for the AP queue + decide + attachment + resend routes. Mirrors
 * requireOrgReach() (throws a `Response` so route handlers can return it), but
 * permits admin OR an active roster approver — so all five approvers (incl.
 * single-site Rick/Janette) reach the org-level AP queue. 401 unauthenticated,
 * 403 authenticated-but-not-an-approver.
 */
export async function requireApApprover(prisma: PrismaClient = defaultPrisma): Promise<OpsIdentity> {
  // Lazy import: keep the NextAuth/session graph OUT of the pure roster-data
  // path (approvals.ts + poll.ts import the data helpers from here and must not
  // drag `@/lib/auth` into their module graph).
  const { currentOpsViewer } = await import('@/lib/ops/viewer');
  const id = await currentOpsViewer();
  if (!id) throw new Response('unauthenticated', { status: 401 });
  const ok = await canActOnApRequest({ role: id.viewer.role, userId: id.userId }, prisma);
  if (!ok) throw new Response('forbidden', { status: 403 });
  return id;
}
