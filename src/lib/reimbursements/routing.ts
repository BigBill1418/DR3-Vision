// ADR-0068 D5/D6 — who may fulfil a reimbursement's second approval.
//
// ── Why this file is a THIN WRAPPER and not a second resolver ────────────────
// The reimbursement routing question is the AP routing question plus one extra
// exclusion. It therefore consumes `resolveSecondApproval` from
// `@/lib/ap/second-approval-resolver` rather than re-deriving anything.
//
// That is not tidiness, it is the lesson of the outage that resolver exists to
// prevent: two code paths answered "who may sign / who do we tell" differently,
// the authorization path said Bill was eligible while the notification path
// couldn't see him, and >= $1,000 invoices sat unapproved and INVISIBLE for days
// because the notify path is fail-soft over an empty recipient set. Forking a
// second resolver here would recreate that shape with a third answer.
//
// So: one routing table (`ap_approval_routing`), one resolver, and this module
// adds exactly one rule on top.
//
// ── The rule this module adds (D6) ──────────────────────────────────────────
// Bill's stated rule was "the second cannot be the initiator". That covers the
// SUBMITTER. It does NOT cover the BENEFICIARY, and that gap reproduces Mary's
// complaint in mirror image: if Morena submits a reimbursement *for Janette*,
// person-to-person routing sends it to Janette — the person being paid.
//
//   eligible second approver =
//         the routing peer for the submitter
//     AND is not the submitter
//     AND is not the person being reimbursed
//
// When the routed peer IS the beneficiary there is no valid local approver, so
// escalation to Bill is IMMEDIATE — waiting 24 hours accomplishes nothing.
//
// ── Fail safe, not fail open ────────────────────────────────────────────────
// A free-text beneficiary name cannot be compared by id. An AMBIGUOUS match
// escalates to an admin rather than risking a self-approval, and says so. The
// asymmetry is deliberate: a needless escalation costs Bill one glance, while a
// missed exclusion pays someone against their own signature.

import type { PrismaClient } from '@prisma/client';
import { resolveSecondApproval, type ResolvedRecipient } from '@/lib/ap/second-approval-resolver';

/** Why a reimbursement left its routed peer. Mirrors the DB enum. */
export type ReimbursementEscalationReason =
  | 'timeout'
  | 'beneficiary_conflict'
  | 'no_routing_row'
  | 'ambiguous_beneficiary';

export interface ReimbursementRouting {
  /** Everyone who MAY fulfil the second approval. Never includes the submitter. */
  authorizedUserIds: string[];
  /** Who gets emailed. Non-empty whenever `authorizedUserIds` is non-empty. */
  recipients: ResolvedRecipient[];
  /** The individual this request is routed to. */
  routedTo: ResolvedRecipient | null;
  /** Set when routing could not land on a valid local peer. */
  escalationReason: ReimbursementEscalationReason | null;
  /** True when escalation must happen NOW rather than after the 24h clock. */
  escalateImmediately: boolean;
  /** Misconfigurations worth surfacing in Bill's 06:00 digest. */
  problems: string[];
}

export interface ReimbursementRoutingArgs {
  submittedBy: string;
  /** Beneficiary as a Vision user, when picked from the roster. */
  employeeUserId?: string | null;
  /** Beneficiary as free text, when they have no Vision account. */
  employeeNameFreeform?: string | null;
  /** Widen the eligible set with the fallback approver (24h clock elapsed). */
  escalated?: boolean;
}

/** Casefold + collapse whitespace + drop punctuation, for free-text name compare. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this free-text beneficiary name plausibly refer to this candidate approver?
 *
 * Deliberately GENEROUS about what counts as a match, because a false match here
 * causes a needless escalation (cheap) while a missed match causes a
 * self-approval (the whole defect). Exact normalized equality, or a first+last
 * token match, both count.
 */
export function nameMayReferTo(freeform: string, candidateName: string): boolean {
  const a = normalizeName(freeform);
  const b = normalizeName(candidateName);
  if (!a || !b) return false;
  if (a === b) return true;

  const at = a.split(' ');
  const bt = b.split(' ');
  const aFirst = at[0];
  const bFirst = bt[0];
  const aLast = at[at.length - 1];
  const bLast = bt[bt.length - 1];
  // "Janette Tomas" vs "Janette M Tomas" — same person, different middle.
  if (at.length >= 2 && bt.length >= 2 && aFirst === bFirst && aLast === bLast) return true;
  // A single token that equals a full first or last name is AMBIGUOUS, not a
  // match — handled by the caller, which escalates rather than deciding.
  return false;
}

/**
 * A single-token free-text name that collides with a candidate's first or last
 * name. Not enough to conclude identity, and not safe to ignore.
 */
export function nameIsAmbiguousAgainst(freeform: string, candidateName: string): boolean {
  const a = normalizeName(freeform);
  const b = normalizeName(candidateName);
  if (!a || !b) return false;
  if (a === b) return false; // that is a match, not an ambiguity
  const at = a.split(' ');
  if (at.length !== 1) return false;
  return b.split(' ').includes(at[0] ?? '');
}

/**
 * Resolve who may sign a reimbursement, and who to tell.
 *
 * Layers on top of the shared AP resolver:
 *   1. remove the submitter (D4 — submission IS the first signature);
 *   2. remove the beneficiary (D6);
 *   3. if that empties the eligible set, escalate to a reachable admin IMMEDIATELY.
 */
export async function resolveReimbursementApproval(
  prisma: PrismaClient,
  args: ReimbursementRoutingArgs,
): Promise<ReimbursementRouting> {
  const base = await resolveSecondApproval(prisma, {
    firstApproverId: args.submittedBy,
    ...(args.escalated === undefined ? {} : { escalated: args.escalated }),
  });

  const problems = [...base.problems];
  let escalationReason: ReimbursementEscalationReason | null =
    base.outcome === 'fallback_no_routing_row' ? 'no_routing_row' : null;
  let escalateImmediately = escalationReason === 'no_routing_row';

  // The reachable admin backstop, used whenever the local peer is not usable.
  // Read through the resolver's own fallback so there is one definition of
  // "reachable admin" in the system.
  const adminFallback = await resolveSecondApproval(prisma, {
    // A first approver id that cannot match any routing row forces the resolver
    // down its admin-fallback branch, which is exactly the set we want.
    firstApproverId: '__reimbursement_admin_fallback__',
  });
  const reachableAdmins = adminFallback.recipients;

  // ── 1 + 2. Strip the submitter and the beneficiary ────────────────────────
  const excluded = new Set<string>([args.submittedBy]);
  if (args.employeeUserId) excluded.add(args.employeeUserId);

  let ambiguous = false;
  if (args.employeeNameFreeform && args.employeeNameFreeform.trim()) {
    const freeform = args.employeeNameFreeform;
    const candidates = await prisma.user.findMany({
      where: { id: { in: base.authorizedUserIds }, deleted_at: null },
      select: { id: true, name: true },
    });
    for (const c of candidates) {
      if (nameMayReferTo(freeform, c.name)) {
        excluded.add(c.id);
        problems.push(
          `Reimbursement beneficiary "${freeform}" matches approver ${c.name} by name — they are excluded from approving their own reimbursement.`,
        );
      } else if (nameIsAmbiguousAgainst(freeform, c.name)) {
        // FAIL SAFE. We cannot tell whether this is the same person, and a wrong
        // answer here pays someone against their own signature.
        ambiguous = true;
        excluded.add(c.id);
        problems.push(
          `Reimbursement beneficiary "${freeform}" is an AMBIGUOUS match against approver ${c.name} — escalated to an admin rather than risking a self-approval. Re-enter the beneficiary using the employee picker to remove the ambiguity.`,
        );
      }
    }
  }

  const authorized = base.authorizedUserIds.filter((id) => !excluded.has(id));
  let routedTo = base.routedTo && !excluded.has(base.routedTo.userId) ? base.routedTo : null;
  const recipients = base.recipients.filter((r) => !excluded.has(r.userId));

  if (ambiguous && escalationReason === null) escalationReason = 'ambiguous_beneficiary';
  if (ambiguous) escalateImmediately = true;

  // ── 3. Nobody local can sign → immediate admin escalation ─────────────────
  if (authorized.length === 0 || recipients.length === 0) {
    const usableAdmins = reachableAdmins.filter((a) => !excluded.has(a.userId));
    for (const a of usableAdmins) {
      if (!authorized.includes(a.userId)) authorized.push(a.userId);
      if (!recipients.some((r) => r.userId === a.userId)) recipients.push(a);
    }
    routedTo = routedTo ?? usableAdmins[0] ?? null;
    if (escalationReason === null) escalationReason = 'beneficiary_conflict';
    escalateImmediately = true;

    if (usableAdmins.length === 0) {
      // Catastrophic: not even an admin can sign this without self-approving.
      // Say so loudly — this must never resolve to "authorized by nobody" in
      // silence, which is the shape of the original outage.
      problems.push(
        'INVARIANT VIOLATED: no eligible reimbursement approver exists who is neither the submitter nor the beneficiary. The request cannot be approved by anyone and will sit unpaid — resolve by having a different person submit it.',
      );
    }
  }

  // The invariant the AP outage taught us: authorized-by-someone must never mean
  // notifiable-by-nobody.
  if (authorized.length > 0 && recipients.length === 0) {
    problems.push(
      'INVARIANT VIOLATED: a reimbursement second approval is authorized but has no reachable recipient — it would sit unapproved and invisible.',
    );
  }

  return {
    authorizedUserIds: authorized,
    recipients,
    routedTo,
    escalationReason,
    escalateImmediately,
    problems,
  };
}

/**
 * May this actor fulfil this reimbursement's second approval?
 *
 * Server-authoritative. Called before any state transition, and NOT trusted from
 * the client. Note there is no `role === 'admin'` short-circuit as there is on
 * the AP path: an admin who submitted the request, or who is the beneficiary, is
 * still refused. The exclusions are about the PERSON, not the privilege — that
 * is the entire control.
 */
export async function canApproveReimbursement(
  prisma: PrismaClient,
  actorUserId: string,
  args: ReimbursementRoutingArgs & { requestSiteId?: string | null },
): Promise<boolean> {
  // Hard stops first, so no routing outcome can ever override them.
  if (actorUserId === args.submittedBy) return false;
  if (args.employeeUserId && actorUserId === args.employeeUserId) return false;

  const routed = await resolveReimbursementApproval(prisma, args);
  if (!routed.authorizedUserIds.includes(actorUserId)) return false;

  // CLAUDE.md hard rule #2 — site reach. A non-admin without `all_sites` may only
  // act on their own site, so person routing cannot become a cross-site
  // escalation. Admins pass; everyone else must match the request's site.
  if (!args.requestSiteId) return true;
  const me = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { role: true, all_sites: true, primary_site_id: true },
  });
  if (!me) return false;
  if (me.role === 'admin' || me.all_sites) return true;
  return me.primary_site_id === args.requestSiteId;
}
