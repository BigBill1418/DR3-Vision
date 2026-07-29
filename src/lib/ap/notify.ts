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
/** Section-level link to the AP queue (ADR-0036 tier-2 fallback). */
export function apQueueUrl(): string {
  return `${baseUrl()}/dashboard/ops/ap`;
}
/**
 * Tier-1 deep link to the specific request in the AP queue (ADR-0036 click policy).
 * EXPORTED so the §1.7 morning digest links rows the same way the notification
 * emails do — one definition of the click policy, not two that can drift.
 */
export function apRequestUrl(requestId: string): string {
  return `${apQueueUrl()}?request=${encodeURIComponent(requestId)}`;
}

/**
 * Quarantine alert (external sender / unprocessable). ROW ID + sender DOMAIN
 * ONLY. Pages `dr3-vision-system` (Bill-only, hard rule #5) and — when
 * `AP_QUARANTINE_EMAIL` is configured — mails the same minimal content.
 */
export async function alertQuarantine(args: {
  requestId: string;
  senderDomain: string;
  reason: string;
}): Promise<void> {
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
    log.warn(
      { requestId: args.requestId },
      '[ap-notify] quarantine email not delivered (ntfy still fired)',
    );
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
 * requester (internal forwarder), received-at (Pacific), attachment count, and a
 * TIER-1 deep link to the specific queue item. The subject rides the email SUBJECT
 * line and the request id lives in the deep-link URL — both are STRIPPED from the
 * body (ADR-0046 Amendment 4). Never attachment bytes/amounts (ADR-0045).
 * Fail-soft. ADR-0046 Amendment 3 deliverable 1.
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
    log.warn(
      { requestId: args.requestId },
      '[ap-notify] no active approver addresses — new-request email skipped',
    );
    return;
  }
  const subj = args.subject ?? '(no subject)';
  const requester = (args.senderAddress ?? '').trim() || '(unknown sender)';
  const receivedLine = args.receivedAt
    ? `<li>Received: ${escapeHtml(formatPacificDateTime(args.receivedAt))} PT</li>`
    : '';
  const count = typeof args.attachmentCount === 'number' ? args.attachmentCount : 0;
  const attachLine = `<li>Attachments: ${count}</li>`;
  // ADR-0046 Amendment 4 — the GP matching keys (original subject + request id)
  // are stripped from the body. The subject already rides the email SUBJECT line
  // (below); the request id lives (invisibly) in the deep-link URL. The body keeps
  // only the triage facts an approver needs before opening the queue.
  const htmlBody = `<p>A new vendor-invoice approval request is waiting in the DR3-Vision AP queue.</p>
    <ul>
      <li>Requested by: ${escapeHtml(requester)}</li>
      ${receivedLine}
      ${attachLine}
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

/** Cooldown for the second-approval routing page — per request, so a re-entry can't
 * double-page but a distinct invoice always does. Routine hop, not an incident. */
const SECOND_APPROVAL_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * ADR-0046 Amendment 5 (D-M5-3) — a >= $1,000 Approve just entered
 * `pending_second_approval`; page + email the SITE-APPROPRIATE second approver
 * (Woodland → Bill, Eugene → Shannon). Fires ntfy `dr3-vision-system` (Bill's
 * reader) the moment the state fires, and routes an email through the `ap_notify`
 * gate to the routed second approver's address(es) — in pilot that reroutes to
 * admins with a `[PILOT]` header (the existing rollout gate). No amounts/vendor in
 * the ntfy body (ADR-0045: row id + site only); the email is a triage nudge with a
 * TIER-1 deep link. Fail-soft — a paging/mail failure never fails the decision.
 */
export async function notifySecondApprovalNeeded(args: {
  requestId: string;
  subject: string | null;
  siteCode: string;
  siteLabel: string;
  approverEmails: readonly string[];
}): Promise<void> {
  const subj = args.subject ?? '(no subject)';
  await publishNtfy({
    topic: SYSTEM_TOPIC,
    title: `AP invoice ≥ $1,000 — second approval needed (${args.siteLabel})`,
    // ADR-0045 — row id + site only; never the amount/vendor in the page body.
    body: `A vendor invoice was first-approved and needs a SECOND approval before payment. Site: ${args.siteLabel}. Request id: ${args.requestId}. Open the AP queue to confirm or override.`,
    priority: 'high',
    tags: ['warning', 'ap', 'second-approval', 'dr3-vision'],
    clickUrl: apRequestUrl(args.requestId),
    fingerprint: `ap-second-approval:${args.requestId}`,
    cooldownMs: SECOND_APPROVAL_COOLDOWN_MS,
  }).catch(() => undefined);

  if (args.approverEmails.length === 0) {
    // No rostered second approver for the site (Woodland relies on admin-
    // eligibility). The ntfy page (Bill's reader) still fired above; the pilot
    // ap_notify gate reroutes any email to admins anyway, so nothing is lost.
    log.warn(
      { requestId: args.requestId, siteCode: args.siteCode },
      '[ap-notify] no rostered second-approver address — routing notification page-only',
    );
    return;
  }
  const htmlBody = `<p>A vendor invoice ≥ $1,000 was first-approved in DR3-Vision and now needs your <b>second approval</b> before payment.</p>
    <ul>
      <li>Site: ${escapeHtml(args.siteLabel)}</li>
    </ul>
    <p><a href="${apRequestUrl(args.requestId)}">Open this request in the AP approval queue</a> to review the first approver’s decision and confirm — or reject to override. First action wins.</p>`;
  await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: [...args.approverEmails],
    subject: `DR3-Vision — second approval needed (≥ $1,000): ${subj}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    importance: 'high',
  }).catch(() => undefined);
}

/**
 * ADR-0066 §1.5 — the request has aged past its weekday-clock deadline and the
 * FALLBACK approver has just been added as an additional signer.
 *
 * EMAIL ONLY, DELIBERATELY. `notifySecondApprovalNeeded` (above) pages
 * `dr3-vision-system` on every call; reusing it here would push a staff workflow
 * nudge onto Bill's phone once an hour. CLAUDE.md hard rule #5 reserves ntfy for
 * Bill and SYSTEM-level events, and ADR-0037's gate agrees: an invoice waiting a
 * day is not actionable-in-five-minutes and is not customer-visible. The
 * conditions that DO page from the scanner are a routing misconfiguration
 * ({@link reportSecondApprovalRoutingProblem}) and the scanner failing to run at
 * all — both system-level, both Bill's.
 *
 * The copy leads with ADDITIVE, because that is the semantic operators get wrong:
 * the originally routed peer is still able to sign, and whoever acts first
 * completes it. Nothing is taken away from anyone.
 *
 * Fail-soft at the caller — an escalation that cannot be emailed must not undo
 * the (committed) escalation stamp.
 */
export async function notifySecondApprovalEscalated(args: {
  requestId: string;
  subject: string | null;
  /** Business hours the request waited; 0 for the immediate no-routing-row path. */
  thresholdHours: number;
  /** The originally routed peer, who REMAINS able to sign. */
  routedToName: string | null;
  approverEmails: readonly string[];
}): Promise<void> {
  if (args.approverEmails.length === 0) {
    // Not necessarily a defect: the escalation target may have switched their
    // `second_approval_request` pref off (§1.6). The EMPTY-ROUTING case is alarmed
    // separately by the caller — this log distinguishes "opted out" from "nobody".
    log.warn(
      { requestId: args.requestId },
      '[ap-notify] escalation had no pref-eligible recipient — email skipped',
    );
    return;
  }
  const subj = args.subject ?? '(no subject)';
  const waited =
    args.thresholdHours > 0
      ? `has been waiting more than ${args.thresholdHours} business hours (weekdays only — the clock pauses over the weekend)`
      : 'has no configured approval pair, so it escalated immediately';
  const peer = args.routedToName
    ? `${escapeHtml(args.routedToName)} can still sign it`
    : 'the originally routed approver can still sign it';
  const htmlBody = `<p>A vendor invoice ≥ $1,000 ${waited} for its <b>second approval</b>. You have been added as an additional approver.</p>
    <p><b>This is additive, not a hand-off</b> — ${peer}. Whoever acts first completes it.</p>
    <p><a href="${apRequestUrl(args.requestId)}">Open this request in the AP approval queue</a> to review the first approver’s decision and confirm — or reject to override.</p>`;
  await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: [...args.approverEmails],
    subject: `DR3-Vision — second approval ESCALATED (≥ $1,000): ${subj}`.slice(0, 200),
    htmlBody,
    fromDisplayName: 'DR3-Vision AP',
    importance: 'high',
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * ADR-0066 §B.5 — the routing-misconfiguration alarm.
 *
 * WHY THIS EXISTS, AND WHY IT USES BOTH CHANNELS:
 *
 * Fail-soft is the right posture for a notification — a paging failure must never
 * roll back a committed approval. But fail-soft over an EMPTY RECIPIENT SET is
 * indistinguishable from a successful send, and that indistinguishability is
 * exactly what let >= $1,000 Woodland invoices sit unapproved and invisible for
 * days. The send stays fail-soft; the CONDITION becomes loud.
 *
 * It pages ntfy AND emails, deliberately. Check C (2026-07-29) found that the
 * pre-existing second-approval ntfy publish fires before the empty-recipient
 * check and is wrapped in `.catch(() => undefined)` — Bill received nothing from
 * it, while publisher auth verified healthy (HTTP 200). Whatever swallowed those
 * pages would swallow this alarm too. Reporting a notification failure over the
 * single channel that just demonstrably failed is how the bug repeats itself, so
 * this deliberately does not depend on ntfy alone.
 *
 * Itself fail-soft: raising the alarm must never fail the approval either.
 */
export async function reportSecondApprovalRoutingProblem(args: {
  requestId: string;
  firstApproverId: string;
  problems: readonly string[];
  recipientCount: number;
}): Promise<void> {
  const summary =
    args.recipientCount === 0
      ? 'A second approval was authorized but has NO reachable recipient — it would sit unapproved and invisible.'
      : 'AP second-approval routing is misconfigured.';
  const detail = args.problems.length > 0 ? args.problems.join(' · ') : '(no detail)';

  log.error(
    {
      requestId: args.requestId,
      firstApproverId: args.firstApproverId,
      recipientCount: args.recipientCount,
      problems: args.problems,
    },
    '[ap-notify] second-approval routing problem',
  );

  await publishNtfy({
    topic: SYSTEM_TOPIC,
    title: 'AP second-approval routing problem',
    // ADR-0045 — ids only in the page body, never amount or vendor.
    body: `${summary} Request id: ${args.requestId}. ${detail}`,
    priority: 'urgent',
    tags: ['rotating_light', 'ap', 'routing', 'dr3-vision'],
    clickUrl: apRequestUrl(args.requestId),
    // Per-request fingerprint: distinct requests always page, a retry does not.
    fingerprint: `ap-routing-problem:${args.requestId}`,
    cooldownMs: SECOND_APPROVAL_COOLDOWN_MS,
  }).catch(() => undefined);

  // Recipients deliberately EMPTY: `notifyStaff` routes an empty intended-set to
  // admins, which is exactly right here — this is an operator alarm about the
  // routing table itself, so it must reach Bill rather than the (unreachable)
  // person the broken routing pointed at.
  await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: [],
    subject: `DR3-Vision — AP second-approval routing problem (request ${args.requestId})`.slice(
      0,
      200,
    ),
    htmlBody: `<p><b>${escapeHtml(summary)}</b></p>
      <p><a href="${apRequestUrl(args.requestId)}">Open the request in the AP queue</a></p>
      <p>Detail: ${escapeHtml(detail)}</p>
      <p>Fix the pair at <code>/admin/ap/routing</code>. The approval itself was NOT affected — this alarm reports that the <i>notification</i> could not reach its intended person.</p>`,
    fromDisplayName: 'DR3-Vision AP',
    importance: 'high',
  }).catch(() => undefined);
}
