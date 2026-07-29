// ADR-0066 §1.5 — the hourly 24-hour WEEKDAY-clock escalation scanner.
//
// ── What it does ────────────────────────────────────────────────────────────
// Every hour it reads the open second-approval backlog
// (`status='pending_second_approval' AND escalated_at IS NULL` — exactly the
// `ap_requests_pending_second_escalation_idx` partial index) and, for each row
// that has aged past its routing pair's `fallback_after_hours` of BUSINESS time,
// stamps `escalated_at`/`escalated_to`, writes an append-only audit row, and
// emails the fallback approver.
//
// ── ESCALATION IS ADDITIVE, NEVER A TRANSFER ────────────────────────────────
// The originally routed peer stays able to sign; the fallback approver becomes
// ADDITIONALLY able. Whoever acts first completes it. Nothing is taken away from
// anyone, and this module writes no code to express the widening itself — that
// lives in `resolveSecondApproval(…, { escalated: true })`, which both the
// authorization half and the notification half already consume. Re-deriving it
// here is precisely how the two halves drifted apart and caused the outage.
//
// ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
// `escalated_at IS NULL` is the key, and it is enforced TWICE: once in the
// candidate query and again as a CONDITIONAL predicate on the claiming
// `updateMany`. The second one is what matters — the first is a read and two
// overlapping scans (a slow run overlapping the next hourly fire, or a container
// restart mid-run) could both see the same row. Only the write that flips a
// still-NULL row wins; the loser notifies nobody and audits nothing.
//
// ── FAIL LOUD (§B.8 / ADR-0057 D9) ──────────────────────────────────────────
// This scanner exists because a notification failed SILENTLY. A scanner that
// cannot run must therefore never no-op quietly: a throw pages
// `dr3-vision-system` and re-throws so the route 500s and the daemon logs it. A
// per-request failure is contained (one bad row must not strand the rest of the
// backlog) but still pages, because a request that could not be evaluated is a
// request sitting invisible — the exact failure class this ADR exists to remove.
//
// ── ntfy DISCIPLINE (CLAUDE.md hard rule #5) ────────────────────────────────
// Staff are NEVER paged. Escalation reaches the fallback approver by EMAIL
// through `notifyStaff()` (the ADR-0047 chokepoint, subject to the `ap_notify`
// rollout gate) and per-user `second_approval_request` prefs (§1.6). The only
// ntfy publishes here are system-level and Bill's: a routing misconfiguration
// (via `reportSecondApprovalRoutingProblem`) and a scanner that failed to run.

import { prisma as defaultPrisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { writeAudit } from '@/lib/audit';
import { publishNtfy } from '@/lib/ntfy';
import { log } from '@/lib/observability/logger';
import { businessHoursElapsedExceeds } from './business-clock';
import {
  resolveSecondApproval,
  type ResolvedRecipient,
  type SecondApprovalRouting,
} from './second-approval-resolver';
import { filterBySecondApprovalPref } from './notification-prefs';
import { notifySecondApprovalEscalated, reportSecondApprovalRoutingProblem } from './notify';

const TABLE = 'ap_requests';
const ACTOR_LABEL = 'system:ap-escalation-scan';
const SYSTEM_TOPIC = 'dr3-vision-system';

/** Used when a routing row exists but carries no usable `fallback_after_hours`. */
const DEFAULT_FALLBACK_AFTER_HOURS = 24;

/**
 * A scanner that is hard-down pages at most 4×/day rather than every hourly fire.
 * Mirrors the AP poll deadman's 6h class (ADR-0037 §3) — a persistent failure is
 * one condition, not twenty-four.
 */
const SCAN_FAILURE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export interface RunApEscalationScanOpts {
  prisma?: PrismaClient;
  /** Clock seam. */
  now?: Date;
}

export interface ApEscalationScanResult {
  /** Open, un-escalated second approvals considered this run. */
  scanned: number;
  /** How many this run actually claimed and stamped. */
  escalated: number;
  /** Request ids escalated by THIS run (a re-run returns none of them). */
  requestIds: string[];
  /** Routing misconfigurations + per-request failures surfaced this run. */
  problems: string[];
}

/** The candidate shape the partial index serves. */
interface Candidate {
  id: string;
  subject: string | null;
  first_approver_id: string | null;
  first_approved_at: Date | null;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Who escalation ADDED — i.e. everyone now notifiable who was not the originally
 * routed peer. Read off the resolver's own output rather than re-querying the
 * routing table, so "who is the fallback" has exactly one implementation.
 *
 * Degenerate case: when the peer IS the fallback the resolver dedupes them to a
 * single recipient, so nothing was "added" — that person is the escalation target.
 */
function escalationTargetsOf(routed: SecondApprovalRouting): ResolvedRecipient[] {
  const peerId = routed.routedTo?.userId;
  const added = routed.recipients.filter((r) => r.userId !== peerId);
  return added.length > 0 ? added : [...routed.recipients];
}

/**
 * The pair's configured business-hours threshold. Only ever consulted when the
 * resolver has already reported that a routing row EXISTS — the "no row"
 * decision is the resolver's (`outcome: 'fallback_no_routing_row'`), never
 * re-derived here.
 */
async function thresholdHoursFor(prisma: PrismaClient, firstApproverId: string): Promise<number> {
  const row = await prisma.apApprovalRouting.findFirst({
    where: { first_approver_id: firstApproverId, active: true },
    select: { fallback_after_hours: true },
  });
  const h = row?.fallback_after_hours;
  return typeof h === 'number' && h > 0 ? h : DEFAULT_FALLBACK_AFTER_HOURS;
}

interface Due {
  due: boolean;
  /** 0 marks an IMMEDIATE escalation (§1.4 — no routing row, no 24h wait). */
  thresholdHours: number;
}

async function isDue(
  prisma: PrismaClient,
  req: Candidate,
  routed: SecondApprovalRouting,
  now: Date,
): Promise<Due> {
  // §1.4/§1.5: an approver with no routing row falls back IMMEDIATELY — no 24h
  // wait — and raises a digest warning. The resolver already reports that state;
  // we read it rather than re-querying the table and re-deciding.
  if (routed.outcome === 'fallback_no_routing_row') return { due: true, thresholdHours: 0 };

  // A row sitting in `pending_second_approval` with no `first_approved_at` cannot
  // be aged at all. Treating that as "not due yet" would leave it invisible
  // forever — the exact failure class. Escalate immediately instead: escalation is
  // additive, so making a data-defective row MORE visible costs nothing, and the
  // routing alarm below carries the reason.
  if (!req.first_approved_at) return { due: true, thresholdHours: 0 };

  const thresholdHours = await thresholdHoursFor(prisma, req.first_approver_id ?? '');
  const due = await businessHoursElapsedExceeds(prisma, req.first_approved_at, thresholdHours, now);
  return { due, thresholdHours };
}

/**
 * Evaluate one candidate. Returns whether THIS call claimed the escalation (a
 * concurrent scan or a decision that landed mid-run yields `false`, silently and
 * correctly) plus any problems worth surfacing.
 */
async function escalateIfDue(
  prisma: PrismaClient,
  req: Candidate,
  now: Date,
): Promise<{ escalated: boolean; problems: string[] }> {
  const firstApproverId = req.first_approver_id ?? '';

  // Resolve ONCE, with the escalated widening applied. Pure read — safe to call
  // before knowing whether the request is due, and it is the resolver's `outcome`
  // that answers the "no routing row ⇒ immediate" question below.
  const routed = await resolveSecondApproval(prisma, { firstApproverId, escalated: true });

  const { due, thresholdHours } = await isDue(prisma, req, routed, now);
  if (!due) return { escalated: false, problems: [] };

  const targets = escalationTargetsOf(routed);
  const target = targets[0] ?? null;

  // ── The claim ─────────────────────────────────────────────────────────────
  // Conditional on `escalated_at IS NULL`, with the append-only audit row in the
  // SAME transaction (hard rule #6): there is no window in which a request is
  // stamped escalated but has no audit trail, and no window in which two runs both
  // believe they escalated it.
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.apRequest.updateMany({
      where: { id: req.id, status: 'pending_second_approval', escalated_at: null },
      data: { escalated_at: now, escalated_to: target?.userId ?? null },
    });
    if (res.count === 0) return false;
    await writeAudit(
      {
        actor_label: ACTOR_LABEL,
        action: 'update',
        table_name: TABLE,
        row_id: req.id,
        before: { status: 'pending_second_approval', escalated_at: null, escalated_to: null },
        after: {
          status: 'pending_second_approval', // UNCHANGED — escalation is not a decision
          escalated_at: now.toISOString(),
          escalated_to: target?.userId ?? null,
          routing_outcome: routed.outcome,
          threshold_hours: thresholdHours,
          first_approver_id: req.first_approver_id,
          first_approved_at: req.first_approved_at?.toISOString() ?? null,
          // The property an auditor should be able to read straight off the row.
          additive: true,
          still_authorized: routed.authorizedUserIds,
        },
      },
      { tx },
    );
    return true;
  });
  if (!claimed) return { escalated: false, problems: [] };

  // ── Alarm on misconfiguration (§B.5) ──────────────────────────────────────
  // Pages + emails Bill. This is the only system-level condition the scanner
  // raises about an individual request, and it deliberately does not rely on ntfy
  // alone — Check C showed those pages never reached him.
  const problems = [...routed.problems];
  if (routed.recipients.length === 0) {
    problems.push(
      `Request ${req.id} escalated with NO reachable recipient — it would sit unapproved and invisible.`,
    );
  }
  if (problems.length > 0) {
    await reportSecondApprovalRoutingProblem({
      requestId: req.id,
      firstApproverId,
      problems,
      recipientCount: routed.recipients.length,
    }).catch(() => undefined);
  }

  // ── Notify the FALLBACK, by email (§1.6 / hard rule #5) ───────────────────
  // Only the people escalation ADDED: the routed peer already received the
  // original second-approval request and does not need it re-sent hourly. The
  // pref filter can only SUBTRACT from an already-routed set — never turn this
  // into a broadcast.
  const recipients = await filterBySecondApprovalPref(prisma, targets);

  // ⚠ THE LATCH IS ALREADY BURNED AT THIS POINT.
  //
  // `escalated_at` is BOTH the idempotency key and the only "this was handled"
  // record, and it was committed above. So any way of reaching this line with
  // nobody notified is a ONE-SHOT silent drop: the next scan sees
  // `escalated_at IS NOT NULL`, skips the row, and reports a perfectly clean
  // `scanned: 0`. That is the original outage's shape — success and failure
  // indistinguishable from the outside — reappearing one layer downstream.
  //
  // Two reachable routes here, both now ALARMED rather than merely logged:
  //   (a) every escalation target has `notify_second_approval_request` OFF, so
  //       the pref filter empties a non-empty routed set;
  //   (b) the send throws (M365 429, transport blip, SIGTERM mid-flight).
  //
  // We deliberately do NOT roll the latch back. Un-latching would re-notify
  // hourly forever on a persistent mail failure, and the escalation itself (the
  // widened authority) DID happen and is audited. The right answer is to make
  // the drop loud, so a human closes it, rather than to churn.
  if (recipients.length === 0) {
    const names = targets.map((t) => t.name).join(', ') || '(none resolved)';
    const msg =
      targets.length > 0
        ? `Request ${req.id}: ESCALATED but notified NOBODY — every escalation target (${names}) has notify_second_approval_request OFF. The escalation is latched and will not retry.`
        : `Request ${req.id}: ESCALATED but no reachable escalation target resolved. The escalation is latched and will not retry.`;
    log.error({ requestId: req.id, targets: targets.length }, `[ap-escalation-scan] ${msg}`);
    problems.push(msg);
    await reportSecondApprovalRoutingProblem({
      requestId: req.id,
      firstApproverId: req.first_approver_id ?? '',
      problems: [msg],
      recipientCount: 0,
    }).catch(() => undefined);
  } else {
    await notifySecondApprovalEscalated({
      requestId: req.id,
      subject: req.subject,
      thresholdHours,
      routedToName: routed.routedTo?.name ?? null,
      approverEmails: recipients.map((r) => r.email),
    }).catch(async (err: unknown) => {
      // Fail-soft on the SEND (a mail failure must not undo a committed
      // escalation) but NEVER silent — and, critically, not merely returned in
      // `problems`, which only surfaces for THIS run. The latch is spent, so this
      // has to page a human now or the escalation is lost for good.
      const msg = `Request ${req.id}: escalation email FAILED after the escalation was latched — it will not retry. ${errText(err)}`;
      log.error({ requestId: req.id, err: errText(err) }, '[ap-escalation-scan] ' + msg);
      problems.push(msg);
      await reportSecondApprovalRoutingProblem({
        requestId: req.id,
        firstApproverId: req.first_approver_id ?? '',
        problems: [msg],
        recipientCount: recipients.length,
      }).catch(() => undefined);
    });
  }

  log.info(
    {
      requestId: req.id,
      escalatedTo: target?.userId ?? null,
      outcome: routed.outcome,
      thresholdHours,
      notified: recipients.length,
    },
    '[ap-escalation-scan] escalated',
  );
  return { escalated: true, problems };
}

/** Fail-loud page — system-level, Bill-only, cooldown-classed (ADR-0037 §3). */
async function pageScanFailure(detail: string): Promise<void> {
  await publishNtfy({
    topic: SYSTEM_TOPIC,
    title: 'AP escalation scan FAILED',
    body: `The hourly AP second-approval escalation scan could not complete. Invoices >= $1,000 may be sitting past their 24h weekday deadline with nobody escalated. ${detail}`,
    priority: 'high',
    tags: ['error', 'ap', 'escalation', 'dr3-vision'],
    clickUrl: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    fingerprint: 'ap-escalation-scan-failure',
    cooldownMs: SCAN_FAILURE_COOLDOWN_MS,
  }).catch(() => undefined);
}

async function scan(prisma: PrismaClient, now: Date): Promise<ApEscalationScanResult> {
  const candidates = (await prisma.apRequest.findMany({
    where: { status: 'pending_second_approval', escalated_at: null },
    select: { id: true, subject: true, first_approver_id: true, first_approved_at: true },
  })) as Candidate[];

  const problems: string[] = [];
  const requestIds: string[] = [];
  let failed = 0;

  for (const req of candidates) {
    try {
      const res = await escalateIfDue(prisma, req, now);
      if (res.escalated) requestIds.push(req.id);
      problems.push(...res.problems);
    } catch (err) {
      // Contained: one poisoned row must not strand the rest of the backlog.
      failed += 1;
      problems.push(`Request ${req.id}: escalation evaluation failed — ${errText(err)}`);
      log.error(
        { requestId: req.id, err: errText(err) },
        '[ap-escalation-scan] request evaluation failed',
      );
    }
  }

  if (failed > 0) {
    await pageScanFailure(
      `${failed} of ${candidates.length} pending second approval(s) could not be evaluated — see the container log for the request ids.`,
    );
  }

  log.info(
    { scanned: candidates.length, escalated: requestIds.length, failed },
    '[ap-escalation-scan] run complete',
  );
  return { scanned: candidates.length, escalated: requestIds.length, requestIds, problems };
}

/**
 * Run one escalation scan. Safe to call repeatedly — a re-run over an already
 * escalated backlog claims nothing, notifies nobody, and writes no audit rows.
 *
 * Throws only when the scan ITSELF cannot run (e.g. the candidate query fails),
 * and pages `dr3-vision-system` before it does. The caller (the internal route)
 * turns that into a 500 the daemon logs and retries next hour.
 */
export async function runApEscalationScan(
  opts: RunApEscalationScanOpts = {},
): Promise<ApEscalationScanResult> {
  const prisma = opts.prisma ?? defaultPrisma;
  const now = opts.now ?? new Date();
  try {
    return await scan(prisma, now);
  } catch (err) {
    await pageScanFailure(`The scan threw: ${errText(err)}`);
    throw err;
  }
}
