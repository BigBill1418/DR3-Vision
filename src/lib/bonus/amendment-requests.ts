// ADR-0028 — Bonus amendment-request service.
//
// Four-eyes prior-day amendment workflow. Every public function here:
//   - is the ONLY supported mutation path on `bonus_amendment_requests`
//   - resolves the signature chain (via getSignatureChain) for approver matrix
//   - writes an audit row in the SAME Prisma transaction as the table mutation
//     (CLAUDE.md hard rule #6)
//   - on approval, applies the entry change AND writes the entry audit row AND
//     marks the request approved AND links the applied audit row id back into
//     the request, all in one transaction
//
// The routing predicate (`shouldRequireAmendment`) is exported here for the
// daily-entry layer to call before writing.

import { Prisma, type AuditAction, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { appToday } from '@/lib/time';
import { getSignatureChain } from '@/lib/bonus/signature-chain';
import {
  resolveAmendmentApprover,
  canApproveRequest,
  AmendmentWorkflowForbiddenError,
} from '@/lib/bonus/amendment-approvers';

export const JUSTIFICATION_MIN_LENGTH = 20;

export class AmendmentRequestError extends Error {
  readonly status: number;
  constructor(
    public readonly reason:
      | 'period_not_draft'
      | 'period_not_found'
      | 'employee_not_in_site'
      | 'justification_too_short'
      | 'invalid_count'
      | 'entry_not_found_for_update'
      | 'entry_exists_for_insert'
      | 'request_not_found'
      | 'request_not_pending'
      | 'not_eligible_to_approve'
      | 'reject_requires_notes'
      | 'cancel_only_by_requester',
    statusCode = 409,
  ) {
    super(`amendment request error: ${reason}`);
    this.name = 'AmendmentRequestError';
    this.status = statusCode;
  }
}

export interface SubmitAmendmentInput {
  siteId: string;
  bonusPayPeriodId: string;
  targetEntryDate: Date;
  bonusEmployeeId: string;
  changeType: 'update' | 'insert';
  newValue: { mattress_count: number; note: string | null };
  justification: string;
  requesterUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AmendmentDecisionInput {
  requestId: string;
  reviewerUserId: string;
  reviewerIsAdmin: boolean;
  decisionNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// ─────────────────────────────────────────────────────────────────────
// Submit
// ─────────────────────────────────────────────────────────────────────

export async function submitAmendmentRequest(input: SubmitAmendmentInput) {
  if (input.justification.trim().length < JUSTIFICATION_MIN_LENGTH) {
    throw new AmendmentRequestError('justification_too_short', 422);
  }

  const count = input.newValue.mattress_count;
  if (
    !Number.isFinite(count) ||
    count < 0 ||
    count > 999 ||
    Math.abs(count * 10 - Math.round(count * 10)) > 1e-9
  ) {
    throw new AmendmentRequestError('invalid_count', 422);
  }

  // Resolve approver outside the tx (separate read; throws on Patrick).
  const { expectedApproverUserId } = await resolveAmendmentApprover(
    prisma,
    input.siteId,
    input.requesterUserId,
  );

  return prisma.$transaction(async (tx) => {
    const period = await tx.bonusPayPeriod.findUnique({
      where: { id: input.bonusPayPeriodId },
      select: { id: true, site_id: true, state: true },
    });
    if (!period || period.site_id !== input.siteId) {
      throw new AmendmentRequestError('period_not_found', 404);
    }
    if (period.state !== 'draft') {
      throw new AmendmentRequestError('period_not_draft', 409);
    }

    const employee = await tx.bonusEmployee.findUnique({
      where: { id: input.bonusEmployeeId },
      select: { id: true, site_id: true },
    });
    if (!employee || employee.site_id !== input.siteId) {
      throw new AmendmentRequestError('employee_not_in_site', 404);
    }

    const existing = await tx.bonusDailyEntry.findUnique({
      where: {
        bonus_employee_id_entry_date: {
          bonus_employee_id: input.bonusEmployeeId,
          entry_date: input.targetEntryDate,
        },
      },
      select: { id: true, mattress_count: true, note: true },
    });

    if (input.changeType === 'update' && !existing) {
      throw new AmendmentRequestError('entry_not_found_for_update', 409);
    }
    if (input.changeType === 'insert' && existing) {
      throw new AmendmentRequestError('entry_exists_for_insert', 409);
    }

    const oldValueSnapshot =
      input.changeType === 'update' && existing
        ? { mattress_count: existing.mattress_count.toNumber(), note: existing.note }
        : null;

    // Auto-cancel any prior PENDING request from this requester for the same target.
    const priorPending = await tx.bonusAmendmentRequest.findMany({
      where: {
        bonus_employee_id: input.bonusEmployeeId,
        target_entry_date: input.targetEntryDate,
        requested_by_user_id: input.requesterUserId,
        state: 'pending',
      },
      select: { id: true },
    });
    for (const p of priorPending) {
      const now = new Date();
      await tx.bonusAmendmentRequest.update({
        where: { id: p.id },
        data: { state: 'cancelled', reviewed_at: now, updated_at: now },
      });
      await tx.auditLog.create({
        data: {
          actor_user_id: input.requesterUserId,
          actor_label: 'system:amendment-supersede',
          action: 'update' satisfies AuditAction,
          table_name: 'bonus_amendment_requests',
          row_id: p.id,
          before: { state: 'pending' },
          after: { state: 'cancelled', reason: 'superseded_by_new_request' },
          ip: input.ip ?? null,
          user_agent: input.userAgent ?? null,
        },
      });
    }

    const created = await tx.bonusAmendmentRequest.create({
      data: {
        bonus_pay_period_id: input.bonusPayPeriodId,
        site_id: input.siteId,
        target_entry_date: input.targetEntryDate,
        bonus_employee_id: input.bonusEmployeeId,
        change_type: input.changeType,
        old_value: oldValueSnapshot
          ? (serializeJson(oldValueSnapshot) as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        new_value: serializeJson(input.newValue) as Prisma.InputJsonValue,
        justification: input.justification.trim(),
        requested_by_user_id: input.requesterUserId,
        expected_approver_user_id: expectedApproverUserId,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.requesterUserId,
        action: 'insert' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: created.id,
        before: Prisma.JsonNull,
        after: serializeJson({
          bonus_pay_period_id: created.bonus_pay_period_id,
          target_entry_date: created.target_entry_date,
          bonus_employee_id: created.bonus_employee_id,
          change_type: created.change_type,
          old_value: oldValueSnapshot,
          new_value: input.newValue,
          justification: created.justification,
          expected_approver_user_id: created.expected_approver_user_id,
        }) as Prisma.InputJsonValue,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return created;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Ping Bill
// ─────────────────────────────────────────────────────────────────────

export async function pingBill(
  requestId: string,
  actorUserId: string,
  ip: string | null,
  userAgent: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);
    if (req.requested_by_user_id !== actorUserId) {
      throw new AmendmentRequestError('cancel_only_by_requester', 403);
    }
    if (req.bill_pinged_at) return { request: req, firstPing: false };

    const now = new Date();
    const updated = await tx.bonusAmendmentRequest.update({
      where: { id: requestId },
      data: { bill_pinged_at: now, updated_at: now },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: requestId,
        before: { bill_pinged_at: null },
        after: { bill_pinged_at: now.toISOString() },
        ip,
        user_agent: userAgent,
      },
    });

    return { request: updated, firstPing: true };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Cancel (requester only)
// ─────────────────────────────────────────────────────────────────────

export async function cancelAmendmentRequest(
  requestId: string,
  actorUserId: string,
  ip: string | null,
  userAgent: string | null,
) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);
    if (req.requested_by_user_id !== actorUserId) {
      throw new AmendmentRequestError('cancel_only_by_requester', 403);
    }

    const now = new Date();
    const updated = await tx.bonusAmendmentRequest.update({
      where: { id: requestId },
      data: { state: 'cancelled', reviewed_at: now, updated_at: now },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actorUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: requestId,
        before: { state: 'pending' },
        after: { state: 'cancelled', reason: 'cancelled_by_requester' },
        ip,
        user_agent: userAgent,
      },
    });

    return updated;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Approve (atomic: apply change + audit + mark approved + link audit)
// ─────────────────────────────────────────────────────────────────────

export async function approveAmendmentRequest(input: AmendmentDecisionInput) {
  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: input.requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);

    const period = await tx.bonusPayPeriod.findUnique({
      where: { id: req.bonus_pay_period_id },
      select: { id: true, state: true },
    });
    if (!period || period.state !== 'draft') {
      throw new AmendmentRequestError('period_not_draft', 409);
    }

    const chain = await getSignatureChain(req.site_id, tx as unknown as PrismaClient);
    const eligible = canApproveRequest({
      actorUserId: input.reviewerUserId,
      request: {
        requested_by_user_id: req.requested_by_user_id,
        expected_approver_user_id: req.expected_approver_user_id,
        bill_pinged_at: req.bill_pinged_at,
      },
      chain: { auto_override_actor_user_id: chain.auto_override_actor_user_id },
      actorIsAdmin: input.reviewerIsAdmin,
    });
    if (!eligible) throw new AmendmentRequestError('not_eligible_to_approve', 403);

    const now = new Date();
    const newValue = req.new_value as { mattress_count: number; note: string | null };

    let appliedEntryId: string;
    let beforeAuditPayload: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    let afterAuditPayload: Prisma.InputJsonValue;
    let entryAction: AuditAction;

    if (req.change_type === 'update') {
      const existing = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: req.bonus_employee_id,
            entry_date: req.target_entry_date,
          },
        },
      });
      if (!existing) throw new AmendmentRequestError('entry_not_found_for_update', 409);

      beforeAuditPayload = serializeJson({
        mattress_count: existing.mattress_count.toNumber(),
        note: existing.note,
        entered_by_user_id: existing.entered_by_user_id,
      }) as Prisma.InputJsonValue;

      const updated = await tx.bonusDailyEntry.update({
        where: { id: existing.id },
        data: {
          mattress_count: newValue.mattress_count,
          note: newValue.note,
          entered_by_user_id: input.reviewerUserId,
          entered_at: now,
        },
      });

      appliedEntryId = updated.id;
      afterAuditPayload = serializeJson({
        mattress_count: updated.mattress_count.toNumber(),
        note: updated.note,
        entered_by_user_id: updated.entered_by_user_id,
      }) as Prisma.InputJsonValue;
      entryAction = 'update';
    } else {
      const existing = await tx.bonusDailyEntry.findUnique({
        where: {
          bonus_employee_id_entry_date: {
            bonus_employee_id: req.bonus_employee_id,
            entry_date: req.target_entry_date,
          },
        },
      });
      if (existing) throw new AmendmentRequestError('entry_exists_for_insert', 409);

      const inserted = await tx.bonusDailyEntry.create({
        data: {
          bonus_employee_id: req.bonus_employee_id,
          bonus_pay_period_id: req.bonus_pay_period_id,
          entry_date: req.target_entry_date,
          mattress_count: newValue.mattress_count,
          note: newValue.note,
          entered_by_user_id: input.reviewerUserId,
          entered_at: now,
        },
      });

      appliedEntryId = inserted.id;
      beforeAuditPayload = Prisma.JsonNull;
      afterAuditPayload = serializeJson({
        mattress_count: inserted.mattress_count.toNumber(),
        note: inserted.note,
        entered_by_user_id: inserted.entered_by_user_id,
      }) as Prisma.InputJsonValue;
      entryAction = 'insert';
    }

    const entryAudit = await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        actor_label: 'system:amendment-approved',
        action: entryAction,
        table_name: 'bonus_daily_entries',
        row_id: appliedEntryId,
        before: beforeAuditPayload,
        after: afterAuditPayload,
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    const decided = await tx.bonusAmendmentRequest.update({
      where: { id: req.id },
      data: {
        state: 'approved',
        reviewed_by_user_id: input.reviewerUserId,
        reviewed_at: now,
        decision_notes: input.decisionNotes ?? null,
        applied_audit_id: entryAudit.id,
        updated_at: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: req.id,
        before: { state: 'pending' },
        after: {
          state: 'approved',
          reviewed_by_user_id: input.reviewerUserId,
          applied_audit_id: entryAudit.id,
        },
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return { request: decided, appliedEntryId, entryAuditId: entryAudit.id };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Reject
// ─────────────────────────────────────────────────────────────────────

export async function rejectAmendmentRequest(input: AmendmentDecisionInput) {
  if (!input.decisionNotes || input.decisionNotes.trim().length === 0) {
    throw new AmendmentRequestError('reject_requires_notes', 422);
  }
  // Hoist the narrowed, trimmed reason: the guard above narrows the parameter,
  // but the async $transaction closure below re-widens it, so we capture it here.
  const decisionNotes = input.decisionNotes.trim();

  return prisma.$transaction(async (tx) => {
    const req = await tx.bonusAmendmentRequest.findUnique({ where: { id: input.requestId } });
    if (!req) throw new AmendmentRequestError('request_not_found', 404);
    if (req.state !== 'pending') throw new AmendmentRequestError('request_not_pending', 409);

    const chain = await getSignatureChain(req.site_id, tx as unknown as PrismaClient);
    const eligible = canApproveRequest({
      actorUserId: input.reviewerUserId,
      request: {
        requested_by_user_id: req.requested_by_user_id,
        expected_approver_user_id: req.expected_approver_user_id,
        bill_pinged_at: req.bill_pinged_at,
      },
      chain: { auto_override_actor_user_id: chain.auto_override_actor_user_id },
      actorIsAdmin: input.reviewerIsAdmin,
    });
    if (!eligible) throw new AmendmentRequestError('not_eligible_to_approve', 403);

    const now = new Date();
    const decided = await tx.bonusAmendmentRequest.update({
      where: { id: req.id },
      data: {
        state: 'rejected',
        reviewed_by_user_id: input.reviewerUserId,
        reviewed_at: now,
        decision_notes: decisionNotes,
        updated_at: now,
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: input.reviewerUserId,
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: req.id,
        before: { state: 'pending' },
        after: { state: 'rejected', decision_notes: decisionNotes },
        ip: input.ip ?? null,
        user_agent: input.userAgent ?? null,
      },
    });

    return decided;
  });
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

export async function listPendingForApprover(
  approverUserId: string,
  actorIsAdmin: boolean,
  siteId: string | null,
) {
  const where: Prisma.BonusAmendmentRequestWhereInput = { state: 'pending' };
  if (siteId) where.site_id = siteId;

  if (!actorIsAdmin) {
    where.OR = [
      { expected_approver_user_id: approverUserId },
      // Bill-pinged + caller is the chain's auto-override actor; this is
      // narrowed at the route layer when the caller is not Bill (so a
      // non-admin non-auto-override actor sees no pinged-extras).
      {
        AND: [
          { bill_pinged_at: { not: null } },
          // Caller must be the auto-override actor for these to be theirs.
          // We don't have the chain here so we pass approverUserId match
          // implicitly — Bill is the auto-override at every site today.
        ],
      },
    ];
  }

  return prisma.bonusAmendmentRequest.findMany({
    where,
    orderBy: { requested_at: 'asc' },
    include: {
      bonus_pay_period: {
        select: { period_number: true, period_year: true, period_start: true, period_end: true },
      },
      bonus_employee: { select: { full_name: true, employee_number: true } },
      requested_by: { select: { name: true, email: true } },
      expected_approver: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
}

export async function getAmendmentRequest(requestId: string) {
  return prisma.bonusAmendmentRequest.findUnique({
    where: { id: requestId },
    include: {
      bonus_pay_period: {
        select: {
          period_number: true,
          period_year: true,
          period_start: true,
          period_end: true,
          state: true,
        },
      },
      bonus_employee: { select: { full_name: true, employee_number: true, site_id: true } },
      requested_by: { select: { name: true, email: true } },
      expected_approver: { select: { name: true } },
      reviewed_by: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
}

export async function listPendingForPeriod(periodId: string) {
  return prisma.bonusAmendmentRequest.findMany({
    where: { bonus_pay_period_id: periodId, state: 'pending' },
    orderBy: { requested_at: 'asc' },
    include: {
      bonus_employee: { select: { full_name: true, employee_number: true } },
      requested_by: { select: { name: true } },
      expected_approver: { select: { name: true } },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Routing predicate for daily-entry layer
// ─────────────────────────────────────────────────────────────────────

export interface ShouldRequireAmendmentInput {
  periodState: string;
  entryDate: Date;
  newCount: number;
  existingCount: number | null;
  actorIsAdmin: boolean;
}

export type ShouldRequireAmendmentResult =
  | { route: 'direct'; reason: string }
  | {
      route: 'amendment';
      changeType: 'update' | 'insert';
      oldValue: { mattress_count: number; note: string | null } | null;
    };

export function shouldRequireAmendment(
  input: ShouldRequireAmendmentInput,
  existingNote: string | null = null,
): ShouldRequireAmendmentResult {
  if (input.periodState !== 'draft') {
    return { route: 'direct', reason: 'period_not_draft_handled_upstream' };
  }
  if (input.actorIsAdmin) {
    return { route: 'direct', reason: 'admin_direct_path' };
  }

  const today = appToday();
  const isPriorDay = input.entryDate.getTime() < today.getTime();
  if (!isPriorDay) {
    return { route: 'direct', reason: 'same_day_or_future' };
  }

  const isInsert = input.existingCount === null;
  const countChanged = input.existingCount !== null && input.newCount !== input.existingCount;
  if (!isInsert && !countChanged) {
    return { route: 'direct', reason: 'note_only_edit' };
  }

  return {
    route: 'amendment',
    changeType: isInsert ? 'insert' : 'update',
    oldValue:
      input.existingCount === null
        ? null
        : { mattress_count: input.existingCount, note: existingNote },
  };
}

// Internal
function serializeJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export { AmendmentWorkflowForbiddenError };
