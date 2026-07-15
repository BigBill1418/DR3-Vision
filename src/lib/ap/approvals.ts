// ADR-0046 D4 — approval + return path.
//
// Decisions require an authenticated Vision session over the stored record (email
// can only CREATE requests, D6). First action wins, ATOMICALLY: a conditional
// updateMany({where:{id,status:'pending'}}) — the winner flips the row, the loser
// gets a count of 0 and "already decided by {actor} at {time}". BOTH attempts are
// audited (ADR-0028/0041 machinery). The decision email goes to a FIXED configured
// recipient list (ap_decision_recipients) — NEVER the inbound Reply-To (C3.3);
// with zero active recipients the send REFUSES and pages (never silent).

import { createHash } from 'node:crypto';
import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';
import { formatPacificDateTime } from '@/lib/time';
import { getApAttachmentBytes, putApDecisionPdf } from '@/lib/r2';
import { isInternal, internalDomain } from './senders';
import {
  stampApproval,
  stampImage,
  stampOntoOriginalPdf,
  type PdfRenderer,
  type StampInput,
  type StampResult,
} from './stamp';

const TABLE = 'ap_requests';

// ADR-0046 §3 amendment — the approver set is now the expiry-aware ap_approvers
// ROSTER (approvers.ts), NOT the old all_sites reach set. Re-exported here so
// poll.ts keeps importing `apApproverEmails` from `./approvals` unchanged.
export { apApproverEmails } from './approvers';

export type ApDecision = 'approved' | 'rejected';

/**
 * The statuses from which a request can still be approved/rejected: an untouched
 * `pending` request OR one an approver has placed on hold (`pending_review`).
 * ADR-0046 Amendment 3.
 */
const ACTIONABLE_STATUSES = ['pending', 'pending_review'] as const;

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
    super(`AP request is ${currentStatus}; only a pending or on-hold request can be actioned`);
    this.name = 'ApNotActionableError';
  }
}

/**
 * ADR-0046 Amendment 3 — a rejection MUST carry a note explaining why (plain-English
 * validation, enforced at the API boundary; approvals stay note-optional). Also
 * thrown for a hold / hold-note-update with no note. Kept out of `decideRequest`
 * itself so the pure lib race-tests can reject without a note.
 */
export class ApNoteRequiredError extends Error {
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = 'ApNoteRequiredError';
  }
}

/** True when a non-empty note is present. */
function hasNote(note: string | undefined | null): note is string {
  return typeof note === 'string' && note.trim().length > 0;
}

/**
 * Enforce "a rejection must say why" at the decision boundary. Approvals are
 * note-optional. Throws {@link ApNoteRequiredError} for a rejection with no note.
 */
export function assertDecisionNote(decision: ApDecision, note: string | undefined | null): void {
  if (decision === 'rejected' && !hasNote(note)) {
    throw new ApNoteRequiredError(
      'A rejection must include a note explaining why the invoice was rejected.',
    );
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
      // Pacific, never raw UTC — this message surfaces in the queue UI banner.
      `already ${decision} by ${decidedByName}${decidedAt ? ` at ${formatPacificDateTime(decidedAt)} PT` : ''}`,
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
  /** REQUIRED (operator directive 2026-07-15; was optional under the §3
   * amendment) — the RESOLVED site id the decision files against. */
  siteId?: string;
  /** Test seam — inject a deterministic PDF renderer so unit tests never launch Chromium. */
  renderer?: PdfRenderer;
}

/** Operator directive 2026-07-15 — a decision without a site tag is refused. */
export class ApSiteRequiredError extends Error {
  readonly status = 400 as const;
  constructor() {
    super(
      'Select the site (Woodland or Eugene) before deciding — accounting files every invoice against a site.',
    );
    this.name = 'ApSiteRequiredError';
  }
}

/**
 * Enforce the REQUIRED decision-time site tag (operator directive 2026-07-15;
 * was optional under the §3 amendment). Mary always needs the site for GP —
 * an untagged decision must never reach accounting.
 */
export function assertDecisionSite(siteId: string | null | undefined): asserts siteId is string {
  if (!siteId || !siteId.trim()) throw new ApSiteRequiredError();
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
  // Operator directive 2026-07-15: no decision without a site tag — validated
  // BEFORE any read/state change (mirrors the reject-note boundary).
  assertDecisionSite(args.siteId);
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: { id: true, status: true, subject: true, decided_by: true, decided_at: true },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  if (row.status === 'quarantined') throw new ApNotActionableError('quarantined');

  const priorStatus = row.status;
  const decidedAt = new Date();
  // Atomic conditional transition — only flips a row still in an actionable state
  // (pending OR on-hold pending_review). First action wins; a row already decided
  // (or racing) matches nothing → count 0 → ApAlreadyDecidedError below.
  const res = await prisma.apRequest.updateMany({
    where: { id: args.requestId, status: { in: [...ACTIONABLE_STATUSES] } },
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
      after: {
        attempted: args.decision,
        outcome: 'lost',
        winner_status: winner?.status ?? 'unknown',
      },
    });
    const name = await resolveName(prisma, winner?.decided_by ?? row.decided_by);
    throw new ApAlreadyDecidedError(
      winner?.status ?? row.status,
      name,
      winner?.decided_at ?? row.decided_at,
    );
  }

  // Won. Audit the winning transition (both-attempts-audited: this is the winner's row).
  await writeAudit({
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: args.requestId,
    before: { status: priorStatus },
    after: {
      attempted: args.decision,
      outcome: 'won',
      status: args.decision,
      from_hold: priorStatus === 'pending_review',
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
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve the recipient set for a request-scoped email (decision OR hold notice):
 * PRIMARY = the original internal forwarder (`sender_address`, @svdp.us, validated
 * at intake); the fixed `ap_decision_recipients` roster (Mary's GP filing) rides as
 * CC when the forwarder is valid, or is the FALLBACK recipient when the forwarder
 * is somehow empty/non-internal. ADR-0046 §3 amendment / Amendment 3.
 */
async function resolveForwarderRecipients(
  prisma: PrismaClient,
  senderAddress: string | null,
): Promise<{ recipients: string[]; cc: string[] }> {
  const roster = (
    await prisma.apDecisionRecipient.findMany({ where: { active: true }, select: { email: true } })
  ).map((r) => r.email);
  const forwarder = (senderAddress ?? '').trim();
  const forwarderInternal = !!forwarder && isInternal(forwarder, internalDomain());
  const recipients = forwarderInternal ? [forwarder] : roster;
  const cc = forwarderInternal
    ? roster.filter((e) => e.toLowerCase() !== forwarder.toLowerCase())
    : [];
  return { recipients, cc };
}

export interface HoldArgs {
  prisma?: PrismaClient;
  requestId: string;
  actorUserId: string;
  /** REQUIRED — a hold must say why it is being held (Amendment 3). */
  note: string;
}

export interface HoldResult {
  requestId: string;
  status: 'pending_review';
  /** Outcome of the "it is being held" notice to the original forwarder. */
  mail: ApMailOutcome;
}

/**
 * Place a PENDING request on HOLD ("pending review", Amendment 3). Atomic +
 * first-action-wins: only a still-`pending` row flips; a row already decided,
 * quarantined, or already on hold loses (ApAlreadyDecidedError, both attempts
 * audited). Accounting is notified via a hold-notice email to the original
 * forwarder (fail-soft). Requires a non-empty hold note.
 */
export async function holdRequest(args: HoldArgs): Promise<HoldResult> {
  const prisma = args.prisma ?? defaultPrisma;
  if (!hasNote(args.note)) {
    throw new ApNoteRequiredError(
      'A hold must include a note explaining why the invoice is being held.',
    );
  }
  const note = args.note.trim();
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      status: true,
      decided_by: true,
      decided_at: true,
      held_by: true,
      held_at: true,
    },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  if (row.status === 'quarantined') throw new ApNotActionableError('quarantined');

  const heldAt = new Date();
  // Hold is placed ONLY from pending (you don't re-hold an on-hold row — you update
  // its note; see updateHoldNote). Atomic conditional transition.
  const res = await prisma.apRequest.updateMany({
    where: { id: args.requestId, status: 'pending' },
    data: { status: 'pending_review', held_by: args.actorUserId, held_at: heldAt, hold_note: note },
  });

  if (res.count === 0) {
    const cur = await prisma.apRequest.findUnique({
      where: { id: args.requestId },
      select: { status: true, decided_by: true, decided_at: true, held_by: true, held_at: true },
    });
    await writeAudit({
      actor_user_id: args.actorUserId,
      action: 'update',
      table_name: TABLE,
      row_id: args.requestId,
      after: { attempted: 'hold', outcome: 'lost', current_status: cur?.status ?? 'unknown' },
    });
    // Attribute the conflicting state: a held row → its holder; a decided row → its decider.
    const heldNow = cur?.status === 'pending_review';
    const whoId = heldNow ? (cur?.held_by ?? row.held_by) : (cur?.decided_by ?? row.decided_by);
    const whenAt = heldNow ? (cur?.held_at ?? row.held_at) : (cur?.decided_at ?? row.decided_at);
    const name = await resolveName(prisma, whoId ?? null);
    throw new ApAlreadyDecidedError(cur?.status ?? row.status, name, whenAt ?? null);
  }

  await writeAudit({
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: args.requestId,
    before: { status: 'pending' },
    after: { attempted: 'hold', outcome: 'won', status: 'pending_review', has_note: true },
  });

  const mail = await sendHoldNotice(prisma, args.requestId);
  return { requestId: args.requestId, status: 'pending_review', mail };
}

/**
 * Update the hold note on an on-hold (`pending_review`) request (Amendment 3). Any
 * approver may refine the note while it is held; the holder (held_by/held_at) is
 * unchanged, and the edit is audited with the editor as actor. Requires a non-empty
 * note. Throws ApNotActionableError if the request is not currently on hold.
 */
export async function updateHoldNote(args: HoldArgs): Promise<void> {
  const prisma = args.prisma ?? defaultPrisma;
  if (!hasNote(args.note)) {
    throw new ApNoteRequiredError('A hold note cannot be empty.');
  }
  const note = args.note.trim();
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: { id: true, status: true, hold_note: true },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  if (row.status !== 'pending_review') throw new ApNotActionableError(row.status);

  // Guard the status in the write too, so a concurrent decide can't be clobbered.
  const res = await prisma.apRequest.updateMany({
    where: { id: args.requestId, status: 'pending_review' },
    data: { hold_note: note },
  });
  if (res.count === 0) {
    const cur = await prisma.apRequest.findUnique({
      where: { id: args.requestId },
      select: { status: true },
    });
    throw new ApNotActionableError(cur?.status ?? 'unknown');
  }
  await writeAudit({
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: TABLE,
    row_id: args.requestId,
    before: { hold_note_present: hasNote(row.hold_note) },
    after: { hold_note_updated: true },
  });
}

/**
 * Notify accounting (the original forwarder) that a request is being HELD for
 * review (Amendment 3, effect (a)). States who holds it, the hold note, and that a
 * final decision will follow. Routes through notifyStaff('ap_notify') (in pilot it
 * reroutes to admins — correct). Fail-soft: a mail failure never fails the hold.
 * Unlike the decision mail this does NOT page on an empty recipient set (a hold is
 * non-terminal; a warn is logged) — the terminal decision mail still guards Mary's
 * roster loudly.
 */
export async function sendHoldNotice(
  prisma: PrismaClient,
  requestId: string,
): Promise<ApMailOutcome> {
  const req = await prisma.apRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      subject: true,
      sender_address: true,
      held_by: true,
      held_at: true,
      hold_note: true,
    },
  });
  if (!req) throw new ApRequestNotFoundError(requestId);

  const { recipients, cc } = await resolveForwarderRecipients(prisma, req.sender_address);
  if (recipients.length === 0) {
    log.warn(
      { requestId },
      '[ap-approvals] hold notice not sent — no valid recipient (forwarder + roster empty)',
    );
    return 'refused_no_recipients';
  }

  const holderName = await resolveName(prisma, req.held_by);
  const subject = req.subject ?? '(no subject)';
  const heldAt = req.held_at ?? new Date();
  const noteLine = req.hold_note ? `<li>Hold note: ${escapeHtml(req.hold_note)}</li>` : '';
  // ADR-0046 Amendment 4 — GP matching keys (request id + original subject) are
  // stripped from the body; the subject line already carries the original subject.
  const htmlBody = `<p>A vendor-invoice approval request is now <b>ON HOLD (pending review)</b> in DR3-Vision. It has not yet been approved or rejected — a final decision will follow.</p>
    <ul>
      <li>Held by: ${escapeHtml(holderName)}</li>
      <li>Held at: ${escapeHtml(formatPacificDateTime(heldAt))} PT</li>
      ${noteLine}
    </ul>
    <p>No action is needed from you right now; you will receive a decision email once the invoice is approved or rejected.</p>`;

  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients,
    ...(cc.length > 0 ? { cc } : {}),
    subject: `DR3-Vision AP — request ON HOLD (pending review): ${subject}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    db: prisma,
  });
  if (notified.disabled) return 'disabled';
  if (notified.delivered === 0) {
    log.warn({ requestId }, '[ap-approvals] hold notice failed to all recipients');
    return 'failed';
  }
  return 'sent';
}

/**
 * Mail the decision back to the ORIGINAL internal forwarder (ADR-0046 §3
 * amendment): the intake message's `sender_address` (already validated @svdp.us
 * at intake per D2 — we do NOT relax that gate). The fixed ap_decision_recipients
 * roster (Mary's GP filing) rides along as CC, and is the FALLBACK recipient when
 * `sender_address` is somehow empty/non-internal. The mail body carries the
 * human-facing decision facts (decision, approver, timestamp, optional note); the
 * GP matching keys (request id + original subject) ride the SUBJECT line and the
 * stamped decision PDF, NOT the body (ADR-0046 Amendment 4). Plus the stamped
 * original attachment (§1.6e). With genuinely no valid recipient it REFUSES and
 * pages (the decision stands; configuring recipients + re-send is the operator action).
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
      // Operator directive 2026-07-15: the site tag the approver selected must
      // be unmissable on everything accounting receives. site_id is a bare
      // column (AP block convention: DB-level FK, no Prisma relation) — the
      // name resolves with an explicit lookup below.
      site_id: true,
    },
  });
  if (!req) throw new ApRequestNotFoundError(requestId);
  const siteName = req.site_id
    ? ((await prisma.site.findUnique({ where: { id: req.site_id }, select: { name: true } }))
        ?.name ?? null)
    : null;

  const { recipients, cc } = await resolveForwarderRecipients(prisma, req.sender_address);

  if (recipients.length === 0) {
    log.error(
      { requestId },
      '[ap-approvals] no valid decision recipient (forwarder + roster empty) — refusing to send, paging operator',
    );
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
  // Bill + both facilities read Pacific; the fleet host clock is UTC. Render the
  // decision instant in Pacific wall-clock (+ ' PT') like every other AP surface
  // (notify.ts new-request "Received", stamp.ts stamp line, the hold-notice email).
  const decidedLabel = `${formatPacificDateTime(decidedAt)} PT`;
  const amountLine =
    typeof req.amount_cents === 'number'
      ? `<li>Amount: $${(req.amount_cents / 100).toFixed(2)}</li>`
      : '';
  const vendorLine = req.vendor ? `<li>Vendor: ${escapeHtml(req.vendor)}</li>` : '';
  const noteLine = req.decision_note ? `<li>Note: ${escapeHtml(req.decision_note)}</li>` : '';
  // ADR-0046 Amendment 4 — the Great Plains matching keys (request id + original
  // subject) are STRIPPED from the mail body. They already ride the SUBJECT line
  // (below) and the stamped decision PDF, so repeating them inline was redundant
  // clutter that made the body read like a machine record instead of a decision
  // notice. The body now carries only the human-facing decision facts.
  // 2026-07-15 operator directive: when the approver tagged a site, it leads
  // the decision facts — accounting must never guess which site's books.
  const siteLine = siteName ? `<li>Site: <b>${escapeHtml(siteName)}</b></li>` : '';
  const htmlBody = `<p>A vendor-invoice approval decision has been recorded in DR3-Vision.</p>
    <ul>
      <li>Decision: <b>${escapeHtml(req.status.toUpperCase())}</b></li>
      ${siteLine}
      <li>Approver: ${escapeHtml(approverName)}</li>
      <li>Decided at: ${escapeHtml(decidedLabel)}</li>
      ${vendorLine}
      ${amountLine}
      ${noteLine}
    </ul>`;

  // ADR-0046 Amendment 4 — stamp the ORIGINAL invoice (both decisions), attach the
  // stamped original(s), and archive them to R2. BODY-only originals re-render the
  // (re-)sanitized body; PDF/image attachments get a TRUE overlay (pdf-lib /
  // Playwright); an R2-unconfigured window degrades to the stamped cover page.
  // Fail-soft: a render/download/R2 failure must NEVER block the decision mail to
  // accounting (the decision itself already stands). Preserve the .catch(→null).
  const artifacts = await buildDecisionStamp(
    prisma,
    req,
    approverName,
    decidedAt,
    siteName,
    renderer,
  ).catch((e) => {
    log.warn(
      { requestId, err: e instanceof Error ? e.message : String(e) },
      '[ap-approvals] decision-PDF stamp failed (mail proceeds without attachment)',
    );
    return null;
  });
  if (artifacts && artifacts.length > 0) {
    // Archive each stamped PDF to R2 (fail-soft; a PUT miss never blocks the mail).
    // The single-value columns record the PRIMARY (first) artifact; the audit row
    // carries the full count for the rare multi-attachment invoice.
    let decisionPdfR2Key: string | null = null;
    let originalSha: string | null = null;
    for (const a of artifacts) {
      if (a.originalSha256 && !originalSha) originalSha = a.originalSha256;
      if (a.attachmentId) {
        const key = await putApDecisionPdf({
          requestId,
          attachmentId: a.attachmentId,
          bytes: a.pdf,
        }).catch(() => null);
        if (key && !decisionPdfR2Key) decisionPdfR2Key = key;
      }
    }
    const primary = artifacts[0]!;
    await prisma.apRequest.update({
      where: { id: requestId },
      data: {
        decision_pdf_sha256: primary.sha256,
        ...(originalSha ? { original_attachment_sha256: originalSha } : {}),
        ...(decisionPdfR2Key ? { decision_pdf_r2_key: decisionPdfR2Key } : {}),
      },
    });
    await writeAudit({
      actor_user_id: req.decided_by,
      action: 'update',
      table_name: TABLE,
      row_id: requestId,
      after: {
        decision_pdf_sha256: primary.sha256,
        stamped_kind: primary.kind,
        stamped_count: artifacts.length,
        original_attachment_sha256: originalSha,
        decision_pdf_r2_key: decisionPdfR2Key,
      },
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
    // Site rides the SUBJECT line too (2026-07-15 directive) — visible before
    // the mail is even opened, next to the GP matching key.
    subject:
      `DR3-Vision AP decision (${req.status}${siteName ? ` — ${siteName}` : ''}) — ${subject}`.slice(
        0,
        200,
      ),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    ...(artifacts && artifacts.length > 0
      ? {
          attachments: artifacts.map((a) => ({
            filename: a.filename,
            buffer: a.pdf,
            contentType: 'application/pdf',
          })),
        }
      : {}),
    db: prisma,
  });

  if (notified.disabled) return 'disabled'; // M365 not configured — fail-open no-op
  if (notified.delivered === 0) {
    log.warn({ requestId }, '[ap-approvals] decision email failed to all recipients');
    return 'failed';
  }
  await prisma.apRequest.update({
    where: { id: requestId },
    data: { decision_mail_sent_at: new Date() },
  });
  return 'sent';
}

interface StampSourceRequest {
  id: string;
  subject: string | null;
  status: string;
  body_html_sanitized: string | null;
  body_text: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

/** One stamped decision artifact to attach + archive (ADR-0046 Amendment 4). */
interface StampedArtifact {
  /** Email attachment filename (always a .pdf). */
  filename: string;
  pdf: Buffer;
  /** sha256 of the GENERATED stamped PDF — the tamper record. */
  sha256: string;
  /** sha256 of the ORIGINAL attachment bytes (file mode); null for body/cover. */
  originalSha256: string | null;
  /** Source ap_attachment id (drives the R2 archive key); null for body/cover. */
  attachmentId: string | null;
  kind: StampInput['kind'];
}

type StampBase = Pick<
  StampInput,
  'requestId' | 'subject' | 'approverName' | 'decision' | 'decidedAt' | 'note' | 'siteName'
>;

interface FileAttachmentRow {
  id: string;
  kind: string;
  filename: string | null;
  content_type: string | null;
  storage_key: string | null;
  byte_size: number | null;
}

/**
 * Inline-image heuristic (ADR-0046 post-amendment, 2026-07-15). Forwards drag in
 * signature/logo images (`image/*`, a few KB) that must not be stamped and mailed
 * as if they were the invoice. We have no exact inline signal yet — `normalizeFile`
 * (msgraph-mail/normalize.ts) drops Graph's `isInline`/`contentId`, so `ap_attachments`
 * carries no inline column. Ship-now proxy: exclude tiny images (`image/*` AND
 * byte_size < 50 KB); a scanned/photographed invoice is virtually always >200 KB,
 * logos/signatures <20 KB. PDFs and non-image files are ALWAYS kept regardless of size.
 * Durable follow-up: capture `isInline`+`contentId` into a new `ap_attachments.is_inline`
 * column and filter on that exactly (retiring this size heuristic) — see ADR-0046.
 */
const INLINE_IMAGE_MAX_BYTES = 50_000;
function isLikelyInlineImage(a: FileAttachmentRow): boolean {
  const ct = (a.content_type ?? '').toLowerCase();
  return ct.startsWith('image/') && a.byte_size != null && a.byte_size < INLINE_IMAGE_MAX_BYTES;
}

/**
 * The stampable document set: `kind='file'` rows with a `storage_key`, minus likely
 * inline images. Guard: if the inline filter would drop EVERY attachment, keep the
 * unfiltered files — a decision mail is never artifact-empty when real files exist.
 */
function selectStampableAttachments(files: FileAttachmentRow[]): FileAttachmentRow[] {
  const fileRows = files.filter((a) => a.kind === 'file' && a.storage_key);
  const kept = fileRows.filter((a) => !isLikelyInlineImage(a));
  return kept.length > 0 ? kept : fileRows;
}

/**
 * De-duplicate a stamped-attachment filename within one decision mail. Two source
 * files sharing a name (`invoice.pdf`) would otherwise collapse to one `approved-invoice.pdf`
 * MIME part and clobber each other; append `-<n>` before `.pdf` on collision.
 */
function dedupeFilename(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const stem = name.endsWith('.pdf') ? name.slice(0, -'.pdf'.length) : name;
  let n = 2;
  let candidate = `${stem}-${n}.pdf`;
  while (used.has(candidate)) candidate = `${stem}-${++n}.pdf`;
  used.add(candidate);
  return candidate;
}

/** A stable, filesystem-safe stamped-attachment filename (always `.pdf`). */
function stampedAttachmentName(
  decision: ApDecision,
  filename: string | null,
  attId: string,
): string {
  const stem =
    (filename ?? `attachment-${attId}`)
      .replace(/\.[^./\\]+$/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80) || `attachment-${attId}`;
  return `${decision}-${stem}.pdf`;
}

/**
 * Stamp ONE original file attachment. PDF → true pdf-lib overlay; image → HTML
 * embed + Playwright; any other type → stamped cover naming it. Returns null when
 * the ORIGINAL bytes are unavailable (R2 unconfigured / placeholder key), so the
 * caller degrades to the cover page. On an overlay error the attachment still
 * yields a stamped cover (naming it + its original sha) — one bad file never drops
 * the others, and the mail is never blocked.
 */
async function stampOneOriginal(
  base: StampBase,
  att: FileAttachmentRow,
  renderer?: PdfRenderer,
): Promise<StampedArtifact | null> {
  const bytes = await getApAttachmentBytes(att.storage_key!).catch(() => null);
  if (!bytes) return null;
  const originalSha256 = createHash('sha256').update(bytes).digest('hex');
  const input: StampInput = {
    ...base,
    kind: 'attachment',
    originalFilename: att.filename,
    originalSha256,
  };
  const ct = (att.content_type ?? '').toLowerCase();
  const name = stampedAttachmentName(base.decision, att.filename, att.id);
  let result: StampResult;
  try {
    if (ct === 'application/pdf') {
      result = await stampOntoOriginalPdf(bytes, input);
    } else if (/^image\/(png|jpeg|jpg|webp)$/.test(ct)) {
      result = await stampImage(input, bytes, ct, renderer);
    } else {
      result = await stampApproval(input, renderer); // odd type → cover naming it
    }
  } catch (e) {
    log.warn(
      { attId: att.id, err: e instanceof Error ? e.message : String(e) },
      '[ap-approvals] original overlay failed — falling back to a stamped cover page',
    );
    result = await stampApproval(input, renderer);
  }
  return {
    filename: name,
    pdf: result.pdf,
    sha256: result.sha256,
    originalSha256,
    attachmentId: att.id,
    kind: 'attachment',
  };
}

/**
 * Choose the stamp mode and render the decision artifact(s) (ADR-0046 Amendment 4,
 * attachment-first precedence 2026-07-15). The operator's directive is that the
 * decision mail returns the ACTUAL approved/rejected document — so REAL FILE
 * ATTACHMENTS WIN: stamp the stamp onto EACH original (multi-attachment) and return
 * those. Only when there is no usable file attachment does the sanitized body render
 * (one PDF) stand in — the body-only-invoice fallback. No usable original bytes (R2
 * unconfigured) ⇒ a stamped cover page (documented deviation). No body and no file ⇒
 * a stamped 'body' cover with an empty original.
 *
 * Live defect this reversal closes (2026-07-15 operator test, request c38909b2): a
 * forwarded invoice ALWAYS carries a body, so the old body-first order returned the
 * stamped body render and the pdf-lib overlay path never ran — accounting got a body
 * render instead of the actual Hertz invoice, and `original_attachment_sha256` stayed
 * NULL. The caller already records the first artifact's dual-sha + attaches every
 * artifact, so this reorder auto-populates the sha with zero caller changes.
 */
async function buildDecisionStamp(
  prisma: PrismaClient,
  req: StampSourceRequest,
  approverName: string,
  decidedAt: Date,
  siteName: string | null,
  renderer?: PdfRenderer,
): Promise<StampedArtifact[]> {
  const decision: ApDecision = req.status === 'approved' ? 'approved' : 'rejected';
  const base: StampBase = {
    requestId: req.id,
    subject: req.subject ?? '(no subject)',
    approverName,
    decision,
    decidedAt,
    // ADR-0046 Amendment 3 — the decision note rides on the stamped PDF too. Because
    // the note is stamped onto every attachment, dropping the body render (below)
    // when attachments exist loses no approver-relevant context.
    note: req.decision_note,
    // 2026-07-15 directive — the site tag rides the per-page stamp line.
    siteName,
  };

  // ATTACHMENT-FIRST (2026-07-15): stamp EACH real file attachment (both decisions)
  // and return those — the actual documents, not the forward wrapper. Docs-only: the
  // stamped body render does NOT ride along when attachments exist.
  const files = (await prisma.apAttachment.findMany({
    where: { request_id: req.id },
    select: {
      id: true,
      kind: true,
      filename: true,
      content_type: true,
      storage_key: true,
      byte_size: true,
    },
  })) as FileAttachmentRow[];
  const fileAtts = selectStampableAttachments(files);
  if (fileAtts.length > 0) {
    const artifacts: StampedArtifact[] = [];
    const usedNames = new Set<string>();
    for (const att of fileAtts) {
      const artifact = await stampOneOriginal(base, att, renderer);
      if (!artifact) continue;
      artifact.filename = dedupeFilename(artifact.filename, usedNames);
      artifacts.push(artifact);
    }
    if (artifacts.length > 0) return artifacts;
    // Every download failed (R2 unconfigured/placeholder) → fall through: body render
    // if this is a body-only invoice, else the stamped cover.
  }

  // No usable file attachment. Body-only invoice ⇒ re-render the sanitized body.
  if (req.body_html_sanitized && req.body_html_sanitized.trim()) {
    const input: StampInput = { ...base, kind: 'body', bodyHtmlSanitized: req.body_html_sanitized };
    const { pdf, sha256 } = await stampApproval(input, renderer);
    return [
      {
        filename: `ap-decision-${req.id}.pdf`,
        pdf,
        sha256,
        originalSha256: null,
        attachmentId: null,
        kind: 'body',
      },
    ];
  }

  // No body and no usable original bytes: keep the stamped cover page (documented
  // deviation for the R2-unconfigured window). Name a file attachment if one exists,
  // else empty.
  const coverFile = files.find((a) => a.kind === 'file');
  const input: StampInput = coverFile
    ? { ...base, kind: 'attachment', originalFilename: coverFile.filename }
    : { ...base, kind: 'body', bodyHtmlSanitized: req.body_text ?? '' };
  const { pdf, sha256 } = await stampApproval(input, renderer);
  return [
    {
      filename: `ap-decision-${req.id}.pdf`,
      pdf,
      sha256,
      originalSha256: null,
      attachmentId: null,
      kind: input.kind,
    },
  ];
}
