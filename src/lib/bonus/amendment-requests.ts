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

import { randomUUID } from 'node:crypto';
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
      | 'cancel_only_by_requester'
      | 'empty_batch'
      | 'group_not_pending',
    statusCode = 409,
  ) {
    super(`amendment request error: ${reason}`);
    this.name = 'AmendmentRequestError';
    this.status = statusCode;
  }
}

/** One line of a (possibly multi-line) prior-day correction. */
export interface AmendmentItemInput {
  bonusEmployeeId: string;
  changeType: 'update' | 'insert';
  /** ADR-0083 — `saves` travels with the count; both are amendable payroll values. */
  newValue: { mattress_count: number; saves: number; note: string | null };
}

export interface SubmitAmendmentInput {
  siteId: string;
  bonusPayPeriodId: string;
  targetEntryDate: Date;
  bonusEmployeeId: string;
  changeType: 'update' | 'insert';
  newValue: { mattress_count: number; saves: number; note: string | null };
  justification: string;
  requesterUserId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * ADR-0029: a batch of prior-day corrections submitted together in one save.
 * Shares one `bonusPayPeriodId` / `targetEntryDate` / `justification` across N
 * line items so the workflow can stamp them with a single `submission_group_id`
 * and notify ONCE per direction.
 */
export interface SubmitAmendmentBatchInput {
  siteId: string;
  bonusPayPeriodId: string;
  targetEntryDate: Date;
  justification: string;
  requesterUserId: string;
  items: AmendmentItemInput[];
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

function validateCount(count: number): void {
  if (
    !Number.isFinite(count) ||
    count < 0 ||
    count > 999 ||
    Math.abs(count * 10 - Math.round(count * 10)) > 1e-9
  ) {
    throw new AmendmentRequestError('invalid_count', 422);
  }
}

/**
 * Create ONE amendment request inside an already-open transaction. Validates the
 * employee belongs to the site, the entry exists/doesn't-exist for the change
 * type, auto-cancels a prior pending request from the same requester for the
 * same target, and writes the per-request insert audit row (CLAUDE.md hard rule
 * #6). The period-draft check is done ONCE by the caller before any item runs.
 *
 * Shared by both `submitAmendmentRequest` (N=1) and `submitAmendmentBatch` (N≥1)
 * so a single line and a multi-line save go through identical row/audit logic.
 */
async function createOneAmendmentInTx(
  tx: Prisma.TransactionClient,
  ctx: {
    siteId: string;
    bonusPayPeriodId: string;
    targetEntryDate: Date;
    requesterUserId: string;
    expectedApproverUserId: string;
    justification: string;
    submissionGroupId: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
  item: AmendmentItemInput,
) {
  const employee = await tx.bonusEmployee.findUnique({
    where: { id: item.bonusEmployeeId },
    select: { id: true, site_id: true },
  });
  if (!employee || employee.site_id !== ctx.siteId) {
    throw new AmendmentRequestError('employee_not_in_site', 404);
  }

  const existing = await tx.bonusDailyEntry.findUnique({
    where: {
      bonus_employee_id_entry_date: {
        bonus_employee_id: item.bonusEmployeeId,
        entry_date: ctx.targetEntryDate,
      },
    },
    // ADR-0083 — `saves` is part of the old-value snapshot the approver reviews.
    select: { id: true, mattress_count: true, saves: true, note: true },
  });

  if (item.changeType === 'update' && !existing) {
    throw new AmendmentRequestError('entry_not_found_for_update', 409);
  }
  if (item.changeType === 'insert' && existing) {
    throw new AmendmentRequestError('entry_exists_for_insert', 409);
  }

  const oldValueSnapshot =
    item.changeType === 'update' && existing
      ? {
          mattress_count: existing.mattress_count.toNumber(),
          saves: existing.saves.toNumber(),
          note: existing.note,
        }
      : null;

  // Auto-cancel any prior PENDING request from this requester for the same target.
  const priorPending = await tx.bonusAmendmentRequest.findMany({
    where: {
      bonus_employee_id: item.bonusEmployeeId,
      target_entry_date: ctx.targetEntryDate,
      requested_by_user_id: ctx.requesterUserId,
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
        actor_user_id: ctx.requesterUserId,
        actor_label: 'system:amendment-supersede',
        action: 'update' satisfies AuditAction,
        table_name: 'bonus_amendment_requests',
        row_id: p.id,
        before: { state: 'pending' },
        after: { state: 'cancelled', reason: 'superseded_by_new_request' },
        ip: ctx.ip ?? null,
        user_agent: ctx.userAgent ?? null,
      },
    });
  }

  const created = await tx.bonusAmendmentRequest.create({
    data: {
      bonus_pay_period_id: ctx.bonusPayPeriodId,
      site_id: ctx.siteId,
      target_entry_date: ctx.targetEntryDate,
      bonus_employee_id: item.bonusEmployeeId,
      change_type: item.changeType,
      old_value: oldValueSnapshot
        ? (serializeJson(oldValueSnapshot) as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      new_value: serializeJson(item.newValue) as Prisma.InputJsonValue,
      justification: ctx.justification,
      requested_by_user_id: ctx.requesterUserId,
      expected_approver_user_id: ctx.expectedApproverUserId,
      submission_group_id: ctx.submissionGroupId,
    },
  });

  await tx.auditLog.create({
    data: {
      actor_user_id: ctx.requesterUserId,
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
        new_value: item.newValue,
        justification: created.justification,
        expected_approver_user_id: created.expected_approver_user_id,
        submission_group_id: created.submission_group_id,
      }) as Prisma.InputJsonValue,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
    },
  });

  return created;
}

export async function submitAmendmentRequest(input: SubmitAmendmentInput) {
  // A single-item submit is just an N=1 batch (ADR-0029): identical row + audit
  // logic, one notification. The caller receives the lone created request.
  const result = await submitAmendmentBatch({
    siteId: input.siteId,
    bonusPayPeriodId: input.bonusPayPeriodId,
    targetEntryDate: input.targetEntryDate,
    justification: input.justification,
    requesterUserId: input.requesterUserId,
    items: [
      {
        bonusEmployeeId: input.bonusEmployeeId,
        changeType: input.changeType,
        newValue: input.newValue,
      },
    ],
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  return result.created[0]!;
}

/**
 * ADR-0029: submit N prior-day corrections as one batch. All items share a
 * generated `submission_group_id` (when N>1) so the workflow notifies once per
 * direction. Every request row + its insert-audit row land in ONE transaction;
 * any single item's validation failure rolls back the whole batch (no partial
 * submit). The approver + period-draft checks run once up front.
 *
 * Returns the created requests and the (possibly null) group id. The group id is
 * null for an N=1 submit so singletons stay singletons in the queue.
 */
export async function submitAmendmentBatch(input: SubmitAmendmentBatchInput): Promise<{
  created: Awaited<ReturnType<typeof createOneAmendmentInTx>>[];
  groupId: string | null;
}> {
  if (input.items.length === 0) {
    throw new AmendmentRequestError('empty_batch', 422);
  }
  if (input.justification.trim().length < JUSTIFICATION_MIN_LENGTH) {
    throw new AmendmentRequestError('justification_too_short', 422);
  }
  for (const item of input.items) {
    validateCount(item.newValue.mattress_count);
    // ADR-0083 — same range/precision rule as the count (both Decimal(5,1)),
    // validated independently of the route's zod schema. Never trust the client.
    validateCount(item.newValue.saves);
  }

  // Resolve approver outside the tx (separate read; throws on Patrick). One
  // requester + one site → one approver for the whole batch.
  const { expectedApproverUserId } = await resolveAmendmentApprover(
    prisma,
    input.siteId,
    input.requesterUserId,
  );

  // Singletons keep submission_group_id null; multi-item batches get a shared id.
  const submissionGroupId = input.items.length > 1 ? randomUUID() : null;
  const justification = input.justification.trim();

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

    const created: Awaited<ReturnType<typeof createOneAmendmentInTx>>[] = [];
    for (const item of input.items) {
      created.push(
        await createOneAmendmentInTx(
          tx,
          {
            siteId: input.siteId,
            bonusPayPeriodId: input.bonusPayPeriodId,
            targetEntryDate: input.targetEntryDate,
            requesterUserId: input.requesterUserId,
            expectedApproverUserId,
            justification,
            submissionGroupId,
            ip: input.ip ?? null,
            userAgent: input.userAgent ?? null,
          },
          item,
        ),
      );
    }
    return { created, groupId: submissionGroupId };
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

/**
 * Apply ONE pending approval inside an already-open transaction: writes the
 * entry change, the entry-audit row, marks the request approved, links the
 * audit id, and writes the request-update audit row. Assumes the period-draft
 * check + the eligibility check have already passed for this request. Shared by
 * the single-request and group approve paths.
 */
async function applyApprovalInTx(
  tx: Prisma.TransactionClient,
  req: {
    id: string;
    bonus_employee_id: string;
    bonus_pay_period_id: string;
    target_entry_date: Date;
    change_type: string;
    new_value: Prisma.JsonValue;
  },
  input: {
    reviewerUserId: string;
    decisionNotes?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<{ requestId: string; appliedEntryId: string; entryAuditId: string }> {
  const now = new Date();

  // CAS claim (H1): flip pending→approved atomically as the FIRST mutation, so
  // only the CAS winner goes on to mutate the daily entry. Previously this was a
  // check-then-act (findUnique → `if state!=='pending' throw` → unconditional
  // update): two reviewers who both passed the gate in overlapping tx windows
  // (say one approve + one reject) could both proceed — the approve mutated the
  // bonus entry while the reject overwrote the state to `rejected`, leaving a
  // rejected amendment that had SILENTLY APPLIED, with a falsified `before:
  // pending` audit and a payroll payout reflecting a rejected change. A guarded
  // updateMany matching only a still-`pending` row makes the loser a `count 0`
  // no-op that raises the already-decided 409 — the entry mutation + its audit
  // never run for the loser.
  const claim = await tx.bonusAmendmentRequest.updateMany({
    where: { id: req.id, state: 'pending' },
    data: {
      state: 'approved',
      reviewed_by_user_id: input.reviewerUserId,
      reviewed_at: now,
      decision_notes: input.decisionNotes ?? null,
      updated_at: now,
    },
  });
  if (claim.count === 0) throw new AmendmentRequestError('request_not_pending', 409);

  // ADR-0083 — `saves` is read out of the stored proposal. A request row written
  // before this column existed has no `saves` key, and the amendment must then be
  // applied WITHOUT touching the entry's saves value rather than coercing the
  // missing key to 0 and silently zeroing a real figure on approval. `undefined`
  // is the honest representation of "this proposal said nothing about saves".
  const newValue = req.new_value as {
    mattress_count: number;
    saves?: number;
    note: string | null;
  };

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
      saves: existing.saves.toNumber(),
      note: existing.note,
      entered_by_user_id: existing.entered_by_user_id,
    }) as Prisma.InputJsonValue;

    const updated = await tx.bonusDailyEntry.update({
      where: { id: existing.id },
      data: {
        mattress_count: newValue.mattress_count,
        ...(newValue.saves === undefined ? {} : { saves: newValue.saves }),
        note: newValue.note,
        entered_by_user_id: input.reviewerUserId,
        entered_at: now,
      },
    });

    appliedEntryId = updated.id;
    afterAuditPayload = serializeJson({
      mattress_count: updated.mattress_count.toNumber(),
      saves: updated.saves.toNumber(),
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
        saves: newValue.saves ?? 0,
        note: newValue.note,
        entered_by_user_id: input.reviewerUserId,
        entered_at: now,
      },
    });

    appliedEntryId = inserted.id;
    beforeAuditPayload = Prisma.JsonNull;
    afterAuditPayload = serializeJson({
      mattress_count: inserted.mattress_count.toNumber(),
      saves: inserted.saves.toNumber(),
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

  // The state flip + reviewer/notes already landed via the CAS claim above; here
  // we only link the entry-audit id onto the request row we already own.
  await tx.bonusAmendmentRequest.update({
    where: { id: req.id },
    data: { applied_audit_id: entryAudit.id },
  });

  await tx.auditLog.create({
    data: {
      actor_user_id: input.reviewerUserId,
      action: 'update' satisfies AuditAction,
      table_name: 'bonus_amendment_requests',
      row_id: req.id,
      // `before` reflects the TRUE prior state: the CAS matched a `pending` row.
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

  return { requestId: req.id, appliedEntryId, entryAuditId: entryAudit.id };
}

/**
 * Eligibility gate for an approve/reject of one request inside a transaction.
 * Resolves the signature chain and applies `canApproveRequest`. Throws
 * `not_eligible_to_approve` (403) when the actor may not decide this request.
 */
async function assertEligibleInTx(
  tx: Prisma.TransactionClient,
  req: {
    site_id: string;
    requested_by_user_id: string;
    expected_approver_user_id: string;
    bill_pinged_at: Date | null;
  },
  reviewerUserId: string,
  reviewerIsAdmin: boolean,
): Promise<void> {
  const chain = await getSignatureChain(req.site_id, tx as unknown as PrismaClient);
  const eligible = canApproveRequest({
    actorUserId: reviewerUserId,
    request: {
      requested_by_user_id: req.requested_by_user_id,
      expected_approver_user_id: req.expected_approver_user_id,
      bill_pinged_at: req.bill_pinged_at,
    },
    chain: { auto_override_actor_user_id: chain.auto_override_actor_user_id },
    actorIsAdmin: reviewerIsAdmin,
  });
  if (!eligible) throw new AmendmentRequestError('not_eligible_to_approve', 403);
}

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

    await assertEligibleInTx(tx, req, input.reviewerUserId, input.reviewerIsAdmin);
    const applied = await applyApprovalInTx(tx, req, input);
    const decided = await tx.bonusAmendmentRequest.findUnique({ where: { id: req.id } });
    return {
      request: decided!,
      appliedEntryId: applied.appliedEntryId,
      entryAuditId: applied.entryAuditId,
    };
  });
}

/**
 * ADR-0029: approve EVERY pending request in a submission group atomically. Each
 * item is applied with its own entry write + per-item audit row (identical to
 * the single-request path), all inside ONE transaction. The eligibility +
 * period-draft checks run per request (every member of a group shares the same
 * requester/approver/period, so they pass or fail together). Returns the count
 * applied and a representative request id for notification context.
 */
export async function approveAmendmentGroup(input: {
  submissionGroupId: string;
  reviewerUserId: string;
  reviewerIsAdmin: boolean;
  decisionNotes?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ appliedCount: number; representativeRequestId: string }> {
  return prisma.$transaction(async (tx) => {
    const reqs = await tx.bonusAmendmentRequest.findMany({
      where: { submission_group_id: input.submissionGroupId, state: 'pending' },
      orderBy: { requested_at: 'asc' },
    });
    if (reqs.length === 0) throw new AmendmentRequestError('group_not_pending', 409);

    for (const req of reqs) {
      const period = await tx.bonusPayPeriod.findUnique({
        where: { id: req.bonus_pay_period_id },
        select: { id: true, state: true },
      });
      if (!period || period.state !== 'draft') {
        throw new AmendmentRequestError('period_not_draft', 409);
      }
      await assertEligibleInTx(tx, req, input.reviewerUserId, input.reviewerIsAdmin);
      await applyApprovalInTx(tx, req, {
        reviewerUserId: input.reviewerUserId,
        decisionNotes: input.decisionNotes ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      });
    }

    return { appliedCount: reqs.length, representativeRequestId: reqs[0]!.id };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Reject
// ─────────────────────────────────────────────────────────────────────

/** Mark ONE pending request rejected + audit, inside an open tx. Assumes
 * eligibility already checked. */
async function applyRejectionInTx(
  tx: Prisma.TransactionClient,
  reqId: string,
  reviewerUserId: string,
  decisionNotes: string,
  ip?: string | null,
  userAgent?: string | null,
) {
  const now = new Date();
  // CAS claim (H1): flip pending→rejected atomically so a concurrent approve/
  // reject that already decided the row loses (count 0 → already-decided 409),
  // never a check-then-act double-decide. See applyApprovalInTx for the full
  // rationale (a lost race must leave state + entry untouched).
  const claim = await tx.bonusAmendmentRequest.updateMany({
    where: { id: reqId, state: 'pending' },
    data: {
      state: 'rejected',
      reviewed_by_user_id: reviewerUserId,
      reviewed_at: now,
      decision_notes: decisionNotes,
      updated_at: now,
    },
  });
  if (claim.count === 0) throw new AmendmentRequestError('request_not_pending', 409);
  await tx.auditLog.create({
    data: {
      actor_user_id: reviewerUserId,
      action: 'update' satisfies AuditAction,
      table_name: 'bonus_amendment_requests',
      row_id: reqId,
      // `before` reflects the TRUE prior state: the CAS matched a `pending` row.
      before: { state: 'pending' },
      after: { state: 'rejected', decision_notes: decisionNotes },
      ip: ip ?? null,
      user_agent: userAgent ?? null,
    },
  });
  const decided = await tx.bonusAmendmentRequest.findUnique({ where: { id: reqId } });
  return decided!;
}

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

    await assertEligibleInTx(tx, req, input.reviewerUserId, input.reviewerIsAdmin);
    return applyRejectionInTx(
      tx,
      req.id,
      input.reviewerUserId,
      decisionNotes,
      input.ip,
      input.userAgent,
    );
  });
}

/**
 * ADR-0029: reject EVERY pending request in a submission group atomically, all
 * sharing one rejection reason. Per-request eligibility is checked; per-request
 * audit rows are written; one transaction.
 */
export async function rejectAmendmentGroup(input: {
  submissionGroupId: string;
  reviewerUserId: string;
  reviewerIsAdmin: boolean;
  decisionNotes: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ rejectedCount: number; representativeRequestId: string }> {
  const decisionNotes = input.decisionNotes.trim();
  if (decisionNotes.length === 0) {
    throw new AmendmentRequestError('reject_requires_notes', 422);
  }
  return prisma.$transaction(async (tx) => {
    const reqs = await tx.bonusAmendmentRequest.findMany({
      where: { submission_group_id: input.submissionGroupId, state: 'pending' },
      orderBy: { requested_at: 'asc' },
    });
    if (reqs.length === 0) throw new AmendmentRequestError('group_not_pending', 409);

    for (const req of reqs) {
      await assertEligibleInTx(tx, req, input.reviewerUserId, input.reviewerIsAdmin);
      await applyRejectionInTx(
        tx,
        req.id,
        input.reviewerUserId,
        decisionNotes,
        input.ip,
        input.userAgent,
      );
    }
    return { rejectedCount: reqs.length, representativeRequestId: reqs[0]!.id };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * The `where` clause selecting the pending requests a given actor may review.
 * Shared by `listPendingForApprover` (the queue) and `countPendingForApprover`
 * (the nav badge) so the count and the list never diverge.
 */
function pendingForApproverWhere(
  approverUserId: string,
  actorIsAdmin: boolean,
  siteId: string | null,
): Prisma.BonusAmendmentRequestWhereInput {
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
  return where;
}

/**
 * ADR-0029: count the items pending the current user's review (for the nav
 * "Pending Amendments" badge). Admins see all-site pending; managers see the
 * requests routed to them as approver. This counts ITEMS, not groups — a 16-line
 * batch shows "16" so the approver knows the work ahead, even though it
 * approves/rejects in one click.
 */
export async function countPendingForApprover(
  approverUserId: string,
  actorIsAdmin: boolean,
  siteId: string | null,
): Promise<number> {
  return prisma.bonusAmendmentRequest.count({
    where: pendingForApproverWhere(approverUserId, actorIsAdmin, siteId),
  });
}

export async function listPendingForApprover(
  approverUserId: string,
  actorIsAdmin: boolean,
  siteId: string | null,
) {
  const where = pendingForApproverWhere(approverUserId, actorIsAdmin, siteId);

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
  /**
   * ADR-0083 — the proposed `saves` value. Required alongside `newCount`: both
   * columns are payroll quantities and the gate must weigh both. See the
   * four-eyes note on `shouldRequireAmendment`.
   */
  newSaves: number;
  /** Existing stored `saves`, or null when no entry exists for the day yet. */
  existingSaves: number | null;
  actorIsAdmin: boolean;
}

export type ShouldRequireAmendmentResult =
  | { route: 'direct'; reason: string }
  | {
      route: 'amendment';
      changeType: 'update' | 'insert';
      oldValue: { mattress_count: number; saves: number; note: string | null } | null;
    };

/**
 * Decide whether a proposed daily-entry write may be made DIRECTLY or must go
 * through the ADR-0028 four-eyes prior-day amendment workflow.
 *
 * ADR-0083 — THE FOUR-EYES BYPASS THIS CLOSES:
 *
 * This predicate used to compare `mattress_count` alone, because before saves
 * that single number WAS the payroll value of the row. Adding a second paid
 * column without touching the comparison would have opened a hole: a non-admin
 * manager editing a PRIOR day and changing ONLY the saves figure would compute
 * `countChanged === false`, fall into the `note_only_edit` branch, and be routed
 * 'direct' — writing an unapproved change to what a processor gets paid, in a
 * period that is still open, with no approver, no justification, and nothing in
 * the amendment queue to review. The note-only exemption exists because a note
 * cannot change anybody's pay; saves can.
 *
 * So the gate now weighs BOTH quantities: a prior-day change to either one is an
 * amendment. Only a genuine note-only edit stays direct.
 *
 * Falsified by `__tests__/four-eyes-saves.test.ts`, which reverts this predicate
 * to the count-only comparison and asserts it goes RED — i.e. proves the test
 * would actually catch the regression rather than merely passing beside it.
 */
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
  // ADR-0083 — a null `existingSaves` alongside a non-null `existingCount` means
  // the row predates the column; the stored value is then the column default 0,
  // so that is what the proposal is compared against. Treating null as "no
  // change possible" would reopen the bypass for exactly the historical rows
  // most likely to be corrected.
  const savesChanged =
    input.existingCount !== null && input.newSaves !== (input.existingSaves ?? 0);
  if (!isInsert && !countChanged && !savesChanged) {
    return { route: 'direct', reason: 'note_only_edit' };
  }

  return {
    route: 'amendment',
    changeType: isInsert ? 'insert' : 'update',
    oldValue:
      input.existingCount === null
        ? null
        : {
            mattress_count: input.existingCount,
            saves: input.existingSaves ?? 0,
            note: existingNote,
          },
  };
}

// Internal
function serializeJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

export { AmendmentWorkflowForbiddenError };
