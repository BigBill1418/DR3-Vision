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

export async function notifyAmendmentSubmitted(
  ctx: AmendmentNotifyContext,
  approverEmail: string | null,
) {
  const title = `Amendment requested — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${ctx.requesterName} requested an amendment to ${ctx.siteName} Period ${ctx.periodNumber}.\n\n` +
    `${changeSummary(ctx)}\n\n` +
    `Justification: ${ctx.justification}\n\n` +
    `Open /bonus/amendments to review.`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['memo', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-submitted:${ctx.requestId}`,
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
          { requestId: ctx.requestId, lastStatus: r.lastStatus },
          '[amendment] approver email failed',
        );
      }
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId }, '[amendment] approver email threw');
    }
  }
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

export async function notifyAmendmentApproved(
  ctx: AmendmentNotifyContext,
  reviewerName: string,
  billEmail: string | null,
  requesterEmail: string | null,
) {
  const title = `Amendment approved — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${reviewerName} approved ${ctx.requesterName}'s amendment.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['white_check_mark', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-approved:${ctx.requestId}`,
  });

  for (const addr of [billEmail, requesterEmail].filter((x): x is string => !!x)) {
    try {
      await sendSystemEmail({
        to: addr,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId, to: addr }, '[amendment] approve email threw');
    }
  }
}

export async function notifyAmendmentRejected(
  ctx: AmendmentNotifyContext,
  reviewerName: string,
  decisionNotes: string,
  billEmail: string | null,
  requesterEmail: string | null,
) {
  const title = `Amendment rejected — ${ctx.siteName} Period ${ctx.periodNumber}`;
  const body =
    `${reviewerName} rejected ${ctx.requesterName}'s amendment.\n\n` +
    `${changeSummary(ctx)}\n\nJustification: ${ctx.justification}\n\nDecision: ${decisionNotes}`;

  await publishNtfy({
    topic: TOPIC,
    title,
    body,
    priority: 'high',
    tags: ['x', 'bonus', 'amendment'],
    fingerprint: `bonus-amendment-rejected:${ctx.requestId}`,
  });

  for (const addr of [billEmail, requesterEmail].filter((x): x is string => !!x)) {
    try {
      await sendSystemEmail({
        to: addr,
        subject: `[DR3-Vision] ${title}`,
        htmlBody: htmlBody(body),
      });
    } catch (e) {
      log.warn({ err: e, requestId: ctx.requestId, to: addr }, '[amendment] reject email threw');
    }
  }
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
