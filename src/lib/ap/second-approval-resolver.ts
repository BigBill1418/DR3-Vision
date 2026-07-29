// ADR-0066 §1.4 — THE shared second-approval resolver.
//
// ── Why this module exists ──────────────────────────────────────────────────
// Before this, two separate code paths answered two halves of the same question
// and disagreed:
//
//   canFulfillSecondApproval()      → `if (actor.role === 'admin') return true`
//                                      then an `ap_second_approvers` roster check
//   activeSecondApproversForSite()  → the roster check ALONE
//
// Admin-eligibility made Bill authorized; the roster query made him invisible.
// Bill was deliberately never given a `woodland` roster row precisely because
// admin-eligibility covered his authority — so every Woodland second-approval
// request resolved to an EMPTY recipient set. The notify path is fail-soft, so it
// sent nothing and raised nothing. Invoices >= $1,000 sat unapproved and
// invisible for days. Shannon (an explicit `eugene` row) was notified normally,
// which is why it looked healthy from the Eugene side.
//
// The fix is not "add Bill to the roster" — that patches one instance of a
// structural bug. BOTH the authorization check and the notification lookup now
// consume THIS function, so they cannot drift apart again.
//
// ── The invariant ───────────────────────────────────────────────────────────
// `recipients` is NON-EMPTY whenever `authorizedUserIds` is non-empty.
//
// That is the property whose violation caused the outage, and it is asserted
// directly in `second-approval-resolver.test.ts`. If routing cannot produce a
// reachable human, this module falls back to reachable admins AND reports a
// `problems` entry — it never returns "authorized by someone, notifiable by
// nobody".
//
// ── Fail-soft vs. fail-silent ───────────────────────────────────────────────
// Fail-soft is correct for the notification itself: a paging failure must never
// roll back a committed approval. But fail-soft over an EMPTY recipient set is
// indistinguishable from success — that indistinguishability IS the bug. So the
// resolver reports `problems`, and the caller raises a real alarm on them while
// still never failing the approval.

import type { PrismaClient } from '@prisma/client';

/** A resolved, reachable notification target. */
export interface ResolvedRecipient {
  userId: string;
  email: string;
  name: string;
}

/** Why the resolver landed on the recipients it did. */
export type RoutingOutcome =
  /** A routing row existed and its second approver is reachable. */
  | 'routed'
  /** No active routing row for this first approver → immediate fallback (§1.4). */
  | 'fallback_no_routing_row'
  /** A routing row existed but its second approver is unreachable (inactive/no email). */
  | 'fallback_unreachable_peer'
  /** The request has escalated past its weekday-clock deadline (§1.5). */
  | 'escalated';

export interface SecondApprovalRouting {
  /**
   * Everyone who MAY fulfill the second approval. Admin-eligibility is preserved
   * deliberately — the handoff's DO-NOT list is explicit that the AUTHORIZATION
   * rule is correct and only routing/notification change.
   */
  authorizedUserIds: string[];
  /**
   * Who actually gets emailed. Never a broadcast: the routed individual, plus the
   * fallback approver once escalated. Guaranteed non-empty when `authorizedUserIds`
   * is non-empty (see the invariant above).
   */
  recipients: ResolvedRecipient[];
  /** The individual this request is routed to (null only when nothing resolved). */
  routedTo: ResolvedRecipient | null;
  outcome: RoutingOutcome;
  /**
   * Misconfigurations worth surfacing. Non-empty means SOMETHING IS WRONG even
   * though the caller still proceeds fail-soft: each entry becomes a warning line
   * in Bill's 06:00 digest (§1.7) and, for the empty-recipient case, an immediate
   * page + email (§B.5).
   */
  problems: string[];
}

/** Roles that may hold AP approval authority at all. */
const APPROVER_ROLES = ['manager', 'admin'] as const;

interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  is_active: boolean;
}

/** Reachable = active, an approver role, and has an address we can actually send to. */
function isReachable(u: UserRow | null | undefined): u is UserRow & { email: string } {
  return (
    !!u &&
    u.is_active &&
    typeof u.email === 'string' &&
    u.email.length > 0 &&
    (APPROVER_ROLES as readonly string[]).includes(u.role)
  );
}

function toRecipient(u: UserRow & { email: string }): ResolvedRecipient {
  return { userId: u.id, email: u.email, name: u.name };
}

const USER_SELECT = { id: true, name: true, email: true, role: true, is_active: true } as const;

/**
 * Resolve who may sign, and who to tell, for a request whose FIRST approval was
 * made by `firstApproverId`.
 *
 * Routing is person→person (§1.4) and no longer depends on the request's site.
 * `escalated` widens the recipient set to include the fallback approver; it never
 * removes the original peer — escalation is ADDITIVE, not a transfer (§1.5).
 */
export async function resolveSecondApproval(
  prisma: PrismaClient,
  args: { firstApproverId: string; escalated?: boolean },
): Promise<SecondApprovalRouting> {
  const problems: string[] = [];

  const routing = await prisma.apApprovalRouting.findFirst({
    where: { first_approver_id: args.firstApproverId, active: true },
    select: { second_approver_id: true, fallback_approver_id: true },
  });

  // Admins are always authorized (unchanged rule) AND are the reachable backstop
  // that makes the non-empty-recipients invariant hold.
  const admins = (await prisma.user.findMany({
    where: { role: 'admin', is_active: true, deleted_at: null },
    select: USER_SELECT,
  })) as UserRow[];
  const reachableAdmins = admins.filter(isReachable).map(toRecipient);

  if (reachableAdmins.length === 0) {
    // Catastrophic config state: nobody at all can be told anything.
    problems.push(
      'No active admin with an email address exists — there is no reachable backstop for AP second approvals.',
    );
  }

  let outcome: RoutingOutcome = 'routed';
  let routedTo: ResolvedRecipient | null = null;
  const recipients: ResolvedRecipient[] = [];
  const authorized = new Set<string>(admins.map((a) => a.id));

  if (!routing) {
    // §1.4: "Any approver without a row falls back to Bill IMMEDIATELY (no 24h
    // wait) and raises a warning line in Bill's morning digest."
    outcome = 'fallback_no_routing_row';
    const who = await prisma.user.findUnique({
      where: { id: args.firstApproverId },
      select: USER_SELECT,
    });
    problems.push(
      `No active ap_approval_routing row for first approver ${who?.name ?? args.firstApproverId} — falling back to admin. Configure the pair at /admin/ap/routing.`,
    );
    recipients.push(...reachableAdmins);
  } else {
    const peer = (await prisma.user.findUnique({
      where: { id: routing.second_approver_id },
      select: USER_SELECT,
    })) as UserRow | null;

    if (isReachable(peer)) {
      routedTo = toRecipient(peer);
      authorized.add(peer.id);
      recipients.push(routedTo);
    } else {
      // A row exists but points at someone we cannot reach (deactivated, or — the
      // case that nearly shipped in the seed — an operator PIN account with no
      // email at all). Fall back rather than silently notifying nobody.
      outcome = 'fallback_unreachable_peer';
      problems.push(
        `ap_approval_routing points at an unreachable second approver (${peer?.name ?? routing.second_approver_id}: inactive, non-approver role, or no email) — falling back to admin.`,
      );
      recipients.push(...reachableAdmins);
    }

    // Escalation is additive: the peer stays able to sign, the fallback is added.
    if (args.escalated) {
      outcome = 'escalated';
      const fallback = routing.fallback_approver_id
        ? ((await prisma.user.findUnique({
            where: { id: routing.fallback_approver_id },
            select: USER_SELECT,
          })) as UserRow | null)
        : null;
      const escalationTargets = isReachable(fallback) ? [toRecipient(fallback)] : reachableAdmins; // NULL fallback_approver_id ⇒ system admin, per §1.4
      for (const t of escalationTargets) {
        authorized.add(t.userId);
        if (!recipients.some((r) => r.userId === t.userId)) recipients.push(t);
      }
    }
  }

  const authorizedUserIds = [...authorized];

  // ── THE INVARIANT ─────────────────────────────────────────────────────────
  // Authorized-by-someone but notifiable-by-nobody is the exact shape of the
  // outage. If we ever land here, say so loudly rather than returning quietly.
  if (authorizedUserIds.length > 0 && recipients.length === 0) {
    problems.push(
      'INVARIANT VIOLATED: second approval is authorized but has no reachable recipient — the request would sit unapproved and invisible.',
    );
  }

  return { authorizedUserIds, recipients, routedTo, outcome, problems };
}

/**
 * Authorization half, expressed through the same resolver so it can never drift
 * from the notification half. Admin-eligibility is preserved.
 */
export async function canFulfillSecondApprovalByRouting(
  prisma: PrismaClient,
  actor: { userId: string; role: string },
  args: { firstApproverId: string; escalated?: boolean },
): Promise<boolean> {
  if (actor.role === 'admin') return true; // unchanged rule (handoff DO-NOT list)
  const routed = await resolveSecondApproval(prisma, args);
  return routed.authorizedUserIds.includes(actor.userId);
}
