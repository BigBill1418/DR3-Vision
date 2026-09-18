// ADR-0046 Amendment 5 (D-M5-3) — second-approval routing + eligibility (leaf).
//
// Pure threshold + routing/eligibility helpers, kept dependency-free of
// `approvals.ts` so BOTH the first-leg (`decideRequest`, which routes a >= $1,000
// Approve to `pending_second_approval`) and the second-leg (`decideSecondApproval`)
// can import them without a circular module reference.

import type { PrismaClient } from '@prisma/client';
// ADR-0066 §1.4 — the shared resolver. Safe to import here: the resolver depends on
// nothing but Prisma types, so this stays free of the `approvals.ts` cycle this
// module was split out to avoid.
import { canFulfillSecondApprovalByRouting } from './second-approval-resolver';

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
 * ⛔ SUPERSEDED BY ADR-0066 — DO NOT USE FOR AUTHORIZATION OR FOR ANY UI FLAG.
 *
 * The pre-0066 site model: admin is always eligible, otherwise the actor needs an
 * active `ap_second_approvers` row for the request's site. Person→person routing
 * (`ap_approval_routing`) replaced it, and the legacy table was left holding a
 * single row (Shannon/eugene) — so this function answers FALSE for every routed
 * peer that ADR-0066 made eligible.
 *
 * Calling it anywhere a decision is made or displayed reproduces the 2026-09-18
 * incident: the AP detail route used it for the panel's `eligible` flag while
 * `decideSecondApproval` used the resolver, so four managers were shown no button
 * for a write the server would have accepted. 38 of 38 second approvals fell to
 * Bill between 2026-07-28 and 2026-09-18.
 *
 * Use {@link canFulfillSecondApprovalByRouting} instead. Retained only so the
 * existing tests can pin the legacy behaviour and prove nothing reads it in anger.
 *
 * @deprecated Use `canFulfillSecondApprovalByRouting` from `./second-approval-resolver`.
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
 * approval; everyone else sees exactly the requests they can actually FULFILL.
 *
 * ADR-0066 incident (2026-09-18): this used to count the pre-0066 per-site
 * `ap_second_approvers` roster, which holds a single row (Shannon/eugene). Every
 * routed peer therefore got 0 — so the four managers were never told a >= $1,000
 * invoice was waiting on them, on top of not being offered the button.
 *
 * The count is now resolved PER ROW through `canFulfillSecondApprovalByRouting` —
 * the same function that authorizes the write and shapes the panel. Resolving each
 * candidate row is deliberate: it makes the badge correct BY CONSTRUCTION rather
 * than by a parallel query that can drift out of agreement again. The candidate set
 * is the `pending_second_approval` backlog (single digits in practice), so the extra
 * round-trips are not a concern.
 */
export async function awaitingSecondApprovalCount(
  prisma: PrismaClient,
  actor: { userId: string; role: string },
): Promise<number> {
  if (actor.role === 'admin') {
    return prisma.apRequest.count({ where: { status: 'pending_second_approval' } });
  }
  const rows = await prisma.apRequest.findMany({
    where: { status: 'pending_second_approval' },
    select: { site_id: true, first_approver_id: true, escalated_at: true, filed_not_dr3: true },
  });
  let n = 0;
  for (const r of rows) {
    // NOT-DR3 / siteless rows are not fulfillable from this leg.
    if (!r.site_id || r.filed_not_dr3) continue;
    const ok = await canFulfillSecondApprovalByRouting(prisma, actor, {
      firstApproverId: r.first_approver_id ?? '',
      escalated: r.escalated_at != null,
      requestSiteId: r.site_id,
    });
    if (ok) n++;
  }
  return n;
}
