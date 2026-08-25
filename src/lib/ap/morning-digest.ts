// ADR-0066 §1.7 — Bill's 06:00 PT weekday AP morning digest.
//
// ── What this is ────────────────────────────────────────────────────────────
// An OVERSIGHT tool, not a work queue. Bill, verbatim: *"it's an oversight tool,
// the team works off the live queue."* So it goes to exactly one person — and
// that person is resolved by the `notify_daily_digest` PREF (§1.6), never by a
// hardcoded address. If Bill's account changes, or he adds someone, the prefs
// row is the only thing that moves.
//
// ── Coverage: everything pending ────────────────────────────────────────────
// Bill chose the widest option explicitly. Four item sections plus two warning
// classes:
//
//   1. `pending_second_approval` — WITH the individual who owes the signature,
//      resolved through the shared §1.4 resolver (never re-derived here).
//   2. `pending` — no first approval yet, flagged by age.
//   3. `pending_review` (Hold) — only the ones that have gone STALE.
//   4. Escalations that fired since the last digest.
//   W1. Any ACTIVE approver with no `ap_approval_routing` row. This is how a
//       missing pair gets noticed (§1.4: the table must be TOTAL).
//   W2. Any invoice 3+ days old — which also marks the WHOLE digest high
//       priority.
//
// ── Suppression (§1.7, and the easiest thing to get wrong) ──────────────────
// A digest with nothing in it is not sent AT ALL. No zero-state noise, no
// "0 pending" mail. Asserted directly in `morning-digest.test.ts`.
//
// The one deliberate refinement: "empty" means NO ITEMS **AND** NO WARNINGS. A
// routing-coverage warning with an empty queue still sends. Suppressing it would
// mean a missing routing pair stays invisible until an invoice happens to arrive
// — which is the exact shape of the outage ADR-0066 exists to fix (a real
// misconfiguration that looks like silence). A routing warning is a one-minute
// fix that then stops recurring, so this cannot become chronic noise.
//
// ── Time (ADR-0065) ─────────────────────────────────────────────────────────
// Both sites are Pacific; the container runs UTC. Every timestamp shown to Bill
// goes through `formatPacificDateTime` and every AGE is counted in PACIFIC
// CALENDAR DAYS. Counting in UTC would roll the day boundary at 4/5 PM Pacific
// and over-age every evening invoice by a full day. No new date arithmetic —
// the weekday gate and the day-step primitives come from `business-clock.ts`.
//
// ── Chokepoint (ADR-0047 / CLAUDE.md #12) ───────────────────────────────────
// Sent via `notifyStaff()` on the EXISTING `ap_notify` surface — never a raw
// mail import (enforced by `no-direct-mail.test.ts`). Reusing `ap_notify` rather
// than registering a new surface is deliberate: `ap_notify` is `live` at both
// sites (ADR-0066 Check D), and Bill's instruction for §1.7 was *"we want that
// daily digest to go live as well - its time."* A new surface would be born
// `pilot` and would NOT ship live.
//
// ── Separate email, deliberately (§1.7) ─────────────────────────────────────
// Bill picked 06:00 WITHOUT the "merge with a future document-ingestion digest"
// option. This module owns one email, one subject line, one cron service; a
// future ingestion digest gets its own.

import { prisma } from '@/lib/prisma';
import type { PrismaClient } from '@prisma/client';
import { notifyStaff, type NotifyStaffMode } from '@/lib/notify/notify-staff';
import { publishNtfy } from '@/lib/ntfy';
import { NOTIFY_SURFACE } from '@/lib/notify/rollout';
import { log } from '@/lib/observability/logger';
import { dayKeyUTCFromISO, formatPacificDateTime } from '@/lib/time';
import {
  fleetWideHolidays,
  isBusinessDay,
  isBusinessDayNow,
  pacificDayISO,
  pacificDayStartInstantPlus,
} from './business-clock';
import { docIngestReauthWarning } from '@/lib/doc-ingest/reauth';
import { docIngestDiscoveryGapWarning } from '@/lib/doc-ingest/reachability';
import { dailyDigestRecipients } from './notification-prefs';
import { resolveSecondApproval } from './second-approval-resolver';
import { apQueueUrl, apRequestUrl, reimbursementUrl } from './notify';
import {
  decisionMailStuckFingerprint,
  decisionMailUnsentWhere,
  isDecisionMailStuck,
} from './decision-mail';

/**
 * Age (in Pacific calendar days) at which an item raises the age warning AND
 * marks the whole digest high priority (§1.7).
 */
export const AGE_WARNING_DAYS = 3;

/**
 * A Hold is STALE at the same threshold. One number in the digest, not two:
 * Bill asked for "Hold that have gone stale" without naming a figure, and a
 * second, different age boundary in the same email is a thing to misread rather
 * than a thing to act on.
 */
export const STALE_HOLD_DAYS = AGE_WARNING_DAYS;

/**
 * How far back to walk for the previous business day when bounding the
 * escalation delta. Covers a long holiday weekend with room to spare.
 */
const MAX_LOOKBACK_DAYS = 7;

/**
 * ADR-0126 / ADR-0037 §3 — cooldown for the decided-but-unmailed page.
 *
 * A WEEK, which is far longer than any other alert in this module, and that is the
 * grading rather than an oversight. The digest fires daily, so anything at or
 * under 24h would re-page every morning for a row whose fix is a human deciding
 * whether to re-send — the textbook chronic-condition alert that trains an
 * operator to swipe the topic away, taking the genuinely urgent pages with it.
 *
 * Suppression is safe here ONLY because the page is not the durable surface: the
 * digest line reappears every single morning until the row clears, and the queue
 * badge is on the row itself. The page exists to catch the FIRST occurrence
 * quickly; the digest carries it from then on. Because the fingerprint is keyed on
 * the set of stuck ids, a new stuck decision is never suppressed by this window.
 *
 * Caveat worth knowing: `publishNtfy` cooldowns are held IN-PROCESS, so an app
 * restart resets them and the next digest re-pages once. That errs toward one
 * extra page rather than a missed one, which is the correct direction here.
 */
const DECIDED_UNMAILED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

/** DR3 brand (CLAUDE.md hard rule #3 — GREEN + BLACK, never SVdP red). */
const DR3_GREEN_DEEP = '#00524c';
const DR3_GREEN = '#0b7a6e';
const INK = '#1a1a1a';
const MUTED = '#6b6b6b';
const HAIRLINE = '#e2e6e4';
const PAPER = '#f4f6f5';
const ALERT = '#8a1c1c';
const ALERT_BG = '#fdf1f1';

// ────────────────────────────────────────────────────────────────────────────
// Payload
// ────────────────────────────────────────────────────────────────────────────

/** One invoice row in the digest. */
export interface DigestItem {
  requestId: string;
  subject: string;
  vendor: string | null;
  amountCents: number | null;
  /** Pacific calendar days since `received_at`. The uniform age definition. */
  ageDays: number;
  /** Pacific wall-clock label for `received_at`. */
  receivedLabel: string;
  /**
   * Section-specific secondary fact: who owes the signature (second approval),
   * when the hold was placed, or when the escalation fired. Null when N/A.
   */
  detail: string | null;
  /** Tier-1 deep link to THIS request in the AP queue (ADR-0036 click policy). */
  url: string;
}

export interface ApMorningDigestPayload {
  /** Pacific day key the digest covers. */
  dayISO: string;
  /** `pending_second_approval`, each with who owes the signature. */
  pendingSecondApproval: DigestItem[];
  /** `pending` — nothing signed yet. */
  awaitingFirstApproval: DigestItem[];
  /** `pending_review` held for >= STALE_HOLD_DAYS. */
  staleHolds: DigestItem[];
  /** Escalations that fired since the previous digest. */
  escalations: DigestItem[];
  /**
   * ADR-0068 (Amendment 2) — reimbursements awaiting their SECOND signature.
   *
   * A separate section rather than merged into `pendingSecondApproval`, because
   * the two are not the same object and merging them would misreport both: a
   * reimbursement has no vendor and no `received_at`, it is aged from
   * `submitted_at`, and EVERY one needs two signatures where an invoice only does
   * at >= $1,000. Presenting them as one list would imply a threshold that does
   * not apply and a vendor that does not exist.
   */
  pendingReimbursements: DigestItem[];
  /**
   * ADR-0126 — decided with no evidence the notice ever reached accounting.
   *
   * Unlike every other section here this is not a WORK QUEUE — nobody needs to
   * approve these, the decision already stands. It is a DELIVERY FAILURE list, and
   * it stays in the digest every single morning until the row is cleared, because
   * the failure mode it closes is precisely a thing that was true for weeks while
   * no surface said so.
   */
  decidedUnmailed: DigestItem[];
  /** Routing-coverage + age warnings (and any resolver `problems`). */
  warnings: string[];
  /** True when any item is >= AGE_WARNING_DAYS old. Drives `importance: high`. */
  highPriority: boolean;
  /** Nothing to say at all — items AND warnings empty. Suppresses the send. */
  empty: boolean;
}

export type ApMorningDigestSkipReason =
  /** Weekend or fleet-wide holiday (§1.7 — weekdays only). */
  | 'not_business_day'
  /** No items and no warnings — suppressed entirely, no zero-state noise. */
  | 'nothing_to_report'
  /** No user has `notify_daily_digest` on (or the ones who do are unreachable). */
  | 'no_recipients'
  /** M365 unconfigured — `notifyStaff` fail-open no-op. */
  | 'mail_disabled';

export interface ApMorningDigestResult {
  sent: boolean;
  reason?: ApMorningDigestSkipReason;
  dayISO: string;
  highPriority: boolean;
  counts: {
    pendingSecondApproval: number;
    awaitingFirstApproval: number;
    staleHolds: number;
    escalations: number;
    /** ADR-0126 — decided rows with no confirmed decision email. */
    decidedUnmailed: number;
    warnings: number;
  };
  mode?: NotifyStaffMode;
  recipients?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Whole PACIFIC calendar days between two instants.
 *
 * ADR-0065: the app container runs UTC, so `(to - from) / 86_400_000` — or any
 * UTC day-boundary read — rolls the day at 4/5 PM Pacific. An invoice that
 * arrived at 6 PM Monday would read as 2 days old on Tuesday morning and would
 * trip the 3-day alarm a full day early. Both sites are Pacific; the day key is
 * the only correct boundary. `dayKeyUTCFromISO` turns each Pacific day key into
 * a UTC-midnight anchor, so the subtraction is exact whole days by construction.
 */
export function pacificCalendarDaysBetween(from: Date, to: Date): number {
  const a = dayKeyUTCFromISO(pacificDayISO(from)).getTime();
  const b = dayKeyUTCFromISO(pacificDayISO(to)).getTime();
  return Math.round((b - a) / 86_400_000);
}

function fmtAmount(cents: number | null): string | null {
  if (cents === null) return null;
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtAge(days: number): string {
  if (days <= 0) return 'today';
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * Start of the window for "escalations since the last digest": Pacific midnight
 * of the PREVIOUS business day.
 *
 * Why midnight rather than the previous 06:00 PT fire instant: this is built
 * ONLY from `pacificDayStartInstantPlus`, the ADR-0065 primitive that is already
 * DST-correct in both directions. Reconstructing "06:00 PT on some past Pacific
 * day" would mean new wall-clock arithmetic across the DST seam — the precise
 * thing §B.6 forbids — to buy a tighter window.
 *
 * The cost is that escalations that fired between midnight and 06:00 PT on the
 * previous business day appear in TWO consecutive digests. That is the correct
 * direction to be wrong in: a repeated line is noise, a dropped escalation is
 * the failure mode this whole ADR exists to eliminate.
 */
export async function escalationWindowStart(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<Date> {
  const earliest = pacificDayStartInstantPlus(-MAX_LOOKBACK_DAYS, now);
  const holidays = await fleetWideHolidays(db, pacificDayISO(earliest), pacificDayISO(now));
  for (let back = 1; back <= MAX_LOOKBACK_DAYS; back++) {
    const dayStart = pacificDayStartInstantPlus(-back, now);
    if (isBusinessDay(dayStart, holidays)) return dayStart;
  }
  // Unreachable in a real calendar (7 consecutive non-business days would mean
  // every site closed for a week) — but never return `now` and silently report
  // zero escalations.
  return earliest;
}

/** The columns every section reads. */
const ITEM_SELECT = {
  id: true,
  subject: true,
  vendor_freeform: true,
  vendor: true,
  confirmed_amount_cents: true,
  amount_cents: true,
  received_at: true,
  status: true,
  held_at: true,
  hold_note: true,
  first_approver_id: true,
  first_approved_at: true,
  escalated_at: true,
  // ADR-0126 — the decided-but-unmailed sweep needs both the decision instant (to
  // apply the anti-race grace) and the mail stamp (the thing that is missing).
  decided_at: true,
  decision_mail_sent_at: true,
} as const;

interface RequestRow {
  id: string;
  subject: string | null;
  vendor_freeform: string | null;
  vendor: string | null;
  confirmed_amount_cents: number | null;
  amount_cents: number | null;
  received_at: Date;
  status: string;
  held_at: Date | null;
  hold_note: string | null;
  first_approver_id: string | null;
  first_approved_at: Date | null;
  escalated_at: Date | null;
  decided_at: Date | null;
  decision_mail_sent_at: Date | null;
}

function toItem(row: RequestRow, now: Date, detail: string | null): DigestItem {
  return {
    requestId: row.id,
    subject: row.subject ?? '(no subject)',
    // The Amendment-5 structured column wins; `vendor` is the deprecated
    // pre-Amendment-5 value kept for rows decided before the migration.
    vendor: row.vendor_freeform ?? row.vendor,
    amountCents: row.confirmed_amount_cents ?? row.amount_cents,
    ageDays: pacificCalendarDaysBetween(row.received_at, now),
    receivedLabel: `${formatPacificDateTime(row.received_at)} PT`,
    detail,
    url: apRequestUrl(row.id),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Build
// ────────────────────────────────────────────────────────────────────────────

/**
 * Gather everything pending. Pure read — no writes, no sends, so it is safe to
 * call from a test or a future admin "preview" surface.
 */
export async function buildApMorningDigest(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<ApMorningDigestPayload> {
  const warnings: string[] = [];

  const [secondRows, pendingRows, holdRows] = await Promise.all([
    db.apRequest.findMany({
      where: { status: 'pending_second_approval' },
      select: ITEM_SELECT,
      orderBy: { received_at: 'asc' },
    }) as Promise<RequestRow[]>,
    db.apRequest.findMany({
      where: { status: 'pending' },
      select: ITEM_SELECT,
      orderBy: { received_at: 'asc' },
    }) as Promise<RequestRow[]>,
    db.apRequest.findMany({
      where: { status: 'pending_review' },
      select: ITEM_SELECT,
      orderBy: { received_at: 'asc' },
    }) as Promise<RequestRow[]>,
  ]);

  // ── 1. Pending second approval — WITH who owes the signature (§1.4 resolver).
  // One resolver call per row. The backlog is a handful of invoices by design
  // (ADR-0066 Check A found ZERO), so the N+1 is bounded and buys us the single
  // source of truth: re-deriving "who owes this" here is exactly the drift that
  // caused the outage.
  const pendingSecondApproval: DigestItem[] = [];
  for (const row of secondRows) {
    if (!row.first_approver_id) {
      warnings.push(
        `Invoice ${row.id} is in pending_second_approval with NO first approver recorded — nobody can be told who owes the signature.`,
      );
      pendingSecondApproval.push(toItem(row, now, 'Owed by: unknown (no first approver recorded)'));
      continue;
    }
    const routed = await resolveSecondApproval(db, {
      firstApproverId: row.first_approver_id,
      escalated: row.escalated_at != null,
    });
    // Label by OUTCOME, not by the recipient list alone. Escalation is ADDITIVE
    // (§1.5) — the routed peer stays able to sign and the fallback joins them —
    // so labelling an escalated row "(fallback)" would misreport who is still on
    // the hook. Only a genuine fallback outcome (no row / unreachable peer)
    // carries that word.
    const names = (rs: readonly { name: string }[]) => rs.map((r) => r.name).join(', ');
    let owed: string;
    if (routed.recipients.length === 0) {
      owed = 'nobody reachable';
    } else if (routed.outcome === 'escalated') {
      owed = `${names(routed.recipients)} (either may sign)`;
    } else if (routed.outcome === 'routed' && routed.routedTo) {
      owed = routed.routedTo.name;
    } else {
      owed = `${names(routed.recipients)} (fallback)`;
    }
    const waiting = row.first_approved_at
      ? ` · first-signed ${formatPacificDateTime(row.first_approved_at)} PT`
      : '';
    const escalated = row.escalated_at ? ' · ESCALATED' : '';
    pendingSecondApproval.push(toItem(row, now, `Owed by: ${owed}${waiting}${escalated}`));
    // Surface routing misconfiguration discovered while resolving a REAL row —
    // this is the digest half of the §B.5 alarm (§1.4: degrade loudly).
    for (const p of routed.problems) warnings.push(`Invoice ${row.id}: ${p}`);
  }

  // ── 2. No first approval yet.
  const awaitingFirstApproval = pendingRows.map((row) => toItem(row, now, null));

  // ── 3. Holds that have gone stale. A fresh hold is someone actively working
  // the invoice; only an ABANDONED one is oversight-worthy.
  const staleHolds = holdRows
    .filter(
      (row) =>
        row.held_at !== null && pacificCalendarDaysBetween(row.held_at, now) >= STALE_HOLD_DAYS,
    )
    .map((row) => {
      const heldDays = row.held_at ? pacificCalendarDaysBetween(row.held_at, now) : 0;
      const note = row.hold_note ? ` — "${row.hold_note}"` : '';
      return toItem(row, now, `On hold ${fmtAge(heldDays)}${note}`);
    });

  // ── 4. Escalations that fired since the previous digest.
  const windowStart = await escalationWindowStart(db, now);
  const escalatedRows = (await db.apRequest.findMany({
    where: { escalated_at: { gte: windowStart } },
    select: ITEM_SELECT,
    orderBy: { escalated_at: 'asc' },
  })) as RequestRow[];
  const escalations = escalatedRows.map((row) => {
    const when = row.escalated_at
      ? `${formatPacificDateTime(row.escalated_at)} PT`
      : 'unknown time';
    const resolved = row.status === 'pending_second_approval' ? '' : ` · now ${row.status}`;
    return toItem(row, now, `Escalated ${when}${resolved}`);
  });

  // ── W1. Routing coverage (§1.4 — "the table must be TOTAL").
  // Enumerate every ACTIVE approver-role user and diff against the active
  // routing rows. An approver with no row falls back to admin IMMEDIATELY, which
  // works but is not the separation-of-duties design — Bill must see it.
  const [approvers, routingRows] = await Promise.all([
    db.user.findMany({
      where: { role: { in: ['manager', 'admin'] }, is_active: true, deleted_at: null },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    db.apApprovalRouting.findMany({ where: { active: true }, select: { first_approver_id: true } }),
  ]);
  const routedIds = new Set(routingRows.map((r) => r.first_approver_id));
  const unrouted = approvers.filter((u) => !routedIds.has(u.id));
  if (unrouted.length > 0) {
    const one = unrouted.length === 1;
    const who = unrouted.map((u) => u.name).join(', ');
    warnings.push(
      `${unrouted.length} active approver${one ? '' : 's'} ${one ? 'has' : 'have'} no ` +
        `ap_approval_routing row: ${who}. Their first approvals fall back to an admin ` +
        `immediately (no 24h wait) instead of routing to a peer. Configure the pair at ` +
        `/admin/ap/routing.`,
    );
  }

  // ── W1b. A row that EXISTS but points at somebody unreachable.
  //
  // The §1.7 reasoning for reporting a MISSING pair over an empty queue —
  // "suppressing it would keep the misconfiguration invisible until an invoice
  // happened to arrive" — applies identically to a BROKEN pair, and originally
  // did not cover it. An `unreachable_second_approver` only surfaced as a
  // resolver `problems` entry while iterating real pending invoices, so an empty
  // queue suppressed it entirely: a routing row aimed at a deactivated peer (or
  // an email-less operator PIN account) stayed silent until the day it mattered.
  // That is the same real-misconfiguration-wearing-the-costume-of-silence shape.
  const routingDetail = await db.apApprovalRouting.findMany({
    where: { active: true },
    select: { first_approver_id: true, second_approver_id: true },
  });
  const brokenPairs: string[] = [];
  for (const r of routingDetail) {
    const peer = await db.user.findUnique({
      where: { id: r.second_approver_id },
      select: { name: true, email: true, role: true, is_active: true },
    });
    const reachable =
      !!peer &&
      peer.is_active &&
      !!peer.email &&
      (peer.role === 'manager' || peer.role === 'admin');
    if (!reachable) {
      const owner =
        approvers.find((u) => u.id === r.first_approver_id)?.name ?? r.first_approver_id;
      brokenPairs.push(`${owner} → ${peer?.name ?? r.second_approver_id}`);
    }
  }
  if (brokenPairs.length > 0) {
    warnings.push(
      `${brokenPairs.length} routing row${brokenPairs.length === 1 ? '' : 's'} point${brokenPairs.length === 1 ? 's' : ''} at an ` +
        `unreachable second approver (inactive, non-approver role, or no email address): ` +
        `${brokenPairs.join('; ')}. Those approvals silently fall back to an admin. ` +
        `Fix at /admin/ap/routing.`,
    );
  }

  // ── W2. The 3-day age line, which also raises the whole digest to high.
  const aged = [...pendingSecondApproval, ...awaitingFirstApproval, ...staleHolds].filter(
    (i) => i.ageDays >= AGE_WARNING_DAYS,
  );
  const highPriority = aged.length > 0;
  if (highPriority) {
    const oldest = aged.reduce((a, b) => (b.ageDays > a.ageDays ? b : a));
    warnings.push(
      `${aged.length} invoice${aged.length === 1 ? ' is' : 's are'} ${AGE_WARNING_DAYS}+ days old (oldest: ${fmtAge(
        oldest.ageDays,
      )}). This digest is marked high priority.`,
    );
  }

  // ── W3. Document ingestion is disconnected (ADR-0067 Amendment A §A.6).
  //
  // Bill's requirement is a line in the 06:00 digest UNTIL RESOLVED. This is a
  // one-line system-health WARNING, not the "future document-ingestion digest"
  // this module declines to absorb (§1.7) — that stays a separate email.
  //
  // It belongs in `warnings` specifically, because a warning sends even when the
  // AP queue is empty: a halted ingester produces no items, so an items-gated
  // line would be invisible exactly when it matters.
  const docIngestWarning = await docIngestReauthWarning(db, now);
  if (docIngestWarning) warnings.push(docIngestWarning);

  // ── ADR-0080 — discovery is not silently under-reporting ──────────────────
  // Rides the same `warnings` slot, and for the same reason: a discovery gap
  // produces no AP items, so an items-gated line would be invisible precisely
  // when documents are going unwatched. It also speaks up when the check has
  // never run or could not run — "we did not look" is a warning, not silence.
  const docDiscoveryWarning = await docIngestDiscoveryGapWarning(db, now);
  if (docDiscoveryWarning) warnings.push(docDiscoveryWarning);

  // ── ADR-0068 (Amendment 2) — reimbursements awaiting a second signature ────
  //
  // §1.7's scope rule is that this digest is a FULL-QUEUE oversight tool, so
  // anything awaiting a signature belongs in it. Reimbursements were specified for
  // inclusion and shipped without it, which meant a reimbursement could sit on one
  // person's desk and appear in no oversight surface Bill reads.
  //
  // Aged from `submitted_at`, because submission IS the first signature (D2) —
  // there is no `received_at` and no forwarder. Site is carried in `vendor` (the
  // renderer's leading fact slot) since a reimbursement has no vendor; the
  // beneficiary and the person who owes the signature go in `detail`.
  const pendingReimbursements: DigestItem[] = [];
  const reimbRows = await db.reimbursementRequest.findMany({
    where: { status: 'pending_second_approval' },
    select: {
      id: true,
      amount_cents: true,
      submitted_at: true,
      escalated_at: true,
      employee_name_freeform: true,
      employee_user: { select: { name: true } },
      submitter: { select: { name: true } },
      routed_to: { select: { name: true } },
      site: { select: { code: true, name: true } },
    },
    orderBy: { submitted_at: 'asc' },
  });
  for (const r of reimbRows) {
    const beneficiary = r.employee_user?.name ?? r.employee_name_freeform ?? '(unnamed)';
    const escalated = r.escalated_at ? ' — ESCALATED' : '';
    pendingReimbursements.push({
      requestId: r.id,
      subject: `Reimbursement for ${beneficiary}`,
      vendor: r.site.name,
      amountCents: r.amount_cents,
      ageDays: pacificCalendarDaysBetween(r.submitted_at, now),
      receivedLabel: `${formatPacificDateTime(r.submitted_at)} PT`,
      detail: `submitted by ${r.submitter.name}, waiting on ${r.routed_to.name}${escalated}`,
      url: reimbursementUrl(r.site.code),
    });
  }

  // ── ADR-0126. Decided, but nobody was told ─────────────────────────────────
  //
  // The backstop for the whole decision-mail path. `sendDecisionEmail` can return
  // without stamping `decision_mail_sent_at` in at least five ways (no recipients,
  // an oversize refusal, transport failure, M365 disabled, or a crash between the
  // decide commit and the send) and all five look identical from outside: a
  // decided row, and an accounting inbox that never received anything. Two real
  // rejections sat in exactly that state for weeks in July/August 2026.
  //
  // Detecting the STATE rather than any one cause is the point — this catches the
  // failure paths nobody has thought of yet, including ones added after today.
  //
  // Rides `warnings` as well as its own section for the ADR-0067/ADR-0080 reason:
  // a warning sends even when the queue is empty, and an all-quiet queue is the
  // most likely condition under which an unmailed decision would otherwise sit
  // invisible — nothing pending means nothing else would have sent the digest.
  const unmailedRows = (await db.apRequest.findMany({
    where: decisionMailUnsentWhere(),
    select: ITEM_SELECT,
    orderBy: { received_at: 'asc' },
  })) as RequestRow[];
  const decidedUnmailed = unmailedRows
    .filter((row) => isDecisionMailStuck(row, now))
    .map((row) => {
      const decidedLabel = row.decided_at
        ? `${formatPacificDateTime(row.decided_at)} PT`
        : 'an unrecorded time';
      const since = row.decided_at ? pacificCalendarDaysBetween(row.decided_at, now) : null;
      const waited = since === null ? '' : ` · ${fmtAge(since)} ago`;
      return toItem(
        row,
        now,
        `Decided ${row.status.toUpperCase()} ${decidedLabel}${waited} — NO decision email confirmed sent`,
      );
    });
  if (decidedUnmailed.length > 0) {
    const one = decidedUnmailed.length === 1;
    warnings.push(
      `${decidedUnmailed.length} decided invoice${one ? '' : 's'} ${one ? 'has' : 'have'} NO confirmed ` +
        `decision email: accounting was never told. The decision${one ? '' : 's'} stand${one ? 's' : ''} ` +
        `and the stamped original is archived in Vision — open the AP queue to re-send. ` +
        `This line stays here every morning until the mail is confirmed sent.`,
    );
  }

  // A reimbursement 3+ days old raises the whole digest, same bar as an invoice.
  const agedReimbursements = pendingReimbursements.filter((i) => i.ageDays >= AGE_WARNING_DAYS);
  // ADR-0126 — an unmailed decision raises the digest on its own, at any age. The
  // 3-day bar exists because a pending invoice is merely SLOW; an undelivered
  // decision is already broken, and waiting three days to say so out loud would
  // reproduce a third of the original incident.
  const anyHigh = highPriority || agedReimbursements.length > 0 || decidedUnmailed.length > 0;
  if (agedReimbursements.length > 0) {
    const oldestR = agedReimbursements.reduce((a, b) => (b.ageDays > a.ageDays ? b : a));
    warnings.push(
      `${agedReimbursements.length} reimbursement${
        agedReimbursements.length === 1 ? ' has' : 's have'
      } been waiting ${AGE_WARNING_DAYS}+ days for a second signature (oldest: ${fmtAge(
        oldestR.ageDays,
      )}). Somebody is owed money.`,
    );
  }

  const empty =
    pendingSecondApproval.length === 0 &&
    awaitingFirstApproval.length === 0 &&
    staleHolds.length === 0 &&
    escalations.length === 0 &&
    pendingReimbursements.length === 0 &&
    decidedUnmailed.length === 0 &&
    warnings.length === 0;

  return {
    dayISO: pacificDayISO(now),
    pendingSecondApproval,
    awaitingFirstApproval,
    staleHolds,
    escalations,
    pendingReimbursements,
    decidedUnmailed,
    warnings,
    highPriority: anyHigh,
    empty,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Render
// ────────────────────────────────────────────────────────────────────────────

function renderItem(item: DigestItem): string {
  const amount = fmtAmount(item.amountCents);
  const bits: string[] = [];
  if (item.vendor) bits.push(escapeHtml(item.vendor));
  if (amount) bits.push(escapeHtml(amount));
  bits.push(`received ${escapeHtml(item.receivedLabel)}`);
  const ageColor = item.ageDays >= AGE_WARNING_DAYS ? ALERT : MUTED;
  const ageWeight = item.ageDays >= AGE_WARNING_DAYS ? '700' : '400';
  return `<tr><td style="padding:10px 0;border-bottom:1px solid ${HAIRLINE}">
    <div style="font:600 14px/1.35 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">
      <a href="${item.url}" style="color:${DR3_GREEN_DEEP};text-decoration:none">${escapeHtml(item.subject)}</a>
    </div>
    <div style="font:400 12px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};padding-top:3px">${bits.join(' &middot; ')}</div>
    ${
      item.detail
        ? `<div style="font:400 12px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK};padding-top:3px">${escapeHtml(item.detail)}</div>`
        : ''
    }
    <div style="font:${ageWeight} 12px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${ageColor};padding-top:3px">Age: ${escapeHtml(fmtAge(item.ageDays))}</div>
  </td></tr>`;
}

function renderSection(title: string, items: readonly DigestItem[]): string {
  if (items.length === 0) return '';
  return `<div style="padding-top:22px">
    <div style="font:700 11px/1 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${DR3_GREEN};text-transform:uppercase;letter-spacing:0.07em;padding-bottom:4px">${escapeHtml(title)} (${items.length})</div>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">${items.map(renderItem).join('')}</table>
  </div>`;
}

function renderWarnings(warnings: readonly string[]): string {
  if (warnings.length === 0) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:20px;background:${ALERT_BG};border-left:4px solid ${ALERT};border-radius:4px">
    <tr><td style="padding:12px 16px">
      <div style="font:700 11px/1 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${ALERT};text-transform:uppercase;letter-spacing:0.07em;padding-bottom:6px">Needs attention</div>
      <ul style="margin:0;padding-left:18px;font:400 13px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">
        ${warnings.map((w) => `<li style="padding-bottom:4px">${escapeHtml(w)}</li>`).join('')}
      </ul>
    </td></tr>
  </table>`;
}

/** The digest email body. Pure — takes a payload, returns HTML. */
export function renderApMorningDigestHtml(payload: ApMorningDigestPayload): string {
  const total =
    payload.pendingSecondApproval.length +
    payload.awaitingFirstApproval.length +
    payload.staleHolds.length;
  return `<!doctype html><html><body style="margin:0;padding:0;background:${PAPER}">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${PAPER}">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" cellpadding="0" cellspacing="0" width="640" style="width:640px;max-width:100%;background:#ffffff;border-radius:8px;overflow:hidden">
        <tr><td style="background:${DR3_GREEN_DEEP};padding:18px 24px">
          <div style="color:#ffffff;font:700 17px/1.25 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif">AP morning digest</div>
          <div style="color:#c9e3df;font:400 13px/1.4 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;padding-top:2px">${escapeHtml(payload.dayISO)} &middot; ${total} invoice${total === 1 ? '' : 's'} pending${payload.highPriority ? ' &middot; ACTION NEEDED' : ''}</div>
        </td></tr>
        <tr><td style="padding:18px 24px 26px">
          ${renderWarnings(payload.warnings)}
          ${renderSection('Awaiting second approval', payload.pendingSecondApproval)}
          ${renderSection('Awaiting first approval', payload.awaitingFirstApproval)}
          ${renderSection(`On hold ${STALE_HOLD_DAYS}+ days`, payload.staleHolds)}
          ${renderSection('Escalated since the last digest', payload.escalations)}
          ${renderSection('Reimbursements awaiting a second signature', payload.pendingReimbursements)}
          ${renderSection('DECIDED — but no decision email confirmed sent', payload.decidedUnmailed)}
          <p style="font:400 12px/1.55 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${MUTED};margin:24px 0 0;border-top:1px solid ${HAIRLINE};padding-top:14px">
            Oversight only — the team works the live queue at
            <a href="${apQueueUrl()}" style="color:${DR3_GREEN_DEEP}">the AP approval queue</a>.
            All times are Pacific. Sent weekdays at 06:00 PT; suppressed entirely when there is nothing pending.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
  </body></html>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Send
// ────────────────────────────────────────────────────────────────────────────

export interface RunApMorningDigestArgs {
  db?: PrismaClient;
  now?: Date;
}

/**
 * The 06:00 PT weekday fire. The cron daemon fires DAILY and THIS decides
 * whether to send — same split as the board-pack digest, so the weekday/holiday
 * calendar lives in the app (with the DB it needs) and never in a shell cron.
 *
 * Idempotent in the only sense that matters here: it writes nothing and holds no
 * ledger, so a container restart that re-fires simply re-reads the same queue and
 * sends the same read-only digest. There is no state to corrupt and nothing that
 * a double-send could mis-record — a second copy of an oversight email is
 * strictly better than a ledger that suppresses a real one.
 */
export async function runApMorningDigest(
  args: RunApMorningDigestArgs = {},
): Promise<ApMorningDigestResult> {
  const db = args.db ?? prisma;
  const now = args.now ?? new Date();
  const dayISO = pacificDayISO(now);
  const emptyCounts = {
    pendingSecondApproval: 0,
    awaitingFirstApproval: 0,
    staleHolds: 0,
    escalations: 0,
    decidedUnmailed: 0,
    warnings: 0,
  };

  // §1.7 — weekdays only. The SHARED clock (§1.5), never a second calendar.
  if (!(await isBusinessDayNow(db, now))) {
    log.info({ dayISO }, '[ap-morning-digest] not a business day — no send');
    return {
      sent: false,
      reason: 'not_business_day',
      dayISO,
      highPriority: false,
      counts: emptyCounts,
    };
  }

  const payload = await buildApMorningDigest(db, now);
  const counts = {
    pendingSecondApproval: payload.pendingSecondApproval.length,
    awaitingFirstApproval: payload.awaitingFirstApproval.length,
    staleHolds: payload.staleHolds.length,
    escalations: payload.escalations.length,
    decidedUnmailed: payload.decidedUnmailed.length,
    warnings: payload.warnings.length,
  };

  // ── ADR-0126 — page BEFORE the send decisions below ────────────────────────
  //
  // Placed here deliberately, ahead of both the no-recipients return and the
  // mail-disabled return. The two failure modes are independent, and the one that
  // most plausibly co-occurs with an unmailed decision is precisely a mail outage
  // — the same broken credentials that stopped the decision email would stop the
  // digest reporting it. Publishing first means the alarm does not depend on the
  // channel it is reporting on.
  //
  // Fail-soft (`.catch`), like every other publish in the AP module: an alerting
  // failure must never abort the digest that is the durable surface for this.
  if (payload.decidedUnmailed.length > 0) {
    const ids = payload.decidedUnmailed.map((i) => i.requestId);
    const one = ids.length === 1;
    log.error(
      { dayISO, count: ids.length, requestIds: ids },
      '[ap-morning-digest] decided requests have no confirmed decision email — accounting was never told',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: `AP decision email never confirmed sent (${ids.length})`,
      // ADR-0045 — row ids only; never vendor or amount in a page body.
      body: `${ids.length} decided AP request${one ? '' : 's'} ${one ? 'has' : 'have'} no confirmed decision email, so accounting was never notified. Request id${one ? '' : 's'}: ${ids.join(', ')}. The decision${one ? '' : 's'} stand and the stamped originals are archived — open the AP queue to re-send.`,
      priority: 'high',
      tags: ['warning', 'ap', 'decision-mail', 'dr3-vision'],
      // ADR-0036 click policy: tier-1 deep link when there is exactly one row to
      // land on, tier-2 queue when the page describes several.
      clickUrl: one ? apRequestUrl(ids[0]!) : apQueueUrl(),
      // Keyed on the SET of stuck ids: the same backlog stays suppressed for a
      // week, a NEW stuck decision changes the key and pages the same morning.
      fingerprint: decisionMailStuckFingerprint(ids),
      cooldownMs: DECIDED_UNMAILED_COOLDOWN_MS,
    }).catch(() => undefined);
  }

  // §1.7 — SUPPRESSED ENTIRELY when there is nothing to report.
  if (payload.empty) {
    log.info({ dayISO }, '[ap-morning-digest] nothing pending — digest suppressed');
    return { sent: false, reason: 'nothing_to_report', dayISO, highPriority: false, counts };
  }

  // Audience by PREF, never by hardcoded address (§1.6 / §1.7).
  const audience = await dailyDigestRecipients(db);
  if (audience.length === 0) {
    // ⚠ A `log.warn` is NOT loud. This is the backstop's own failure mode, and it
    // was the same fail-soft-over-an-empty-recipient-set shape the ADR exists to
    // eliminate — in the component built to detect it.
    //
    // It compounds: the digest is the mitigation of last resort for a missing
    // routing pair, a pref-silenced approver, and a latched-but-unsent
    // escalation. If the digest itself goes quiet, every one of those loses its
    // safety net simultaneously and nothing anywhere says so.
    //
    // `notify_daily_digest` defaults to FALSE, so a deleted prefs row, a
    // deactivated account, or one toggle at /admin/ap/notifications is enough to
    // reach here. Page it.
    log.error(
      { dayISO, ...counts },
      '[ap-morning-digest] no user has notify_daily_digest enabled — the AP oversight digest has nobody to go to',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'AP morning digest has no recipients',
      body: `No user has notify_daily_digest enabled, so the ${dayISO} AP oversight digest was not sent. Pending second approvals and routing warnings are going unreported. Re-enable at /admin/ap/notifications.`,
      priority: 'high',
      tags: ['warning', 'ap', 'digest', 'dr3-vision'],
      fingerprint: 'ap-digest-no-recipients',
      cooldownMs: 12 * 60 * 60 * 1000, // daily cadence — page once, not per retry
    }).catch(() => undefined);
    return {
      sent: false,
      reason: 'no_recipients',
      dayISO,
      highPriority: payload.highPriority,
      counts,
    };
  }

  const subject = `${payload.highPriority ? 'ACTION NEEDED — ' : ''}DR3-Vision AP morning digest — ${dayISO}`;
  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients: audience.map((u) => ({ address: u.email, name: u.name })),
    subject,
    htmlBody: renderApMorningDigestHtml(payload),
    fromDisplayName: 'DR3-Vision AP',
    ...(payload.highPriority ? { importance: 'high' as const } : {}),
    db,
  });

  if (notified.disabled) {
    log.warn({ dayISO }, '[ap-morning-digest] M365 disabled — digest not delivered');
    return {
      sent: false,
      reason: 'mail_disabled',
      dayISO,
      highPriority: payload.highPriority,
      counts,
      mode: notified.mode,
      recipients: notified.intendedRecipients.length,
    };
  }

  log.info(
    { dayISO, mode: notified.mode, delivered: notified.delivered, ...counts },
    '[ap-morning-digest] digest sent',
  );
  return {
    sent: true,
    dayISO,
    highPriority: payload.highPriority,
    counts,
    mode: notified.mode,
    recipients: notified.intendedRecipients.length,
  };
}
