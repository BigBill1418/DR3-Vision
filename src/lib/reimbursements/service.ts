// ADR-0068 — submit and decide an employee reimbursement.
//
// ── The two state transitions, and where the control lives ──────────────────
//   submit  → pending_second_approval   (submission IS signature one, D4)
//   decide  → approved | rejected | held (signature two, by someone else)
//
// The "someone else" is enforced in THREE independent places, deliberately:
//
//   1. `canApproveReimbursement` (routing.ts) — the server-side gate, before any
//      write. A hand-crafted request from an ineligible approver is refused here.
//   2. The DB CHECK `reimbursement_second_approver_not_submitter` — the one that
//      cannot be refactored away, cannot be bypassed by a future code path that
//      forgets to ask, and does not depend on this file being correct.
//   3. The UI, which does not offer the buttons.
//
// Three layers is not belt-and-braces theatre. Mary caught this control failing
// in production while every surface reported success; the whole point is that no
// single layer has to be trusted.
//
// ── Why `decide` uses a conditional updateMany ──────────────────────────────
// Two approvers can click at the same moment. `updateMany` with the status in the
// WHERE clause makes the transition atomic: the loser matches zero rows and is
// told who won, rather than silently overwriting the winner's decision.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient, ReimbursementCategory, ReimbursementStatus } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { pacificDayISO } from '@/lib/time';
import {
  canApproveReimbursement,
  resolveReimbursementApproval,
  type ReimbursementRouting,
} from './routing';

const TABLE = 'reimbursement_requests';

export class ReimbursementNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(id: string) {
    super(`No reimbursement request ${id}.`);
    this.name = 'ReimbursementNotFoundError';
  }
}

export class ReimbursementNotEligibleError extends Error {
  readonly status = 403 as const;
  constructor(reason: string) {
    super(reason);
    this.name = 'ReimbursementNotEligibleError';
  }
}

export class ReimbursementAlreadyDecidedError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly finalStatus: ReimbursementStatus,
    readonly deciderName: string,
  ) {
    super(`This reimbursement was already ${finalStatus} by ${deciderName}.`);
    this.name = 'ReimbursementAlreadyDecidedError';
  }
}

export class ReimbursementNoteRequiredError extends Error {
  readonly status = 400 as const;
  constructor() {
    super('A rejection or hold must include a note explaining why.');
    this.name = 'ReimbursementNoteRequiredError';
  }
}

export interface SubmitReimbursementArgs {
  prisma?: PrismaClient;
  submittedBy: string;
  /** Server-resolved from the submitter — NEVER accepted from the client. */
  siteId: string;
  employeeUserId?: string | null;
  employeeNameFreeform?: string | null;
  amountCents: number;
  /** `YYYY-MM-DD`, the EXPENSE date. */
  expenseDate: string;
  category: ReimbursementCategory;
  purpose: string;
  receiptFileKey: string;
  receiptContentType: string;
  now?: Date;
}

export interface SubmitReimbursementResult {
  id: string;
  routing: ReimbursementRouting;
}

/**
 * File a reimbursement. The submitting manager is authenticated, so "who
 * originated this" becomes a stored fact rather than an inference — that single
 * change is what turns "the submitter cannot approve" from a detection problem
 * into a constraint.
 */
export async function submitReimbursement(
  args: SubmitReimbursementArgs,
): Promise<SubmitReimbursementResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();

  const employeeUserId = args.employeeUserId?.trim() || null;
  const employeeNameFreeform = args.employeeNameFreeform?.trim() || null;

  // Mirrors the DB CHECK. Checked here too so the operator gets a sentence
  // rather than a constraint-violation stack.
  if ((employeeUserId === null) === (employeeNameFreeform === null)) {
    throw new ReimbursementNoteRequiredError();
  }
  if (!Number.isInteger(args.amountCents) || args.amountCents <= 0) {
    throw new ReimbursementNotEligibleError('The amount must be a positive number.');
  }
  if (!args.purpose.trim()) {
    throw new ReimbursementNotEligibleError('Say what the expense was for.');
  }

  // Resolve routing BEFORE the insert: `routed_to_user_id` is NOT NULL, and a
  // request nobody is routed to is a request nobody will ever see.
  const routing = await resolveReimbursementApproval(prisma, {
    submittedBy: args.submittedBy,
    employeeUserId,
    employeeNameFreeform,
  });

  const routedTo = routing.routedTo;
  if (!routedTo) {
    // Genuinely nobody eligible. Refuse the submission rather than storing a row
    // that can never be approved and will sit unpaid looking like it is in progress.
    throw new ReimbursementNotEligibleError(
      routing.problems[0] ??
        'No eligible second approver exists for this reimbursement — it cannot be submitted. Have a different person submit it.',
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.reimbursementRequest.create({
      data: {
        site_id: args.siteId,
        employee_user_id: employeeUserId,
        employee_name_freeform: employeeNameFreeform,
        amount_cents: args.amountCents,
        expense_date: new Date(`${args.expenseDate}T12:00:00.000Z`),
        category: args.category,
        purpose: args.purpose.trim(),
        receipt_file_key: args.receiptFileKey,
        receipt_content_type: args.receiptContentType,
        submitted_by: args.submittedBy,
        submitted_at: now,
        status: 'pending_second_approval',
        routed_to_user_id: routedTo.userId,
        ...(routing.escalateImmediately
          ? {
              escalated_at: now,
              escalated_to: routedTo.userId,
              ...(routing.escalationReason ? { escalation_reason: routing.escalationReason } : {}),
            }
          : {}),
      },
      select: { id: true },
    });

    await writeAudit(
      {
        actor_user_id: args.submittedBy,
        action: 'insert',
        table_name: TABLE,
        row_id: row.id,
        after: {
          amount_cents: args.amountCents,
          expense_date: args.expenseDate,
          category: args.category,
          site_id: args.siteId,
          beneficiary: employeeUserId ?? employeeNameFreeform,
          // The provenance that makes the control auditable: this is signature
          // one, and it is attributable to an authenticated person.
          first_signature: 'submission',
          routed_to: routedTo.userId,
          escalated_immediately: routing.escalateImmediately,
          escalation_reason: routing.escalationReason,
        },
      },
      { tx },
    );
    return row;
  });

  return { id: created.id, routing };
}

export type ReimbursementDecision = 'approved' | 'rejected' | 'held';

export interface DecideReimbursementArgs {
  prisma?: PrismaClient;
  requestId: string;
  decision: ReimbursementDecision;
  actor: { userId: string; role: string };
  /** REQUIRED on reject and hold. */
  note?: string;
  now?: Date;
}

export interface DecideReimbursementResult {
  requestId: string;
  decision: ReimbursementDecision;
  /** The row as decided, for the caller's notification step. */
  row: {
    id: string;
    site_id: string;
    amount_cents: number;
    submitted_by: string;
    employee_user_id: string | null;
    employee_name_freeform: string | null;
  };
}

/**
 * Fulfil the second signature. Approve → paid by Mary; Reject/Hold → back to the
 * submitting manager with the note.
 */
export async function decideReimbursement(
  args: DecideReimbursementArgs,
): Promise<DecideReimbursementResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const now = args.now ?? new Date();

  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;
  if ((args.decision === 'rejected' || args.decision === 'held') && !note) {
    throw new ReimbursementNoteRequiredError();
  }

  const row = await prisma.reimbursementRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      site_id: true,
      status: true,
      amount_cents: true,
      submitted_by: true,
      employee_user_id: true,
      employee_name_freeform: true,
      second_approver_id: true,
      escalated_at: true,
    },
  });
  if (!row) throw new ReimbursementNotFoundError(args.requestId);

  if (row.status !== 'pending_second_approval') {
    const who = await resolveName(prisma, row.second_approver_id);
    throw new ReimbursementAlreadyDecidedError(row.status, who);
  }

  // ── The gate. Layer 1 of 3. ───────────────────────────────────────────────
  const eligible = await canApproveReimbursement(prisma, args.actor.userId, {
    submittedBy: row.submitted_by,
    employeeUserId: row.employee_user_id,
    employeeNameFreeform: row.employee_name_freeform,
    escalated: row.escalated_at != null,
    requestSiteId: row.site_id,
  });
  if (!eligible) {
    // Name the reason. "Not authorized" sends the operator hunting; the truth is
    // usually "you are the person who submitted it" or "you are being paid".
    const reason =
      args.actor.userId === row.submitted_by
        ? 'You submitted this reimbursement, so you cannot also approve it. It needs a second person.'
        : args.actor.userId === row.employee_user_id
          ? 'This reimbursement pays you, so you cannot approve it. It has been routed to someone else.'
          : 'You are not the designated second approver for this reimbursement.';
    throw new ReimbursementNotEligibleError(reason);
  }

  const res = await prisma.$transaction(async (tx) => {
    // Atomic: only a row still awaiting the second signature flips.
    const r = await tx.reimbursementRequest.updateMany({
      where: { id: args.requestId, status: 'pending_second_approval' },
      data: {
        status: args.decision,
        second_approver_id: args.actor.userId,
        second_approved_at: now,
        ...(note ? { decision_note: note } : {}),
      },
    });
    if (r.count > 0) {
      await writeAudit(
        {
          actor_user_id: args.actor.userId,
          action: 'update',
          table_name: TABLE,
          row_id: args.requestId,
          before: { status: 'pending_second_approval' },
          after: {
            status: args.decision,
            second_signature: args.actor.userId,
            submitted_by: row.submitted_by,
            // Recorded explicitly so an auditor can see the control held on this
            // row without re-deriving it.
            submitter_is_approver: args.actor.userId === row.submitted_by,
            beneficiary_is_approver: args.actor.userId === row.employee_user_id,
            has_note: !!note,
            decided_pacific_day: pacificDayISO(now),
          },
        },
        { tx },
      );
    }
    return r;
  });

  if (res.count === 0) {
    const winner = await prisma.reimbursementRequest.findUnique({
      where: { id: args.requestId },
      select: { status: true, second_approver_id: true },
    });
    const who = await resolveName(prisma, winner?.second_approver_id ?? null);
    throw new ReimbursementAlreadyDecidedError(winner?.status ?? row.status, who);
  }

  return {
    requestId: args.requestId,
    decision: args.decision,
    row: {
      id: row.id,
      site_id: row.site_id,
      amount_cents: row.amount_cents,
      submitted_by: row.submitted_by,
      employee_user_id: row.employee_user_id,
      employee_name_freeform: row.employee_name_freeform,
    },
  };
}

async function resolveName(prisma: PrismaClient, userId: string | null): Promise<string> {
  if (!userId) return 'another approver';
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name ?? 'another approver';
}

/** Display label for a beneficiary, roster or free text. */
export function beneficiaryLabel(row: {
  employee_name_freeform: string | null;
  employee_user?: { name: string } | null;
}): string {
  return row.employee_user?.name ?? row.employee_name_freeform ?? '(unnamed)';
}
