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
import { isInternal, internalDomain } from './senders';
import { stampApproval, type PdfRenderer, type StampInput } from './stamp';

const TABLE = 'ap_requests';

// ADR-0046 §3 amendment — the approver set is now the expiry-aware ap_approvers
// ROSTER (approvers.ts), NOT the old all_sites reach set. Re-exported here so
// poll.ts keeps importing `apApproverEmails` from `./approvals` unchanged.
export { apApproverEmails } from './approvers';

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
  /** ADR-0046 §3 amendment — optional site tag (RESOLVED site id) set at decision. */
  siteId?: string;
  /** Test seam — inject a deterministic PDF renderer so unit tests never launch Chromium. */
  renderer?: PdfRenderer;
}

/** Thrown when a decide request carries a site id/code that does not exist. */
export class ApInvalidSiteError extends Error {
  readonly status = 400 as const;
  constructor(readonly given: string) {
    super(`unknown site '${given}'`);
    this.name = 'ApInvalidSiteError';
  }
}

/**
 * Resolve an optional site input (a real site id OR an 'eugene'/'woodland' code)
 * to a site id. Returns null for empty/absent input; throws ApInvalidSiteError
 * when a non-empty input matches no site.
 */
export async function resolveDecisionSiteId(
  prisma: PrismaClient,
  input: string | undefined | null,
): Promise<string | null> {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  const site = await prisma.site.findFirst({
    where: { OR: [{ id: trimmed }, { code: trimmed.toLowerCase() }] },
    select: { id: true },
  });
  if (!site) throw new ApInvalidSiteError(trimmed);
  return site.id;
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
      ...(args.siteId ? { site_id: args.siteId } : {}),
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
      has_site: !!args.siteId,
    },
  });

  const mail = await sendDecisionEmail(prisma, args.requestId, args.renderer);
  return { requestId: args.requestId, decision: args.decision, mail };
}

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Mail the decision back to the ORIGINAL internal forwarder (ADR-0046 §3
 * amendment): the intake message's `sender_address` (already validated @svdp.us
 * at intake per D2 — we do NOT relax that gate). The fixed ap_decision_recipients
 * roster (Mary's GP filing) rides along as CC, and is the FALLBACK recipient when
 * `sender_address` is somehow empty/non-internal. Carries request id, original
 * subject, decision, approver, timestamp, optional note — sufficient for GP
 * matching under any input shape (C10.5) — plus a visible-stamped decision PDF
 * (§1.6e). With genuinely no valid recipient it REFUSES and pages (the decision
 * stands; configuring recipients + re-send is the documented operator action).
 */
export async function sendDecisionEmail(
  prisma: PrismaClient,
  requestId: string,
  renderer?: PdfRenderer,
): Promise<ApMailOutcome> {
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
      sender_address: true,
      body_html_sanitized: true,
      body_text: true,
    },
  });
  if (!req) throw new ApRequestNotFoundError(requestId);

  const roster = (
    await prisma.apDecisionRecipient.findMany({ where: { active: true }, select: { email: true } })
  ).map((r) => r.email);

  // Primary recipient = the original internal forwarder (sender_address, @svdp.us).
  // Roster = CC (additional) when the forwarder is valid; roster = fallback
  // recipient when the forwarder is empty/non-internal.
  const forwarder = (req.sender_address ?? '').trim();
  const forwarderInternal = !!forwarder && isInternal(forwarder, internalDomain());
  const recipients = forwarderInternal ? [forwarder] : roster;
  const cc = forwarderInternal ? roster.filter((e) => e.toLowerCase() !== forwarder.toLowerCase()) : [];

  if (recipients.length === 0) {
    log.error({ requestId }, '[ap-approvals] no valid decision recipient (forwarder + roster empty) — refusing to send, paging operator');
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'AP decision email NOT sent — no recipients configured',
      body: `AP request ${requestId} was decided (${req.status}) but there is no valid recipient (the original forwarder address is missing and the ap_decision_recipients roster is empty), so no email was sent to accounting. Configure ap_decision_recipients (Mary's address) then re-send from the AP queue.`,
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
  const decidedAt = req.decided_at ?? new Date();
  const decidedISO = decidedAt.toISOString();
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

  // §1.6e — visible-stamped decision PDF. BODY-only originals re-render the
  // (re-)sanitized body; file/PDF attachments get a stamped COVER page (we can't
  // overlay existing PDF vector bytes without a PDF lib — documented deviation).
  // Fail-soft: a render failure must NOT block the decision mail to accounting.
  const stamped = await buildDecisionStamp(prisma, req, approverName, decidedAt, renderer).catch((e) => {
    log.warn({ requestId, err: e instanceof Error ? e.message : String(e) }, '[ap-approvals] decision-PDF stamp failed (mail proceeds without attachment)');
    return null;
  });
  if (stamped) {
    await prisma.apRequest.update({ where: { id: requestId }, data: { decision_pdf_sha256: stamped.sha256 } });
    await writeAudit({
      actor_user_id: req.decided_by,
      action: 'update',
      table_name: TABLE,
      row_id: requestId,
      after: { decision_pdf_sha256: stamped.sha256, stamped_kind: stamped.kind },
    });
  }

  // ADR-0047 — the AP module is org-wide + born pilot; the actual delivery
  // routes through the rollout gate (in pilot it reroutes to admins). The
  // empty-recipient REFUSE above still guards the LIVE roster (Mary's GP filing)
  // so a config gap pages before ramp — the gate does not mask it.
  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients,
    ...(cc.length > 0 ? { cc } : {}),
    subject: `DR3-Vision AP decision (${req.status}) — ${subject}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    ...(stamped ? { attachments: [{ filename: `ap-decision-${req.id}.pdf`, buffer: stamped.pdf, contentType: 'application/pdf' }] } : {}),
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

interface StampSourceRequest {
  id: string;
  subject: string | null;
  status: string;
  body_html_sanitized: string | null;
  body_text: string | null;
  decided_by: string | null;
}

/**
 * Choose the stamp mode and render the decision PDF. Body present ⇒ 'body'
 * (re-render the sanitized body). No body but a file attachment ⇒ 'attachment'
 * (stamped cover page). No body and no file ⇒ 'body' with an empty original.
 */
async function buildDecisionStamp(
  prisma: PrismaClient,
  req: StampSourceRequest,
  approverName: string,
  decidedAt: Date,
  renderer?: PdfRenderer,
): Promise<{ pdf: Buffer; sha256: string; kind: StampInput['kind'] }> {
  const decision: ApDecision = req.status === 'approved' ? 'approved' : 'rejected';
  const base = {
    requestId: req.id,
    subject: req.subject ?? '(no subject)',
    approverName,
    decision,
    decidedAt,
  };
  let input: StampInput;
  if (req.body_html_sanitized && req.body_html_sanitized.trim()) {
    input = { ...base, kind: 'body', bodyHtmlSanitized: req.body_html_sanitized };
  } else {
    const files = await prisma.apAttachment.findMany({
      where: { request_id: req.id },
      select: { kind: true, filename: true },
    });
    const file = files.find((a: { kind: string }) => a.kind === 'file');
    input = file
      ? { ...base, kind: 'attachment', originalFilename: (file as { filename: string | null }).filename }
      : { ...base, kind: 'body', bodyHtmlSanitized: req.body_text ?? '' };
  }
  const { pdf, sha256 } = await stampApproval(input, renderer);
  return { pdf, sha256, kind: input.kind };
}
