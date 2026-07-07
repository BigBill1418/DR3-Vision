// ADR-0046 D4 — approval + return path.
//
// Decisions require an authenticated Vision session over the stored record (email
// can only CREATE requests, D6). First action wins, ATOMICALLY: a conditional
// updateMany({where:{id,status:'pending'}}) — the winner flips the row, the loser
// gets a count of 0 and "already decided by {actor} at {time}". BOTH attempts are
// audited (ADR-0028/0041 machinery). The decision email goes to a FIXED configured
// recipient list (ap_decision_recipients) — NEVER the inbound Reply-To (C3.3);
// with zero active recipients the send REFUSES and pages (never silent).

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';

const TABLE = 'ap_requests';

export type ApDecision = 'approved' | 'rejected';

export class ApRequestNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(id: string) {
    super(`AP request ${id} not found`);
    this.name = 'ApRequestNotFoundError';
  }
}

export class ApNotActionableError extends Error {
  readonly status = 409 as const;
  constructor(readonly currentStatus: string) {
    super(`AP request is ${currentStatus}; only a pending request can be decided`);
    this.name = 'ApNotActionableError';
  }
}

export class ApAlreadyDecidedError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly decision: string,
    readonly decidedByName: string,
    readonly decidedAt: Date | null,
  ) {
    super(
      `already ${decision} by ${decidedByName}${decidedAt ? ` at ${decidedAt.toISOString()}` : ''}`,
    );
    this.name = 'ApAlreadyDecidedError';
  }
}

export type ApMailOutcome = 'sent' | 'refused_no_recipients' | 'disabled' | 'failed';

export interface DecideResult {
  requestId: string;
  decision: ApDecision;
  mail: ApMailOutcome;
}

export interface DecideArgs {
  prisma?: PrismaClient;
  requestId: string;
  decision: ApDecision;
  actorUserId: string;
  note?: string;
  vendor?: string; // optional, keyed at decision (C9-D5)
  amountCents?: number; // optional
}

/** The approver set as data (C5): active users with org reach (admin OR all_sites) + an email. */
export async function apApproverEmails(prisma: PrismaClient = defaultPrisma): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: {
      is_active: true,
      email: { not: null },
      OR: [{ role: 'admin' }, { all_sites: true }],
    },
    select: { email: true },
  });
  return rows.map((r) => r.email).filter((e): e is string => !!e);
}

/** Count of pending AP requests — for the ADR-0043 digest line (D4). */
export async function pendingApCount(prisma: PrismaClient = defaultPrisma): Promise<number> {
  return prisma.apRequest.count({ where: { status: 'pending' } });
}

async function resolveName(prisma: PrismaClient, userId: string | null): Promise<string> {
  if (!userId) return 'another approver';
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name ?? 'another approver';
}

/**
 * Decide a pending AP request (approve/reject), first-action-wins. Returns the
 * decision + the decision-mail outcome. Throws ApAlreadyDecidedError to the loser
 * of a race (both attempts audited). The state change stands even if the decision
 * email later refuses/fails — that is surfaced via `mail` + a page, never silently.
 */
export async function decideRequest(args: DecideArgs): Promise<DecideResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: { id: true, status: true, subject: true, decided_by: true, decided_at: true },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  if (row.status === 'quarantined') throw new ApNotActionableError('quarantined');

  const decidedAt = new Date();
  // Atomic conditional transition — only flips a still-pending row.
  const res = await prisma.apRequest.updateMany({
    where: { id: args.requestId, status: 'pending' },
    data: {
      status: args.decision,
      decided_by: args.actorUserId,
      decided_at: decidedAt,
      ...(args.note ? { decision_note: args.note } : {}),
      ...(args.vendor ? { vendor: args.vendor } : {}),
      ...(typeof args.amountCents === 'number' ? { amount_cents: args.amountCents } : {}),
    },
  });

  if (res.count === 0) {
    // Lost the race (or was already non-pending). Audit the losing attempt, then
    // reflect the winner back to the caller.
    const winner = await prisma.apRequest.findUnique({
      where: { id: args.requestId },
      select: { status: true, decided_by: true, decided_at: true },
    });
    await writeAudit({
      actor_user_id: args.actorUserId,
      action: 'update',
      table_name: TABLE,
      row_id: args.requestId,
      after: { attempted: args.decision, outcome: 'lost', winner_status: winner?.status ?? 'unknown' },
    });
    const name = await resolveName(prisma, winner?.decided_by ?? row.decided_by);
    throw new ApAlreadyDecidedError(winner?.status ?? row.status, name, winner?.decided_at ?? row.decided_at);
  }

  // Won. Audit the winning transition (both-attempts-audited: this is the winner's row).
  await writeAudit({
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: args.requestId,
    before: { status: 'pending' },
    after: {
      attempted: args.decision,
      outcome: 'won',
      status: args.decision,
      has_note: !!args.note,
      has_vendor: !!args.vendor,
      has_amount: typeof args.amountCents === 'number',
    },
  });

  const mail = await sendDecisionEmail(prisma, args.requestId);
  return { requestId: args.requestId, decision: args.decision, mail };
}

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Mail the decision to the FIXED recipient list (Mary's GP filing). Carries request
 * id, original subject, decision, approver, timestamp, optional note — sufficient
 * for GP matching under any input shape (C10.5). With zero active recipients it
 * REFUSES and pages (the decision stands; the notification is the operator's to
 * fix by configuring recipients — documented action).
 */
export async function sendDecisionEmail(prisma: PrismaClient, requestId: string): Promise<ApMailOutcome> {
  const req = await prisma.apRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      subject: true,
      status: true,
      decided_at: true,
      decision_note: true,
      vendor: true,
      amount_cents: true,
      decided_by: true,
    },
  });
  if (!req) throw new ApRequestNotFoundError(requestId);

  const recipients = (
    await prisma.apDecisionRecipient.findMany({ where: { active: true }, select: { email: true } })
  ).map((r) => r.email);

  if (recipients.length === 0) {
    log.error({ requestId }, '[ap-approvals] decision-recipient list is EMPTY — refusing to send, paging operator');
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'AP decision email NOT sent — no recipients configured',
      body: `AP request ${requestId} was decided (${req.status}) but the decision-recipient list is empty, so no email was sent to accounting. Configure ap_decision_recipients (Mary's address) then re-send from the AP queue.`,
      priority: 'high',
      tags: ['error', 'ap', 'config', 'dr3-vision'],
      clickUrl: `${baseUrl()}/dashboard/ops/ap`,
      fingerprint: 'ap-decision-recipients-empty',
      cooldownMs: 6 * 60 * 60 * 1000,
    }).catch(() => undefined);
    return 'refused_no_recipients';
  }

  const approverName = await resolveName(prisma, req.decided_by);
  const subject = req.subject ?? '(no subject)';
  const decidedISO = req.decided_at ? req.decided_at.toISOString() : new Date().toISOString();
  const amountLine =
    typeof req.amount_cents === 'number'
      ? `<li>Amount: $${(req.amount_cents / 100).toFixed(2)}</li>`
      : '';
  const vendorLine = req.vendor ? `<li>Vendor: ${escapeHtml(req.vendor)}</li>` : '';
  const noteLine = req.decision_note ? `<li>Note: ${escapeHtml(req.decision_note)}</li>` : '';
  const htmlBody = `<p>A vendor-invoice approval decision has been recorded in DR3-Vision.</p>
    <ul>
      <li>Decision: <b>${escapeHtml(req.status.toUpperCase())}</b></li>
      <li>Original subject: ${escapeHtml(subject)}</li>
      <li>Request id: ${escapeHtml(req.id)}</li>
      <li>Approver: ${escapeHtml(approverName)}</li>
      <li>Decided at: ${escapeHtml(decidedISO)}</li>
      ${vendorLine}
      ${amountLine}
      ${noteLine}
    </ul>
    <p>Request id + original subject are the Great Plains matching keys.</p>`;

  // ADR-0047 — the AP module is org-wide + born pilot; the actual delivery
  // routes through the rollout gate (in pilot it reroutes to admins). The
  // empty-recipient REFUSE above still guards the LIVE roster (Mary's GP filing)
  // so a config gap pages before ramp — the gate does not mask it.
  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients,
    subject: `DR3-Vision AP decision (${req.status}) — ${subject}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    db: prisma,
  });

  if (notified.disabled) return 'disabled'; // M365 not configured — fail-open no-op
  if (notified.delivered === 0) {
    log.warn({ requestId }, '[ap-approvals] decision email failed to all recipients');
    return 'failed';
  }
  await prisma.apRequest.update({ where: { id: requestId }, data: { decision_mail_sent_at: new Date() } });
  return 'sent';
}
