// ADR-0046 C3/C9-D4/D5 — AP system notifications.
//
// PII discipline (ADR-0045, D6): quarantine + deadman alerts carry ROW IDs +
// sender DOMAIN only — never body content, attachment names, amounts, vendor, or
// bank data. Quarantine also mails Bill (optional, env-gated) with the same
// minimal content. New-request notifications go to the approver set (their
// addresses come from the DB, not a log). All paths are fail-soft — a paging or
// mail failure must never fail the poll.

import { publishNtfy } from '@/lib/ntfy';
import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';

const SYSTEM_TOPIC = 'dr3-vision-system';
const QUARANTINE_COOLDOWN_MS = 30 * 60 * 1000; // container/self-mon class (ADR-0037 §3)
const DEADMAN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}
function apQueueUrl(): string {
  return `${baseUrl()}/dashboard/ops/ap`;
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
  const res = await sendSystemEmail({
    to,
    subject: `DR3-Vision — AP message quarantined (${args.requestId})`,
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    importance: 'high',
  });
  if (!res.delivered && !res.disabled) {
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
 * New-request notification to the approver set (their addresses from the DB).
 * Row id + subject only (subject is from an authenticated internal sender, safe
 * to include for triage — never attachment bytes/amounts). Fail-soft.
 */
export async function notifyNewRequest(args: {
  requestId: string;
  subject: string | null;
  approverEmails: readonly string[];
}): Promise<void> {
  if (args.approverEmails.length === 0) {
    log.warn({ requestId: args.requestId }, '[ap-notify] no approver addresses configured — new-request email skipped');
    return;
  }
  const subj = args.subject ?? '(no subject)';
  const htmlBody = `<p>A new vendor-invoice approval request is waiting in the DR3-Vision AP queue.</p>
    <ul>
      <li>Subject: ${escapeHtml(subj)}</li>
      <li>Request id: ${escapeHtml(args.requestId)}</li>
    </ul>
    <p><a href="${apQueueUrl()}">Open the AP approval queue</a> to review the invoice and approve or reject. First action wins.</p>`;
  for (const to of args.approverEmails) {
    await sendSystemEmail({
      to,
      subject: `DR3-Vision — new AP approval request: ${subj}`.slice(0, 200),
      htmlBody,
      fromDisplayName: 'DR3-Vision AP',
    }).catch(() => undefined);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
