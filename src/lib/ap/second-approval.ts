// ADR-0046 Amendment 5 (D-M5-3) — the $1,000 second-approval workflow.
//
// An Approve whose confirmed amount is >= $1,000 does NOT terminate at `approved`.
// `decideRequest` (approvals.ts) moves it to `pending_second_approval`, stamping the
// first approver + all four structured field values, and fires a routing
// notification to the site-appropriate second approver. This module holds the
// SECOND leg: the eligibility/routing model plus `decideSecondApproval` — the
// second approver's Approve (→ approved) or Reject (→ rejected, override).
//
// Contract (spec §D-M5-3):
//   • Routing by site tag: Woodland → Bill (admin, always eligible), Eugene →
//     Shannon Rockwell (rostered in `ap_second_approvers`). NOT DR3 never reaches
//     here (it returns to sender with no payment).
//   • Authorization is server-side ONLY: a non-eligible user cannot fulfill a
//     second approval. Eligible = admin role OR an active `ap_second_approvers`
//     row for the decision's site.
//   • first_approver == would-be second_approver (decision (c)): the state still
//     fires, but the actor must pass an explicit re-confirmation flag AND a
//     30-second minimum wait since first approval (defense against a reflexive
//     double-click rubber-stamp).
//   • First-action-wins among second approvers (atomic conditional transition).
//   • The decision email + stamped PDF fire only on the terminal `approved`/
//     `rejected` state and carry BOTH approver names + PT timestamps.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import {
  ApAlreadyDecidedError,
  ApNotActionableError,
  ApNoteRequiredError,
  ApRequestNotFoundError,
  sendDecisionEmail,
  type ApDecision,
  type ApMailOutcome,
} from './approvals';
import {
  SECOND_APPROVAL_SELF_MIN_WAIT_MS,
  canFulfillSecondApproval,
} from './second-approval-routing';
import { recordVisionApproval } from './baselines';
import type { PdfRenderer } from './stamp';

const TABLE = 'ap_requests';

export {
  SECOND_APPROVAL_SELF_MIN_WAIT_MS,
  SECOND_APPROVAL_THRESHOLD_CENTS,
  requiresSecondApproval,
  activeSecondApproversForSite,
  canFulfillSecondApproval,
  secondApproverSiteLabel,
  awaitingSecondApprovalCount,
} from './second-approval-routing';

export class ApSecondApprovalNotEligibleError extends Error {
  readonly status = 403 as const;
  constructor() {
    super('You are not the designated second approver for this invoice’s site.');
    this.name = 'ApSecondApprovalNotEligibleError';
  }
}

export class ApSecondApprovalReconfirmRequiredError extends Error {
  readonly status = 400 as const;
  constructor() {
    super(
      'You are both the first and second approver on this invoice — re-confirm the decision to fulfill the second approval.',
    );
    this.name = 'ApSecondApprovalReconfirmRequiredError';
  }
}

export class ApSecondApprovalTooSoonError extends Error {
  readonly status = 400 as const;
  constructor(readonly secondsRemaining: number) {
    super(
      `Please wait ${secondsRemaining}s before self-fulfilling the second approval — take a moment to re-review before confirming.`,
    );
    this.name = 'ApSecondApprovalTooSoonError';
  }
}

/** Resolve a request's `site_id` to its site CODE ('woodland'|'eugene'), or null. */
async function siteCodeOf(prisma: PrismaClient, siteId: string | null): Promise<string | null> {
  if (!siteId) return null;
  const s = await prisma.site.findUnique({ where: { id: siteId }, select: { code: true } });
  return s?.code ?? null;
}

export interface SecondApprovalArgs {
  prisma?: PrismaClient;
  requestId: string;
  decision: ApDecision; // 'approved' | 'rejected'
  actor: { userId: string; role: string };
  /** REQUIRED on a Reject — the override note (persisted as second_approver_note). */
  note?: string;
  /** Set true on the self-fulfillment path (first_approver == second_approver). */
  reconfirm?: boolean;
  /** Test/clock seam. */
  now?: Date;
  /** Test seam — deterministic PDF renderer. */
  renderer?: PdfRenderer;
}

export interface SecondApprovalResult {
  requestId: string;
  decision: ApDecision;
  mail: ApMailOutcome;
}

/**
 * Fulfill (or override) a pending second approval. Approve → `approved`; Reject →
 * `rejected` (with the override note). First-action-wins among second approvers via
 * an atomic conditional transition; the terminal decision + its audit commit
 * together, and the decision email (carrying BOTH approvers) fires only after the
 * commit stands. Throws {@link ApSecondApprovalNotEligibleError} to a non-eligible
 * actor, and the self-reconfirm / min-wait errors on the first==second path.
 */
export async function decideSecondApproval(args: SecondApprovalArgs): Promise<SecondApprovalResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();

  // A Reject override must explain why it overrides the first approval.
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
  if (args.decision === 'rejected' && !note) {
    throw new ApNoteRequiredError(
      'A second-approval rejection must include a note explaining why the first approval is being overridden.',
    );
  }

  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      status: true,
      site_id: true,
      filed_not_dr3: true,
      first_approver_id: true,
      first_approved_at: true,
      decided_by: true,
      decided_at: true,
      received_at: true,
      vendor_freeform: true,
      confirmed_amount_cents: true,
    },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  // Only a request AWAITING second approval is fulfillable. A row already terminal
  // (someone else fulfilled the race) → ApAlreadyDecidedError; anything else → not
  // actionable from this leg.
  if (row.status === 'approved' || row.status === 'rejected') {
    const name = await resolveName(prisma, row.decided_by);
    throw new ApAlreadyDecidedError(row.status, name, row.decided_at);
  }
  if (row.status !== 'pending_second_approval') throw new ApNotActionableError(row.status);

  // NOT-DR3 never enters this state (guarded at entry); defensive.
  const siteCode = await siteCodeOf(prisma, row.site_id);
  if (row.filed_not_dr3 || !siteCode) throw new ApNotActionableError('not_dr3');

  // Server-authoritative authorization — a non-eligible actor is refused.
  const eligible = await canFulfillSecondApproval(prisma, args.actor, siteCode, now);
  if (!eligible) throw new ApSecondApprovalNotEligibleError();

  // first_approver == second_approver (decision (c)) — the actor is the same person
  // who first-approved. Require an explicit re-confirmation AND a 30s minimum wait.
  if (row.first_approver_id && args.actor.userId === row.first_approver_id) {
    if (!args.reconfirm) throw new ApSecondApprovalReconfirmRequiredError();
    const elapsedMs = row.first_approved_at ? now.getTime() - row.first_approved_at.getTime() : 0;
    if (elapsedMs < SECOND_APPROVAL_SELF_MIN_WAIT_MS) {
      const remaining = Math.ceil((SECOND_APPROVAL_SELF_MIN_WAIT_MS - elapsedMs) / 1000);
      throw new ApSecondApprovalTooSoonError(remaining);
    }
  }

  // Atomic conditional transition + winning audit in ONE transaction (mirrors
  // decideRequest): only a row still awaiting second approval flips; a row already
  // fulfilled matches nothing → count 0 → ApAlreadyDecidedError. The terminal
  // decider (decided_by/decided_at) is the SECOND approver; the first approver's
  // stamp fields are already persisted.
  const res = await prisma.$transaction(async (tx) => {
    const r = await tx.apRequest.updateMany({
      where: { id: args.requestId, status: 'pending_second_approval' },
      data: {
        status: args.decision,
        second_approver_id: args.actor.userId,
        second_approved_at: now,
        decided_by: args.actor.userId,
        decided_at: now,
        ...(args.decision === 'rejected' && note ? { second_approver_note: note } : {}),
      },
    });
    // D-M5-4 — a second-approver Approve is the TERMINAL approved transition for a
    // >= $1K invoice; feed its `vision_approval` history row in the same tx (mirrors
    // the sub-$1K path in decideRequest). No-op on reject.
    if (r.count > 0 && args.decision === 'approved' && row.site_id) {
      await recordVisionApproval(tx, {
        vendorFreeform: row.vendor_freeform ?? '',
        confirmedAmountCents:
          typeof row.confirmed_amount_cents === 'number' ? row.confirmed_amount_cents : Number.NaN,
        siteId: row.site_id,
        invoiceDate: row.received_at,
        actorUserId: args.actor.userId,
      });
    }
    if (r.count > 0) {
      await writeAudit(
        {
          actor_user_id: args.actor.userId,
          action: 'update',
          table_name: TABLE,
          row_id: args.requestId,
          before: { status: 'pending_second_approval' },
          after: {
            attempted: `second_${args.decision}`,
            outcome: 'won',
            status: args.decision,
            first_approver_id: row.first_approver_id,
            self_fulfilled: args.actor.userId === row.first_approver_id,
            has_override_note: !!note,
          },
        },
        { tx },
      );
    }
    return r;
  });

  if (res.count === 0) {
    const winner = await prisma.apRequest.findUnique({
      where: { id: args.requestId },
      select: { status: true, decided_by: true, decided_at: true },
    });
    await writeAudit({
      actor_user_id: args.actor.userId,
      action: 'update',
      table_name: TABLE,
      row_id: args.requestId,
      after: {
        attempted: `second_${args.decision}`,
        outcome: 'lost',
        winner_status: winner?.status ?? 'unknown',
      },
    });
    const name = await resolveName(prisma, winner?.decided_by ?? null);
    throw new ApAlreadyDecidedError(winner?.status ?? row.status, name, winner?.decided_at ?? null);
  }

  // Terminal state stands. The decision email (both approvers; a reject CCs the
  // first approver) fires OUTSIDE the tx — a committed decision never rolls back on
  // a mail/render/R2 failure (surfaced via `mail`, never silently).
  const mail = await sendDecisionEmail(prisma, args.requestId, args.renderer);
  return { requestId: args.requestId, decision: args.decision, mail };
}

async function resolveName(prisma: PrismaClient, userId: string | null): Promise<string> {
  if (!userId) return 'another approver';
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name ?? 'another approver';
}
