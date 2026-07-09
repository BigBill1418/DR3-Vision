// ADR-0046 C3/C9-D4/D5 — AP system notifications.
//
// PII discipline (ADR-0045, D6): quarantine + deadman alerts carry ROW IDs +
// sender DOMAIN only — never body content, attachment names, amounts, vendor, or
// bank data. Quarantine also mails Bill (optional, env-gated) with the same
// minimal content. New-request notifications go to the approver set (their
// addresses come from the DB, not a log). All paths are fail-soft — a paging or
// mail failure must never fail the poll.

import { publishNtfy } from '@/lib/ntfy';
import { notifyStaff } from '@/lib/notify/notify-staff';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { log } from '@/lib/observability/logger';
import { formatPacificDateTime } from '@/lib/time';

const SYSTEM_TOPIC = 'dr3-vision-system';
const QUARANTINE_COOLDOWN_MS = 30 * 60 * 1000; // container/self-mon class (ADR-0037 §3)
const DEADMAN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}
function apQueueUrl(): string {
  return `${baseUrl()}/dashboard/ops/ap`;
}
/** Tier-1 deep link to the specific request in the AP queue (ADR-0036 click policy). */
function apRequestUrl(requestId: string): string {
  return `${apQueueUrl()}?request=${encodeURIComponent(requestId)}`;
}

/**
 * Quarantine alert (external sender / unprocessable). ROW ID + sender DOMAIN
 * ONLY. Pages `dr3-vision-system` (Bill-only, hard rule #5) and — when
 * `AP_QUARANTINE_EMAIL` is configured — mails the same minimal content.
 */
export async function alertQuarantine(args: { requestId: string; senderDomain: string; reason: string }): Promise<void> {
  const body = `An AP message was quarantined (reason=${args.reason}). Review it in the admin AP queue. Request id: ${args.requestId} · sender domain: ${args.senderDomain}`;
  await publishNtfy({
    topic: SYSTEM_TOPIC,
    title: 'AP message quarantined',
    body,
    priority: 'high',
    tags: ['warning', 'ap', 'quarantine', 'dr3-vision'],
    clickUrl: apQueueUrl(),
    fingerprint: `ap-quarantine:${args.requestId}`,
    cooldownMs: QUARANTINE_COOLDOWN_MS,
  }).catch(() => undefined);

  const to = process.env['AP_QUARANTINE_EMAIL']?.trim();
  if (!to) return;
  const htmlBody = `<p>An AP approval message was <b>quarantined</b> and needs admin review.</p>
    <ul>
      <li>Reason: ${escapeHtml(args.reason)}</li>
      <li>Request id: ${escapeHtml(args.requestId)}</li>
      <li>Sender domain: ${escapeHtml(args.senderDomain)}</li>
    </ul>
    <p>No message body, attachment names, or amounts are included by design (ADR-0045). Open the AP queue to review.</p>`;
  // ADR-0047 — AP module is org-wide + born pilot; route mail through the gate.
  const res = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: [to],
    subject: `DR3-Vision — AP message quarantined (${args.requestId})`,
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    importance: 'high',
  }).catch(() => null);
  if (res && res.delivered === 0 && !res.disabled) {
    log.warn({ requestId: args.requestId }, '[ap-notify] quarantine email not delivered (ntfy still fired)');
  }
}

/** Deadman: no successful poll in > threshold while enabled (D5). Pages system. */
export async function alertDeadman(hoursSince: number, thresholdMinutes: number): Promise<void> {
  await publishNtfy({
    topic: SYSTEM_TOPIC,
    title: 'AP poll deadman — no successful poll',
    body: `No successful AP mailbox poll in ${hoursSince}h (threshold ${thresholdMinutes}min). The ap-poll daemon may be wedged or the transport is failing. Check the container + poll ledger.`,
    priority: 'high',
    tags: ['error', 'ap', 'deadman', 'dr3-vision'],
    clickUrl: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    fingerprint: 'ap-poll-deadman',
    cooldownMs: DEADMAN_COOLDOWN_MS,
  }).catch(() => undefined);
}

/**
 * New-request notification to ALL active approvers (their addresses resolved once
 * per poll from the expiry-aware ap_approvers roster; an expired `active_until`
 * excludes an approver). ONE email per new request (fired only on the `created`
 * terminal state — never per-poll, never for follow-ups/duplicates). Carries the
 * requester (internal forwarder), subject, received-at (Pacific), attachment count,
 * and a TIER-1 deep link to the specific queue item. Row id + subject + forwarder
 * address are all from an authenticated internal sender (safe for triage); never
 * attachment bytes/amounts (ADR-0045). Fail-soft. ADR-0046 Amendment 3 deliverable 1.
 */
export async function notifyNewRequest(args: {
  requestId: string;
  subject: string | null;
  senderAddress?: string | null;
  receivedAt?: Date | null;
  attachmentCount?: number;
  approverEmails: readonly string[];
}): Promise<void> {
  if (args.approverEmails.length === 0) {
    log.warn({ requestId: args.requestId }, '[ap-notify] no active approver addresses — new-request email skipped');
    return;
  }
  const subj = args.subject ?? '(no subject)';
  const requester = (args.senderAddress ?? '').trim() || '(unknown sender)';
  const receivedLine = args.receivedAt
    ? `<li>Received: ${escapeHtml(formatPacificDateTime(args.receivedAt))} PT</li>`
    : '';
  const count = typeof args.attachmentCount === 'number' ? args.attachmentCount : 0;
  const attachLine = `<li>Attachments: ${count}</li>`;
  const htmlBody = `<p>A new vendor-invoice approval request is waiting in the DR3-Vision AP queue.</p>
    <ul>
      <li>Requested by: ${escapeHtml(requester)}</li>
      <li>Subject: ${escapeHtml(subj)}</li>
      ${receivedLine}
      ${attachLine}
      <li>Request id: ${escapeHtml(args.requestId)}</li>
    </ul>
    <p><a href="${apRequestUrl(args.requestId)}">Open this request in the AP approval queue</a> to review and approve, reject, or place it on hold. First action wins.</p>`;
  // ADR-0047 — org-wide AP surface, born pilot. One gated send to ALL active
  // approvers (in pilot it reroutes to admins; the approvers receive nothing until
  // Bill flips ap_notify live). notifyStaff is the mandated chokepoint (CLAUDE.md #12).
  await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: [...args.approverEmails],
    subject: `DR3-Vision — new AP approval request: ${subj}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
  }).catch(() => undefined);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
