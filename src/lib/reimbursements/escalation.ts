// ADR-0068 D5 (Amendment 2) — the plain 24-hour weekday-clock timeout escalation.
//
// ── What this closes ────────────────────────────────────────────────────────
// Two escalation paths exist for a reimbursement, and only one of them shipped
// with the feature:
//
//   IMMEDIATE (shipped): the routed peer IS the person being reimbursed, or the
//     free-text beneficiary name is an ambiguous match, or the submitter has no
//     routing row. There is no valid local approver, so `submitReimbursement`
//     stamps `escalated_at` at SUBMIT time — waiting a day accomplishes nothing.
//
//   TIMEOUT (this file): a perfectly valid peer simply has not acted. That needs
//     a clock, and without it a reimbursement could sit on one person's desk
//     indefinitely with nobody else told.
//
// ── Why the immediate path cannot be double-escalated ──────────────────────
// `escalated_at IS NULL` is BOTH the candidate filter and the conditional on the
// claim, exactly as `escalation-scan.ts` does it for AP. A row escalated at
// submit time already carries `escalated_at`, so it is never a candidate here and
// can never be re-escalated or double-paged. That is not a coincidence to be
// grateful for — it is why this file reuses that key rather than inventing one.
//
// ── One clock, one resolver ────────────────────────────────────────────────
// The weekday business clock is `businessHoursElapsedExceeds` from
// `@/lib/ap/business-clock` — the same function AP uses, including its weekend
// and holiday skips. The eligible set comes from
// `resolveReimbursementApproval`, which is itself a thin wrapper over the shared
// AP resolver. No second clock, no second routing table, no third answer to "who
// may sign".
//
// ── Escalation is ADDITIVE, never a transfer ───────────────────────────────
// The originally routed peer stays able to sign. `escalated_to` names who was
// ADDED, and the audit row records `additive: true` so an auditor can read that
// property straight off the row rather than re-deriving it.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { businessHoursElapsedExceeds } from '@/lib/ap/business-clock';
import { resolveReimbursementApproval } from './routing';
import { notifyReimbursementEscalated } from './notify';

const TABLE = 'reimbursement_requests';
const ACTOR_LABEL = 'system:reimbursement-escalation-scan';

/** Used when the submitter's routing row carries no usable `fallback_after_hours`. */
const DEFAULT_THRESHOLD_HOURS = 24;

export interface ReimbursementEscalationResult {
  scanned: number;
  escalated: number;
  requestIds: string[];
  /** Misconfigurations worth a warning line in Bill's 06:00 digest. */
  problems: string[];
}

export interface RunReimbursementEscalationOpts {
  prisma?: PrismaClient;
  now?: Date;
}

async function thresholdHoursFor(prisma: PrismaClient, submitterId: string): Promise<number> {
  const row = await prisma.apApprovalRouting.findFirst({
    where: { first_approver_id: submitterId, active: true },
    select: { fallback_after_hours: true },
  });
  const h = row?.fallback_after_hours;
  return typeof h === 'number' && h > 0 ? h : DEFAULT_THRESHOLD_HOURS;
}

interface Candidate {
  id: string;
  site_id: string;
  amount_cents: number;
  submitted_by: string;
  submitted_at: Date;
  employee_user_id: string | null;
  employee_name_freeform: string | null;
}

/**
 * Escalate one candidate if its weekday clock has run out. Returns whether THIS
 * call claimed the escalation — a concurrent run, or a decision that landed
 * mid-scan, yields `false` silently and correctly.
 */
async function escalateIfDue(
  prisma: PrismaClient,
  req: Candidate,
  now: Date,
): Promise<{ escalated: boolean; problems: string[] }> {
  const thresholdHours = await thresholdHoursFor(prisma, req.submitted_by);
  const due = await businessHoursElapsedExceeds(prisma, req.submitted_at, thresholdHours, now);
  if (!due) return { escalated: false, problems: [] };

  // Resolve WITH the escalated widening applied, so the fallback approver joins
  // the eligible set. Still excludes the submitter and the beneficiary — a
  // timeout never relaxes the control.
  const routed = await resolveReimbursementApproval(prisma, {
    submittedBy: req.submitted_by,
    employeeUserId: req.employee_user_id,
    employeeNameFreeform: req.employee_name_freeform,
    escalated: true,
  });

  const target = routed.recipients[0] ?? null;
  const problems = [...routed.problems];

  if (!target) {
    // Nobody reachable can sign even after widening. This must be LOUD: the row
    // is aging and there is no path to a signature. Do NOT stamp `escalated_at`
    // — leaving it NULL keeps the row a candidate so the next run retries once
    // the roster is fixed, rather than marking it handled forever.
    problems.push(
      `Reimbursement ${req.id} ($${(req.amount_cents / 100).toFixed(2)}) has been waiting past ${thresholdHours} business hours and there is NO reachable approver who is neither the submitter nor the beneficiary. It has NOT been escalated because there is nobody to escalate to.`,
    );
    return { escalated: false, problems };
  }

  // ── The claim ─────────────────────────────────────────────────────────────
  // Conditional on `escalated_at IS NULL`, with the audit row in the SAME
  // transaction (hard rule #6): no window where a row is stamped escalated with
  // no audit trail, and no window where two runs both believe they claimed it.
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.reimbursementRequest.updateMany({
      where: { id: req.id, status: 'pending_second_approval', escalated_at: null },
      data: { escalated_at: now, escalated_to: target.userId, escalation_reason: 'timeout' },
    });
    if (res.count === 0) return false;
    await writeAudit(
      {
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: TABLE,
        row_id: req.id,
        before: { status: 'pending_second_approval', escalated_at: null, escalated_to: null },
        after: {
          status: 'pending_second_approval', // UNCHANGED — escalation is not a decision
          escalated_at: now.toISOString(),
          escalated_to: target.userId,
          escalation_reason: 'timeout',
          threshold_hours: thresholdHours,
          submitted_by: req.submitted_by,
          submitted_at: req.submitted_at.toISOString(),
          // Readable straight off the row, so an auditor never has to re-derive it.
          additive: true,
          still_authorized: routed.authorizedUserIds,
          // The control still holds after widening — assert it in the record.
          submitter_excluded: !routed.authorizedUserIds.includes(req.submitted_by),
        },
      },
      { tx },
    );
    return true;
  });
  if (!claimed) return { escalated: false, problems };

  // Outside the transaction: a mail failure must never roll back a committed
  // escalation, and the outcome is reported rather than swallowed.
  const mail = await notifyReimbursementEscalated(prisma, req.id, thresholdHours).catch(() => null);
  if (mail) problems.push(...mail.problems);
  if (!mail) {
    problems.push(
      `Reimbursement ${req.id} was escalated but the notification threw — ${target.name} may not know.`,
    );
  }

  return { escalated: true, problems };
}

/**
 * Run one reimbursement escalation scan.
 *
 * Safe to call repeatedly: a re-run over an already-escalated backlog claims
 * nothing, notifies nobody and writes no audit rows, because `escalated_at` is
 * both the idempotency key and the "this was handled" marker.
 */
export async function runReimbursementEscalationScan(
  opts: RunReimbursementEscalationOpts = {},
): Promise<ReimbursementEscalationResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();

  const candidates = (await prisma.reimbursementRequest.findMany({
    where: { status: 'pending_second_approval', escalated_at: null },
    select: {
      id: true,
      site_id: true,
      amount_cents: true,
      submitted_by: true,
      submitted_at: true,
      employee_user_id: true,
      employee_name_freeform: true,
    },
  })) as Candidate[];

  const problems: string[] = [];
  const requestIds: string[] = [];
  let failed = 0;

  for (const req of candidates) {
    try {
      const res = await escalateIfDue(prisma, req, now);
      if (res.escalated) requestIds.push(req.id);
      problems.push(...res.problems);
    } catch (err) {
      // Contained: one poisoned row must not strand the rest of the backlog.
      failed += 1;
      problems.push(
        `Reimbursement ${req.id}: escalation evaluation failed — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failed > 0) {
    problems.push(
      `${failed} of ${candidates.length} pending reimbursement(s) could not be evaluated for escalation.`,
    );
  }

  return { scanned: candidates.length, escalated: requestIds.length, requestIds, problems };
}
