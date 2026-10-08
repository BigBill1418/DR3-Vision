// ADR-0141 — an invoice the team received directly.
//
// A manager (at their own site) or an admin submits the invoice in Vision and
// names ONE accountant from the admin-managed list. The submission becomes an
// ordinary `ap_requests` row (D1) so every approver control applies unchanged:
// the same queue, the structured Approve, the duplicate guard (ADR-0136), the
// $1,000 second signature through the shared resolver (ADR-0066). The accountant
// is the RECIPIENT of the decision mail, not an approver (Bill, 2026-10-08).
//
// Bill also decided (2026-10-08) that the submitter MAY approve or hold their own
// invoice like any other; there is deliberately no submitter exclusion here. Every
// existing rule on the decide path (including the second-signature rules) is
// untouched. ADR-0141 D5 records the accepted risk.

import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, UserRole } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { writeAudit } from '@/lib/audit';
import { putApAttachment } from '@/lib/r2';
import { isUiSurfaceLive, UI_SURFACE } from '@/lib/notify/rollout';
import type { NormFileAttachment } from '@/lib/msgraph-mail';
import { extractFromRequest } from './extraction/pipeline';
import { notifyNewRequest } from './notify';
import { apApproverEmails } from './approvers';
import { sendDecisionEmail, sendHoldNotice, type ApMailOutcome } from './approvals';

/** A phone photo or a scanned PDF, with room to spare (the reimbursement limit). */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES = 5;
export const ACCEPTED_TYPES: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
];
const MAX_TEXT = 200;
const MAX_PURPOSE = 2000;

// ── Who may submit (Bill, 2026-10-08) ────────────────────────────────────────

export type TeamSubmitAccess = 'ok' | 'forbidden_role' | 'forbidden_site' | 'pilot';

export interface SubmitViewer {
  role: UserRole;
  primarySiteId: string | null;
}

/**
 * Managers for THEIR OWN site only (an all-sites manager is still a manager of
 * one site here), admins for any site. While `ui/ap_team_submit` is `pilot` for
 * the site, only admins pass (ADR-0047). The same function gates the page, the
 * dashboard tile and the API, so they cannot disagree.
 */
export async function teamSubmitAccess(
  viewer: SubmitViewer,
  siteId: string,
  isLive: (code: string, siteId: string) => Promise<boolean> = isUiSurfaceLive,
): Promise<TeamSubmitAccess> {
  if (viewer.role === 'admin') return 'ok';
  if (viewer.role !== 'manager') return 'forbidden_role';
  if (viewer.primarySiteId !== siteId) return 'forbidden_site';
  return (await isLive(UI_SURFACE.AP_TEAM_SUBMIT, siteId)) ? 'ok' : 'pilot';
}

// ── Submission ───────────────────────────────────────────────────────────────

export class TeamSubmitError extends Error {
  constructor(
    readonly code:
      | 'vendor_required'
      | 'invoice_number_required'
      | 'invalid_amount'
      | 'purpose_required'
      | 'accountant_required'
      | 'accountant_inactive'
      | 'file_required'
      | 'too_many_files'
      | 'file_too_large'
      | 'file_type'
      | 'storage_unavailable',
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'TeamSubmitError';
  }
}

export interface TeamSubmitFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface TeamSubmitInput {
  prisma?: PrismaClient;
  submitter: { userId: string; email: string | null };
  /** From the session (manager) or the admin's pick — never a request-body site id. */
  siteId: string;
  accountantId: string;
  vendor: string;
  invoiceNumber: string;
  amountCents: number;
  purpose: string;
  files: readonly TeamSubmitFile[];
  now?: Date;
}

export interface TeamSubmitDeps {
  put?: typeof putApAttachment;
  extract?: typeof extractFromRequest;
  notifyNew?: typeof notifyNewRequest;
  approverEmails?: (prisma: PrismaClient) => Promise<string[]>;
}

/** Parse "1,240.50", "$40", "40.00" to cents; null when not a positive amount. */
export function parseAmountCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** The subject carries the invoice number, so ADR-0136's `extractInvoiceNumber` finds it. */
export function composeTeamSubject(invoiceNumber: string, vendor: string): string {
  return `Invoice #: ${invoiceNumber} — ${vendor} (team submission)`.slice(0, 300);
}

function validate(input: TeamSubmitInput): void {
  if (!input.vendor.trim()) throw new TeamSubmitError('vendor_required', 'Enter the vendor.');
  if (!input.invoiceNumber.trim()) {
    throw new TeamSubmitError('invoice_number_required', 'Enter the invoice number.');
  }
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new TeamSubmitError('invalid_amount', 'Enter the invoice amount, for example 1,240.50.');
  }
  if (!input.purpose.trim()) {
    throw new TeamSubmitError('purpose_required', 'Say what this invoice is for.');
  }
  if (!input.accountantId) {
    throw new TeamSubmitError('accountant_required', 'Choose the accounting staff member.');
  }
  if (input.files.length === 0) {
    throw new TeamSubmitError('file_required', 'Attach the invoice (a PDF or a photo).');
  }
  if (input.files.length > MAX_FILES) {
    throw new TeamSubmitError('too_many_files', `Attach at most ${MAX_FILES} files.`);
  }
  for (const f of input.files) {
    if (f.bytes.byteLength === 0) {
      throw new TeamSubmitError('file_required', 'One of the files is empty.');
    }
    if (f.bytes.byteLength > MAX_FILE_BYTES) {
      throw new TeamSubmitError('file_too_large', 'Each file must be 15 MB or less.', 413);
    }
    if (!ACCEPTED_TYPES.includes(f.contentType.toLowerCase())) {
      throw new TeamSubmitError('file_type', 'Attach a PDF or a photo (JPEG, PNG, HEIC, WebP).');
    }
  }
}

export interface TeamSubmitResult {
  requestId: string;
  accountantEmail: string;
}

export async function submitTeamInvoice(
  input: TeamSubmitInput,
  deps: TeamSubmitDeps = {},
): Promise<TeamSubmitResult> {
  const prisma = input.prisma ?? defaultPrisma;
  const put = deps.put ?? putApAttachment;
  const extract = deps.extract ?? extractFromRequest;
  const notifyNew = deps.notifyNew ?? notifyNewRequest;
  const approverEmails = deps.approverEmails ?? apApproverEmails;
  validate(input);

  const accountant = await prisma.apAccountingContact.findUnique({
    where: { id: input.accountantId },
    select: { id: true, email: true, active: true },
  });
  if (!accountant) {
    throw new TeamSubmitError('accountant_required', 'Choose the accounting staff member.');
  }
  if (!accountant.active) {
    throw new TeamSubmitError(
      'accountant_inactive',
      'That accounting staff member is no longer on the list. Choose another.',
    );
  }

  const vendor = input.vendor.trim().slice(0, MAX_TEXT);
  const invoiceNumber = input.invoiceNumber.trim().slice(0, MAX_TEXT);
  const purpose = input.purpose.trim().slice(0, MAX_PURPOSE);
  const now = input.now ?? new Date();
  const requestId = randomUUID();

  // Store every file BEFORE the row exists, under the same R2 `ap/` layout the
  // mailbox intake uses. Unlike the mailbox (which cannot refuse a message), a
  // person is waiting: refuse outright rather than file a row whose invoice does
  // not exist.
  const stored: Array<NormFileAttachment & { storageKey: string; sha256: string }> = [];
  for (const f of input.files) {
    const attachmentId = randomUUID();
    const key = await put({
      requestId,
      attachmentId,
      filename: f.name || 'invoice',
      contentType: f.contentType,
      bytes: f.bytes,
    });
    if (!key) {
      throw new TeamSubmitError(
        'storage_unavailable',
        'Invoice storage is not available right now. Nothing was submitted. Try again.',
        503,
      );
    }
    stored.push({
      kind: 'file',
      id: attachmentId,
      name: f.name || 'invoice',
      contentType: f.contentType,
      size: f.bytes.byteLength,
      contentBytesBase64: Buffer.from(f.bytes).toString('base64'),
      storageKey: key,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    });
  }

  // Same extraction the mailbox intake runs; it never throws.
  const extraction = await extract({
    bodyText: purpose,
    bodyHtmlSanitized: null,
    attachments: stored,
  });

  const subject = composeTeamSubject(invoiceNumber, vendor);
  const senderAddress = (input.submitter.email ?? '').trim().toLowerCase();
  await prisma.apRequest.create({
    data: {
      id: requestId,
      status: 'pending',
      internet_message_id: `team-submit:${requestId}`,
      received_at: now,
      sender_address: senderAddress,
      sender_validated: true,
      subject,
      body_text: purpose,
      extraction: extraction as unknown as Prisma.InputJsonValue,
      intake_channel: 'team_submit',
      submitted_by: input.submitter.userId,
      submitted_site_id: input.siteId,
      submitted_at: now,
      outcome_recipient_id: accountant.id,
      outcome_recipient_email: accountant.email,
      submitted_vendor: vendor,
      submitted_invoice_number: invoiceNumber,
      submitted_amount_cents: input.amountCents,
    },
    select: { id: true },
  });
  for (const f of stored) {
    await prisma.apAttachment.create({
      data: {
        request_id: requestId,
        kind: 'file',
        filename: f.name,
        content_type: f.contentType,
        byte_size: f.size,
        storage_key: f.storageKey,
        sha256: f.sha256,
      },
    });
  }

  // D7 — the submission and the accountant choice, in one append-only row. No
  // vendor or amount in the audit payload (the row itself carries those).
  await writeAudit({
    actor_user_id: input.submitter.userId,
    action: 'insert',
    table_name: 'ap_requests',
    row_id: requestId,
    after: {
      status: 'pending',
      intake_channel: 'team_submit',
      submitted_site_id: input.siteId,
      outcome_recipient_id: accountant.id,
      outcome_recipient_email: accountant.email,
      attachment_count: stored.length,
      attachment_sha256: stored.map((f) => f.sha256),
    },
  });

  // The approvers hear about it exactly as they do for a mailbox invoice (ap_notify).
  await notifyNew({
    requestId,
    subject,
    senderAddress,
    receivedAt: now,
    attachmentCount: stored.length,
    approverEmails: await approverEmails(prisma),
  }).catch(() => undefined);

  return { requestId, accountantEmail: accountant.email };
}

// ── Admin correction (Bill, 2026-10-08: fixed at submit; an admin may correct) ──

export class TeamCorrectionError extends Error {
  constructor(
    readonly code: 'not_found' | 'not_team_submission' | 'accountant_invalid' | 'unchanged',
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TeamCorrectionError';
  }
}

export interface CorrectionResult {
  requestId: string;
  accountantEmail: string;
  /** The mail re-sent to the corrected recipient, or null when nothing is due yet. */
  resent: { kind: 'decision' | 'hold'; mail: ApMailOutcome } | null;
}

/**
 * Re-point a team submission at a different accountant, audit it, and re-send
 * whatever mail that accountant should already have: the decision mail for a
 * decided request, the hold notice for one on hold. A pending request needs no
 * mail; the corrected address is used when it is decided.
 */
export async function correctTeamAccountant(args: {
  prisma?: PrismaClient;
  requestId: string;
  accountantId: string;
  actorUserId: string;
}): Promise<CorrectionResult> {
  const prisma = args.prisma ?? defaultPrisma;
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      status: true,
      intake_channel: true,
      outcome_recipient_id: true,
      outcome_recipient_email: true,
    },
  });
  if (!row) throw new TeamCorrectionError('not_found', 'Request not found.', 404);
  if (row.intake_channel !== 'team_submit') {
    throw new TeamCorrectionError(
      'not_team_submission',
      'Only a team submission has an accountant to correct.',
      409,
    );
  }
  const next = await prisma.apAccountingContact.findUnique({
    where: { id: args.accountantId },
    select: { id: true, email: true, active: true },
  });
  if (!next || !next.active) {
    throw new TeamCorrectionError(
      'accountant_invalid',
      'Choose an active accounting staff member.',
      400,
    );
  }
  if (next.id === row.outcome_recipient_id) {
    throw new TeamCorrectionError('unchanged', 'That accountant is already the recipient.', 409);
  }
  await prisma.apRequest.update({
    where: { id: args.requestId },
    data: { outcome_recipient_id: next.id, outcome_recipient_email: next.email },
  });
  await writeAudit({
    actor_user_id: args.actorUserId,
    action: 'update',
    table_name: 'ap_requests',
    row_id: args.requestId,
    before: {
      outcome_recipient_id: row.outcome_recipient_id,
      outcome_recipient_email: row.outcome_recipient_email,
    },
    after: {
      attempted: 'correct_team_accountant',
      outcome_recipient_id: next.id,
      outcome_recipient_email: next.email,
      status: row.status,
    },
  });

  let resent: CorrectionResult['resent'] = null;
  if (row.status === 'approved' || row.status === 'rejected') {
    resent = { kind: 'decision', mail: await sendDecisionEmail(prisma, args.requestId) };
  } else if (row.status === 'pending_review') {
    resent = { kind: 'hold', mail: await sendHoldNotice(prisma, args.requestId) };
  }
  if (resent) {
    await writeAudit({
      actor_user_id: args.actorUserId,
      action: 'update',
      table_name: 'ap_requests',
      row_id: args.requestId,
      after: { attempted: `resend_${resent.kind}_after_correction`, mail: resent.mail },
    });
  }
  return { requestId: args.requestId, accountantEmail: next.email, resent };
}
