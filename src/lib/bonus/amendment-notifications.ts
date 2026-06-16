// ADR-0028 — Amendment-workflow notifications.
//
// ntfy + M365 mail wiring for the four lifecycle events. The publishNtfy helper
// auto-prefixes titles with [DR3-Vision], so our titles must NOT include that
// prefix (would double-prefix). sendSystemEmail accepts htmlBody (HTML); we
// wrap our plain-text bodies in <pre> to preserve formatting.

import { publishNtfy } from '@/lib/ntfy';
import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { prisma } from '@/lib/prisma';

const TOPIC = 'dr3-vision-system';

export interface AmendmentNotifyContext {
  requestId: string;
  siteCode: string;
  siteName: string;
  periodNumber: number;
  periodYear: number;
  employeeName: string;
  targetEntryDateLabel: string;
  changeType: 'update' | 'insert';
  oldValue: { mattress_count: number; note: string | null } | null;
  newValue: { mattress_count: number; note: string | null };
  justification: string;
  requesterName: string;
  approverName: string;
}

function changeSummary(c: AmendmentNotifyContext): string {
  if (c.changeType === 'insert') {
    return `INSERT new entry: ${c.newValue.mattress_count} mattresses for ${c.employeeName} on ${c.targetEntryDateLabel}`;
  }
  const oldCount = c.oldValue?.mattress_count ?? '(unknown)';
  return `UPDATE ${c.employeeName} on ${c.targetEntryDateLabel}: ${oldCount} → ${c.newValue.mattress_count}`;
}

function htmlBody(text: string): string {
  // Escape angle brackets/ampersands; preserve newlines via <pre>.
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="font-family: system-ui, sans-serif; font-size: 14px;">${escaped}</pre>`;
}

export async function notifyAmendmentBillPinged(
  ctx: AmendmentNotifyContext,
  billEmail: string | null,
) {
  const title = `URGENT: ${ctx.requesterName} pinged you — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${ctx.requesterName} pinged you to review an amendment request that ${ctx.approverName} has not yet acted on.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}\n\nOpen /bonus/amendments to review.`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'urgent',
    tags: ['rotating_light', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-bill-pinged:${ctx.requestId}`,
  });

  if (billEmail) {
    try {
      await sendSystemEmail({
        to: billEmail,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
        importance: 'high',
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId }, '[amendment] ping-bill email threw');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// ADR-0029 — batch notifications (one per direction per root action).
// ─────────────────────────────────────────────────────────────────────

export interface AmendmentBatchItem {
  employeeName: string;
  changeType: 'update' | 'insert';
  oldCount: number | null;
  newCount: number;
}

export interface AmendmentBatchNotifyContext {
  /** Representative request id (for the ntfy dedup fingerprint). */
  representativeRequestId: string;
  /** Group id when this is a true multi-line batch; null for a singleton. */
  submissionGroupId: string | null;
  siteName: string;
  periodNumber: number;
  periodYear: number;
  targetEntryDateLabel: string;
  justification: string;
  requesterName: string;
  approverName: string;
  items: AmendmentBatchItem[];
}

function itemLine(i: AmendmentBatchItem): string {
  if (i.changeType === 'insert') {
    return `  • ${i.employeeName}: NEW ${i.newCount}`;
  }
  return `  • ${i.employeeName}: ${i.oldCount ?? '(unknown)'} → ${i.newCount}`;
}

function batchSummaryLines(ctx: AmendmentBatchNotifyContext): string {
  return ctx.items.map(itemLine).join('\n');
}

function correctionsLabel(n: number): string {
  return n === 1 ? '1 prior-day correction' : `${n} prior-day corrections`;
}

/**
 * ADR-0029: ONE submitted notification for a whole batch — one email to the
 * approver, one ntfy to Bill — regardless of how many line items it carries.
 * A single-item submit (N=1) takes this same path and sends exactly one.
 */
export async function notifyAmendmentBatchSubmitted(
  ctx: AmendmentBatchNotifyContext,
  approverEmail: string | null,
) {
  const n = ctx.items.length;
  const title = `Amendment requested — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${ctx.requesterName} submitted ${correctionsLabel(n)} for ${ctx.siteName} Period ` +
    `${ctx.periodNumber} (${ctx.targetEntryDateLabel}):\n\n` +
    `${batchSummaryLines(ctx)}\n\n` +
    `Justification: ${ctx.justification}\n\n` +
    `Open /bonus/amendments to review.`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['memo', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-submitted:${ctx.submissionGroupId ?? ctx.representativeRequestId}`,
  });

  if (approverEmail) {
    try {
      const r = await sendSystemEmail({
        to: approverEmail,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
      if (!r.delivered && !r.disabled) {
        log.warn(
          { requestId: ctx.representativeRequestId, lastStatus: r.lastStatus },
          '[amendment] approver batch email failed',
        );
      }
    } catch (e) {
      log.warn(
        { err: e, requestId: ctx.representativeRequestId },
        '[amendment] approver batch email threw',
      );
    }
  }
}

/**
 * ADR-0029: ONE result notification for a whole approved/rejected batch — one
 * ntfy to Bill, one email each to Bill + the requester.
 */
export async function notifyAmendmentBatchDecided(
  ctx: AmendmentBatchNotifyContext,
  outcome: 'approved' | 'rejected',
  reviewerName: string,
  decisionNotes: string | null,
  billEmail: string | null,
  requesterEmail: string | null,
) {
  const n = ctx.items.length;
  const verb = outcome === 'approved' ? 'approved' : 'rejected';
  const title = `Amendment ${verb} — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const decisionLine =
    outcome === 'rejected' && decisionNotes ? `\n\nDecision: ${decisionNotes}` : '';
  const body =
    `${reviewerName} ${verb} ${ctx.requesterName}'s ${correctionsLabel(n)} for ` +
    `${ctx.targetEntryDateLabel}:\n\n` +
    `${batchSummaryLines(ctx)}${decisionLine}`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: [outcome === 'approved' ? 'white_check_mark' : 'x', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-${outcome}:${ctx.submissionGroupId ?? ctx.representativeRequestId}`,
  });

  for (const addr of [billEmail, requesterEmail].filter((x): x is string => !!x)) {
    try {
      await sendSystemEmail({
        to: addr,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
    } catch (e) {
      log.warn(
        { err: e, requestId: ctx.representativeRequestId, to: addr },
        `[amendment] ${outcome} batch email threw`,
      );
    }
  }
}

/**
 * Build the batch notification context from the request rows that share a
 * submission_group_id (or a single request id for an N=1 submit / singleton
 * decision). Reads the shared site/period/requester/approver fields off the
 * representative row and the per-item old→new counts off each.
 */
export async function buildBatchNotifyContext(
  requestIds: string[],
): Promise<AmendmentBatchNotifyContext | null> {
  if (requestIds.length === 0) return null;
  const rows = await prisma.bonusAmendmentRequest.findMany({
    where: { id: { in: requestIds } },
    orderBy: { requested_at: 'asc' },
    include: {
      bonus_pay_period: { select: { period_number: true, period_year: true } },
      bonus_employee: { select: { full_name: true } },
      requested_by: { select: { name: true } },
      expected_approver: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
  if (rows.length === 0) return null;

  const head = rows[0]!;
  const items: AmendmentBatchItem[] = rows.map((r) => {
    const oldValue = r.old_value as { mattress_count: number } | null;
    const newValue = r.new_value as { mattress_count: number };
    return {
      employeeName: r.bonus_employee.full_name,
      changeType: r.change_type as 'update' | 'insert',
      oldCount: oldValue?.mattress_count ?? null,
      newCount: newValue.mattress_count,
    };
  });

  return {
    representativeRequestId: head.id,
    submissionGroupId: head.submission_group_id,
    siteName: head.site.name,
    periodNumber: head.bonus_pay_period.period_number,
    periodYear: head.bonus_pay_period.period_year,
    targetEntryDateLabel: head.target_entry_date.toISOString().slice(0, 10),
    justification: head.justification,
    requesterName: head.requested_by.name,
    approverName: head.expected_approver.name,
    items,
  };
}

/**
 * Resolve all request ids belonging to a submission group (any state — a
 * just-decided group's rows are no longer pending). Used by the approve/reject
 * group routes to build the one result notification.
 */
export async function requestIdsForGroup(submissionGroupId: string): Promise<string[]> {
  const rows = await prisma.bonusAmendmentRequest.findMany({
    where: { submission_group_id: submissionGroupId },
    select: { id: true },
    orderBy: { requested_at: 'asc' },
  });
  return rows.map((r) => r.id);
}

export async function buildNotifyContext(
  requestId: string,
): Promise<AmendmentNotifyContext | null> {
  const req = await prisma.bonusAmendmentRequest.findUnique({
    where: { id: requestId },
    include: {
      bonus_pay_period: { select: { period_number: true, period_year: true } },
      bonus_employee: { select: { full_name: true } },
      requested_by: { select: { name: true } },
      expected_approver: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
  });
  if (!req) return null;
  return {
    requestId: req.id,
    siteCode: req.site.code,
    siteName: req.site.name,
    periodNumber: req.bonus_pay_period.period_number,
    periodYear: req.bonus_pay_period.period_year,
    employeeName: req.bonus_employee.full_name,
    targetEntryDateLabel: req.target_entry_date.toISOString().slice(0, 10),
    changeType: req.change_type as 'update' | 'insert',
    oldValue: req.old_value as AmendmentNotifyContext['oldValue'],
    newValue: req.new_value as AmendmentNotifyContext['newValue'],
    justification: req.justification,
    requesterName: req.requested_by.name,
    approverName: req.expected_approver.name,
  };
}
