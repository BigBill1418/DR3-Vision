// ADR-0046 D3 — per-message ingest. Each polled message reaches EXACTLY ONE
// terminal state: created | followup | quarantined | duplicate. The pipeline
// never silently drops (C3): a bad sender or a parse failure becomes a
// quarantined request, not a skip.
//
// Idempotency is the internet_message_id UNIQUE key (a re-poll, a DB/move race,
// or a delta resync can never double-ingest). Attachments follow the full Graph
// taxonomy (C10.3): fileAttachment → R2 `ap/`; itemAttachment → one-level unwrap
// (subject + its files), deeper nesting kept as a visible marker; reference link
// recorded, NEVER fetched. Body HTML is sanitized at ingest (C10.2) — raw HTML is
// never stored.

import { Prisma, type PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { putApAttachment } from '@/lib/r2';
import { sanitizeEmailHtml } from './sanitize';
import { domainOf, validateSender, type QuarantineReason, type SenderPolicy } from './senders';
import { alertQuarantine, notifyNewRequest } from './notify';
import type { MailMessage, MailTransport, NormAttachment } from '@/lib/msgraph-mail';

export type IngestOutcomeKind = 'created' | 'followup' | 'quarantined' | 'duplicate';

export interface IngestOutcome {
  kind: IngestOutcomeKind;
  requestId?: string;
  reason?: QuarantineReason;
}

export type IngestLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: IngestLogger = () => undefined;

/** Notifier seam — production wires ntfy/mail; tests substitute spies. */
export interface IngestNotifier {
  quarantine(args: { requestId: string; senderDomain: string; reason: string }): Promise<void>;
  newRequest(args: { requestId: string; subject: string | null; approverEmails: readonly string[] }): Promise<void>;
}

const defaultNotifier: IngestNotifier = {
  quarantine: alertQuarantine,
  newRequest: notifyNewRequest,
};

export interface IngestContext {
  prisma: PrismaClient;
  transport: MailTransport;
  policy: SenderPolicy;
  /** Approver addresses for the new-request notification (resolved once per poll). */
  approverEmails: readonly string[];
  now?: () => Date;
  log?: IngestLogger;
  notifier?: IngestNotifier;
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

/** Has this message already been ingested (as a request OR a follow-up)? */
async function alreadySeen(prisma: PrismaClient, internetMessageId: string): Promise<boolean> {
  const [req, fu] = await Promise.all([
    prisma.apRequest.findUnique({ where: { internet_message_id: internetMessageId }, select: { id: true } }),
    prisma.apFollowup.findUnique({ where: { internet_message_id: internetMessageId }, select: { id: true } }),
  ]);
  return req !== null || fu !== null;
}

async function createQuarantine(
  ctx: IngestContext,
  msg: MailMessage,
  reason: QuarantineReason,
): Promise<IngestOutcome> {
  const notifier = ctx.notifier ?? defaultNotifier;
  // Quarantined items are admin-only + unapprovable. We store the sanitized body
  // for admin review but deliberately do NOT download attachments from an
  // untrusted/unprocessable message (reduced attack surface; admin can inspect
  // the mailbox). sender_validated=false marks the ring.
  try {
    const row = await ctx.prisma.apRequest.create({
      data: {
        status: 'quarantined',
        internet_message_id: msg.internetMessageId,
        conversation_id: msg.conversationId,
        received_at: new Date(msg.receivedDateTime),
        sender_address: msg.from,
        sender_validated: false,
        subject: msg.subject,
        body_html_sanitized: sanitizeEmailHtml(msg.bodyHtml) || null,
        body_text: msg.bodyText,
        quarantine_reason: reason,
      },
      select: { id: true },
    });
    await writeAudit({
      actor_label: 'system:ap-poll',
      action: 'insert',
      table_name: 'ap_requests',
      row_id: row.id,
      after: { status: 'quarantined', reason, sender_domain: domainOf(msg.from) },
    });
    await notifier.quarantine({ requestId: row.id, senderDomain: domainOf(msg.from), reason });
    return { kind: 'quarantined', requestId: row.id, reason };
  } catch (e) {
    if (isUniqueViolation(e)) return { kind: 'duplicate' };
    throw e;
  }
}

async function persistAttachments(
  ctx: IngestContext,
  requestId: string,
  attachments: readonly NormAttachment[],
): Promise<void> {
  for (const att of attachments) {
    if (att.kind === 'file') {
      await persistFile(ctx, requestId, att.id, att.name, att.contentType, att.size, att.contentBytesBase64);
    } else if (att.kind === 'reference_link') {
      // C10.3 — recorded for the approver, NEVER fetched.
      await ctx.prisma.apAttachment.create({
        data: { request_id: requestId, kind: 'reference_link', filename: att.name, link_url: att.sourceUrl },
      });
    } else {
      // nested_message — one-level unwrap: a marker row + its own files.
      await ctx.prisma.apAttachment.create({
        data: {
          request_id: requestId,
          kind: 'nested_message',
          filename: att.name,
          nested_subject: att.hasDeeperNesting
            ? `${att.nestedSubject ?? '(no subject)'} — contains further nested messages (not unwrapped)`
            : att.nestedSubject,
        },
      });
      for (const f of att.nestedFiles) {
        await persistFile(ctx, requestId, f.id, f.name, f.contentType, f.size, f.contentBytesBase64);
      }
    }
  }
}

async function persistFile(
  ctx: IngestContext,
  requestId: string,
  attachmentId: string,
  filename: string | null,
  contentType: string | null,
  size: number | null,
  contentBytesBase64: string | null,
): Promise<void> {
  let storageKey: string | null = null;
  if (contentBytesBase64) {
    const bytes = Buffer.from(contentBytesBase64, 'base64');
    // Fail-soft: null when R2 unconfigured → non-fetchable placeholder key so the
    // request still forms (operator provisions R2 later).
    storageKey =
      (await putApAttachment({ requestId, attachmentId, filename, contentType, bytes })) ??
      `pending-r2-ap-${requestId}-${attachmentId}`;
  }
  await ctx.prisma.apAttachment.create({
    data: {
      request_id: requestId,
      kind: 'file',
      filename,
      content_type: contentType,
      byte_size: size,
      storage_key: storageKey,
    },
  });
}

/**
 * Ingest one polled message to its single terminal state. Never leaves a message
 * unaccounted (C3): parse failures quarantine, not drop. Returns the outcome; the
 * caller (poll.ts) owns the move-to-Processed + the ledger.
 */
export async function ingestMessage(ctx: IngestContext, msg: MailMessage): Promise<IngestOutcome> {
  const log = ctx.log ?? noopLog;
  const notifier = ctx.notifier ?? defaultNotifier;

  if (!msg.internetMessageId) {
    // A message with no stable idempotency key cannot be safely ingested; treat as
    // unprocessable so it is visible, never silently skipped.
    log('warn', `[ap-ingest] message ${msg.id} has no internetMessageId — quarantining as unprocessable`);
    return createQuarantine(ctx, { ...msg, internetMessageId: `no-imid-${msg.id}` }, 'unprocessable');
  }

  if (await alreadySeen(ctx.prisma, msg.internetMessageId)) {
    return { kind: 'duplicate' };
  }

  const verdict = validateSender(msg.from, ctx.policy);
  if (!verdict.valid) {
    log('info', `[ap-ingest] quarantine (${verdict.reason}) domain=${domainOf(msg.from)}`);
    return createQuarantine(ctx, msg, verdict.reason ?? 'unprocessable');
  }

  // Follow-up: a same-conversation message while a request is OPEN (pending) →
  // a note on that request, never a second request (C4).
  if (msg.conversationId) {
    const open = await ctx.prisma.apRequest.findFirst({
      where: { conversation_id: msg.conversationId, status: 'pending' },
      orderBy: { received_at: 'asc' },
      select: { id: true },
    });
    if (open) {
      try {
        await ctx.prisma.apFollowup.create({
          data: {
            request_id: open.id,
            internet_message_id: msg.internetMessageId,
            received_at: new Date(msg.receivedDateTime),
            sender_address: msg.from,
            body_text: msg.bodyText,
          },
        });
        await writeAudit({
          actor_label: 'system:ap-poll',
          action: 'insert',
          table_name: 'ap_followups',
          row_id: open.id,
          after: { request_id: open.id, sender_domain: domainOf(msg.from) },
        });
        return { kind: 'followup', requestId: open.id };
      } catch (e) {
        if (isUniqueViolation(e)) return { kind: 'duplicate' };
        throw e;
      }
    }
  }

  // Fetch attachments BEFORE creating the request so a parse failure quarantines
  // the whole message rather than leaving a half-formed request.
  let attachments: NormAttachment[];
  try {
    attachments = msg.hasAttachments ? await ctx.transport.listAttachments(msg.id) : [];
  } catch (e) {
    log('warn', `[ap-ingest] attachment fetch/parse failed for ${msg.internetMessageId}: ${describe(e)} — quarantining`);
    return createQuarantine(ctx, msg, 'attachment_parse_failure');
  }

  let requestId: string;
  try {
    const row = await ctx.prisma.apRequest.create({
      data: {
        status: 'pending',
        internet_message_id: msg.internetMessageId,
        conversation_id: msg.conversationId,
        received_at: new Date(msg.receivedDateTime),
        sender_address: msg.from,
        sender_validated: true,
        subject: msg.subject,
        body_html_sanitized: sanitizeEmailHtml(msg.bodyHtml) || null,
        body_text: msg.bodyText,
      },
      select: { id: true },
    });
    requestId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) return { kind: 'duplicate' }; // move-race: another poll won
    throw e;
  }

  await persistAttachments(ctx, requestId, attachments);
  await writeAudit({
    actor_label: 'system:ap-poll',
    action: 'insert',
    table_name: 'ap_requests',
    row_id: requestId,
    after: { status: 'pending', sender_domain: domainOf(msg.from), attachment_count: attachments.length },
  });
  await notifier.newRequest({ requestId, subject: msg.subject, approverEmails: ctx.approverEmails });
  return { kind: 'created', requestId };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
