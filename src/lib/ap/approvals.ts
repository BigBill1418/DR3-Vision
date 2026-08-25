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
import type { ApVarianceFlagState } from './extraction/types';
// ADR-0066 §1.4 — `activeSecondApproversForSite` and `secondApproverSiteLabel` are
// deliberately NO LONGER imported here. The site-roster lookup is what returned an
// empty recipient set for Woodland, and the site label became misleading once
// routing stopped depending on the site. Both remain exported from
// `second-approval-routing` for the deprecated roster surface only.
import { requiresSecondApproval } from './second-approval-routing';
import {
  notifySecondApprovalNeeded,
  reportSecondApprovalRoutingProblem,
  notifyEquipmentRequestCreated,
} from './notify';
// Amendment 9 (§2.2–§2.4) — the equipment escape hatch.
import { createEquipmentRequestInTx, equipmentRequestRecipients } from './equipment-requests';
// ADR-0066 §1.4/§1.6 — the shared resolver and the per-user pref filter.
import { resolveSecondApproval } from './second-approval-resolver';
import { filterBySecondApprovalPref } from './notification-prefs';
import { recordVisionApproval } from './baselines';
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
 * ADR-0046 Amendment 3 — a rejection MUST carry a note explaining why. Extended by
 * the 2026-07-21 amendment: an APPROVAL must also carry a note describing what the
 * transaction was for + any additional context (audit trail of transaction purpose).
 * Plain-English validation, enforced at the API boundary. Also thrown for a hold /
 * hold-note-update with no note, and for a NOT-DR3 decision with no reason. Kept out
 * of `decideRequest` itself so the pure lib race-tests can decide without a note.
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
 * Enforce "every decision must carry a note" at the decision boundary (2026-07-21
 * amendment; previously approvals were note-optional). BOTH paths require a non-empty
 * (trimmed) note — same minimum — with a purpose-specific message: an approval must
 * describe what the transaction was for + context (audit trail of transaction
 * purpose); a rejection must say why. Throws {@link ApNoteRequiredError} when absent.
 */
export function assertDecisionNote(decision: ApDecision, note: string | undefined | null): void {
  if (hasNote(note)) return;
  throw new ApNoteRequiredError(
    decision === 'approved'
      ? 'An approval must include a note describing what this transaction was for and any additional context.'
      : 'A rejection must include a note explaining why the invoice was rejected.',
  );
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

export type ApMailOutcome =
  | 'sent'
  | 'refused_no_recipients'
  | 'disabled'
  | 'failed'
  // ADR-0046 Amendment 5 (D-M5-3) — a >= $1,000 Approve moved to
  // `pending_second_approval` instead of terminating; NO decision email is sent yet
  // (it fires only on the final approved/rejected state). The second approver was
  // paged/emailed via `notifySecondApprovalNeeded` instead.
  | 'second_approval_pending'
  // The stamped original(s) exceeded the SENDING MAILBOX's per-message limit, so
  // NOTHING was sent — distinct from `failed`, where a request was made and
  // rejected. A retry cannot fix it; the invoice has to be shrunk or fetched from
  // Vision instead. Kept separate precisely so accounting is not told "we tried"
  // about a mail that was never posted.
  //
  // ADR-0114 moved this ceiling a long way out: it used to trip at Graph's 3 MB
  // inline-request limit (which is what stranded acb03895), and now trips only at
  // the mailbox transport limit — 35 MB by default. This outcome should be rare
  // rather than routine, but it is deliberately NOT deleted: a limit still exists,
  // and a refusal that has nowhere to be reported is how the original silence
  // happened.
  | 'too_large';

export interface DecideResult {
  requestId: string;
  decision: ApDecision;
  mail: ApMailOutcome;
  /** D-M5-3 — true when a >= $1,000 Approve routed to `pending_second_approval`
   * rather than terminating. The UI branches on this before reading `mail`. */
  secondApprovalPending?: boolean;
  /** D-M5-3 — the routed second approver label (e.g. "Eugene (Shannon Rockwell)")
   * for the first approver's confirmation message. */
  secondApproverLabel?: string;
}

export interface DecideArgs {
  prisma?: PrismaClient;
  requestId: string;
  decision: ApDecision;
  actorUserId: string;
  note?: string;
  vendor?: string; // optional, keyed at decision (C9-D5)
  amountCents?: number; // optional
  /** REQUIRED for a DR3-site decision (operator directive 2026-07-15; was optional
   * under the §3 amendment) — the RESOLVED site id the decision files against.
   * Mutually exclusive with `filedNotDr3` (a decision is EITHER a real site OR
   * NOT-DR3, never both). */
  siteId?: string;
  /** ADR-0046 amendment (2026-07-20) — the "NOT DR3 — See Reason" disposition: the
   * invoice is NOT for a DR3 location at all. When true, `note` (the reason) is
   * REQUIRED, `siteId` MUST be absent, and the row is persisted with site_id NULL +
   * filed_not_dr3 true — never filed against a real site's books. */
  filedNotDr3?: boolean;
  // ─── ADR-0046 Amendment 5 (D-M5-1/4/6) — structured Approve. Present ONLY on the
  // structured Approve path (real-site approve); Reject / NOT-DR3 keep the single
  // `note`/`vendor`/`amountCents` fields above. When `vendorFreeform` is set the
  // decide write persists the structured columns and STOPS writing the deprecated
  // `vendor`/`amount_cents` (hard rule #1 — columns kept, no longer written).
  /** D-M5-1 — approver-typed vendor (replaces the deprecated `vendor` at decide). */
  vendorFreeform?: string;
  /** D-M5-1 — Approve's transaction explanation (replaces `decision_note` on Approve). */
  explanation?: string;
  /** D-M5-1 — approver-confirmed amount (replaces the deprecated `amount_cents`). */
  confirmedAmountCents?: number;
  /** D-M5-6 — equipment linkage written to ap_equipment_links, atomically with the
   * decision. Exactly ONE of a non-empty `equipmentIds`, `notEquipmentRelated`, or
   * `equipmentRequestDescription` (validated at the route boundary; the DB CHECK
   * `ap_equipment_links_exactly_one_disposition` is the backstop).
   *
   * Amendment 9 (§2.2) — `equipmentRequestDescription` is the ESCAPE HATCH: the
   * asset is not in the registry, so the approver describes it. That writes an
   * `ap_equipment_requests` row + a link pointing at it, in this same transaction. */
  equipmentLinks?: {
    equipmentIds: readonly string[];
    notEquipmentRelated: boolean;
    equipmentRequestDescription?: string;
  };
  /** D-M5-4 — variance flag state to stamp on the row. `acknowledged` is only ever
   * passed after the route enforced an explicit acknowledgment of an above-threshold
   * trip; a tripped-but-unacknowledged decision never reaches here. */
  varianceFlagState?: ApVarianceFlagState;
  /** D-M5-4 — approver who acknowledged the variance (set iff state=acknowledged). */
  varianceAcknowledgedBy?: string;
  /** D-M5-4 — optional additional acknowledgment note. */
  varianceAcknowledgmentNote?: string;
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
 * ADR-0046 amendment (2026-07-20) — a decision may tag a real DR3 site OR be marked
 * NOT DR3, but NEVER both. Thrown when a request carries both a site tag and
 * filed_not_dr3=true (the location invariant's "never both" half; the "never
 * neither" half is enforced by assertDecisionSite / the NOT-DR3 reason guard).
 */
export class ApLocationConflictError extends Error {
  readonly status = 400 as const;
  constructor() {
    super(
      'A decision is filed against a DR3 site OR marked NOT DR3 — never both. Pick one location.',
    );
    this.name = 'ApLocationConflictError';
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
  // Location invariant — EXACTLY ONE of a real DR3 site tag OR the NOT-DR3
  // disposition, validated BEFORE any read/state change (mirrors the reject-note +
  // site boundaries). NOT-DR3 (2026-07-20) requires a reason (`note`) and forbids a
  // site; otherwise a site tag is required (operator directive 2026-07-15).
  if (args.filedNotDr3) {
    if (args.siteId && args.siteId.trim()) throw new ApLocationConflictError();
    if (!hasNote(args.note)) {
      throw new ApNoteRequiredError(
        'A NOT DR3 decision must include a reason explaining why this invoice is not for a DR3 site.',
      );
    }
  } else {
    assertDecisionSite(args.siteId);
  }
  const row = await prisma.apRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true,
      status: true,
      subject: true,
      decided_by: true,
      decided_at: true,
      received_at: true,
    },
  });
  if (!row) throw new ApRequestNotFoundError(args.requestId);
  if (row.status === 'quarantined') throw new ApNotActionableError('quarantined');

  const priorStatus = row.status;
  const decidedAt = new Date();
  // Atomic conditional transition + winning audit in ONE transaction (M2): the
  // flip and its audit row commit together, so a crash/throw between them can
  // never leave a live-but-UNAUDITED decision (the module's "both attempts
  // audited" contract held only if the process survived the gap). Only flips a
  // row still in an actionable state (pending OR on-hold pending_review). First
  // action wins; a row already decided (or racing) matches nothing → count 0 →
  // ApAlreadyDecidedError below. The loser path mutated nothing, so it needs no
  // transaction.
  // ADR-0046 Amendment 5 (D-M5-1) — the STRUCTURED Approve write. When the route
  // supplies `vendorFreeform` the decision persists the structured columns and does
  // NOT write the deprecated `vendor`/`amount_cents` (hard rule #1: kept, unwritten).
  // The single-note fields stay the path for Reject / NOT-DR3.
  const structured = typeof args.vendorFreeform === 'string';
  // ADR-0046 Amendment 5 (D-M5-3) — a structured Approve whose confirmed amount is
  // >= $1,000 does NOT terminate at `approved`: it moves to `pending_second_approval`
  // and stamps the FIRST approver (not decided_by/decided_at — those belong to the
  // terminal second decision). NOT-DR3 and every Reject are unaffected. Sub-$1K
  // Approves keep the single-action first-action-wins contract.
  const secondApprovalNeeded =
    structured &&
    args.decision === 'approved' &&
    !args.filedNotDr3 &&
    requiresSecondApproval(args.confirmedAmountCents);
  const targetStatus = secondApprovalNeeded ? 'pending_second_approval' : args.decision;
  // Amendment 9 (§2.4) — set inside the tx when the approver used the escape hatch;
  // read AFTER commit to fire the site-manager email. Declared out here because the
  // notification is deliberately OUTSIDE the transaction (fail-soft: a mail failure
  // must never roll back a committed decision).
  let equipmentRequestId: string | null = null;
  const res = await prisma.$transaction(async (tx) => {
    const r = await tx.apRequest.updateMany({
      where: { id: args.requestId, status: { in: [...ACTIONABLE_STATUSES] } },
      data: {
        status: targetStatus,
        // Terminal decisions stamp decided_by/decided_at now; the second-approval hop
        // instead stamps the FIRST approver and leaves the terminal actor to the
        // second-approval leg.
        ...(secondApprovalNeeded
          ? { first_approver_id: args.actorUserId, first_approved_at: decidedAt }
          : { decided_by: args.actorUserId, decided_at: decidedAt }),
        // Structured Approve → explanation + vendor_freeform + confirmed_amount_cents
        // + variance state (each field explicit `| null` to satisfy exactOptional);
        // otherwise the legacy single-note / deprecated columns.
        ...(structured
          ? {
              vendor_freeform: args.vendorFreeform ?? null,
              explanation: args.explanation ?? null,
              confirmed_amount_cents:
                typeof args.confirmedAmountCents === 'number' ? args.confirmedAmountCents : null,
              variance_flag_state: args.varianceFlagState ?? 'not_applicable',
              variance_acknowledged_by:
                args.varianceFlagState === 'acknowledged'
                  ? (args.varianceAcknowledgedBy ?? args.actorUserId)
                  : null,
              variance_acknowledged_at:
                args.varianceFlagState === 'acknowledged' ? decidedAt : null,
              variance_acknowledgment_note:
                args.varianceFlagState === 'acknowledged'
                  ? (args.varianceAcknowledgmentNote ?? null)
                  : null,
            }
          : {
              // Reject / Hold / NOT-DR3 keep ONLY their single reason (decision_note).
              // Hard rule #1: the deprecated `vendor` / `amount_cents` columns are
              // WRITE-STOPPED at decide on EVERY path (kept for historical data, no
              // longer written) — Approve writes vendor_freeform / confirmed_amount_cents
              // instead, and a non-structured decision writes neither. `args.vendor` /
              // `args.amountCents` may still arrive from the client but are not persisted.
              ...(args.note ? { decision_note: args.note } : {}),
            }),
        // Location: NOT-DR3 clears site_id and sets the marker (never both); a
        // normal decision files the resolved site (guaranteed present by
        // assertDecisionSite above — the conditional keeps exactOptional happy).
        ...(args.filedNotDr3
          ? { filed_not_dr3: true, site_id: null }
          : args.siteId
            ? { site_id: args.siteId }
            : {}),
      },
    });
    if (r.count > 0 && args.equipmentLinks) {
      // D-M5-6 — write the equipment linkage in the SAME transaction as the flip:
      // one row per selected asset, OR a single is_not_equipment_related row for the
      // explicit-none case. A committed decision always carries its equipment record.
      //
      // Amendment 9 (§2.2/§2.3) — or a single ESCAPE-HATCH row: the request and its
      // link are written here too, so a filed request can never outlive a decision
      // that rolled back (and vice versa). Same transaction, same guarantee.
      const { equipmentIds, notEquipmentRelated, equipmentRequestDescription } =
        args.equipmentLinks;
      if (equipmentRequestDescription && args.siteId) {
        equipmentRequestId = await createEquipmentRequestInTx(tx, {
          apRequestId: args.requestId,
          siteId: args.siteId,
          description: equipmentRequestDescription,
          requestedBy: args.actorUserId,
        });
      } else if (notEquipmentRelated) {
        await tx.apEquipmentLink.create({
          data: { request_id: args.requestId, is_not_equipment_related: true },
        });
      } else {
        for (const equipmentId of equipmentIds) {
          await tx.apEquipmentLink.create({
            data: { request_id: args.requestId, equipment_id: equipmentId },
          });
        }
      }
    }
    // D-M5-4 — feed a `vision_approval` history row on every TERMINAL approved
    // decision (sub-$1K structured Approve; the >= $1K path terminates in
    // decideSecondApproval, which feeds there). Kept in the SAME tx as the flip so
    // the approval + its baseline row commit together. Guarded to a structured
    // Approve with a real site; recordVisionApproval itself no-ops on a blank
    // vendor / non-finite amount so it can never wedge the approval.
    if (r.count > 0 && targetStatus === 'approved' && structured && args.siteId) {
      await recordVisionApproval(tx, {
        vendorFreeform: args.vendorFreeform ?? '',
        confirmedAmountCents:
          typeof args.confirmedAmountCents === 'number' ? args.confirmedAmountCents : Number.NaN,
        siteId: args.siteId,
        invoiceDate: row.received_at,
        actorUserId: args.actorUserId,
      });
    }
    if (r.count > 0) {
      // Won — audit the winning transition in the SAME tx (both-attempts-audited).
      await writeAudit(
        {
          actor_user_id: args.actorUserId,
          action: 'update',
          table_name: TABLE,
          row_id: args.requestId,
          before: { status: priorStatus },
          after: {
            attempted: args.decision,
            outcome: 'won',
            status: targetStatus,
            // D-M5-3 — a >= $1,000 Approve routed to second approval (not terminal).
            second_approval_pending: secondApprovalNeeded,
            from_hold: priorStatus === 'pending_review',
            structured,
            has_note: structured ? !!args.explanation : !!args.note,
            has_vendor: structured ? !!args.vendorFreeform : !!args.vendor,
            has_amount: structured
              ? typeof args.confirmedAmountCents === 'number'
              : typeof args.amountCents === 'number',
            has_site: !!args.siteId,
            filed_not_dr3: !!args.filedNotDr3,
            ...(structured
              ? {
                  variance_flag_state: args.varianceFlagState ?? 'not_applicable',
                  equipment: args.equipmentLinks
                    ? // Amendment 9 — the hatch is its own audited disposition; it must
                      // never read as `0 equipment` (indistinguishable from a bug).
                      args.equipmentLinks.equipmentRequestDescription
                      ? 'equipment_request'
                      : args.equipmentLinks.notEquipmentRelated
                        ? 'not_equipment_related'
                        : args.equipmentLinks.equipmentIds.length
                    : null,
                }
              : {}),
          },
        },
        { tx },
      );
    }
    return r;
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

  // Amendment 9 (§2.4) — the approver used the equipment ESCAPE HATCH; tell the
  // site managers there is an asset to add. Placed here, BEFORE the second-approval
  // branch returns, so it fires on both the sub-$1K terminal Approve and the >= $1K
  // hop — the registry gap is real either way and waiting on a second signature to
  // report it just delays the fix. Fully fail-soft: the request row is already
  // committed and visible on the worklist, so a mail failure loses nothing.
  if (equipmentRequestId && args.siteId) {
    await notifyEquipmentRequest(prisma, {
      equipmentRequestId,
      apRequestId: args.requestId,
      siteId: args.siteId,
      actorUserId: args.actorUserId,
      description: args.equipmentLinks?.equipmentRequestDescription ?? '',
      vendor: args.vendorFreeform ?? null,
      amountCents: typeof args.confirmedAmountCents === 'number' ? args.confirmedAmountCents : null,
    }).catch(() => undefined);
  }

  // D-M5-3 — a >= $1,000 Approve is now AWAITING second approval, NOT terminal. No
  // decision email fires yet (it only fires on the final approved/rejected state);
  // instead page + email the site-appropriate second approver. Fail-soft: a routing
  // notification failure never rolls back the (committed) first approval.
  if (secondApprovalNeeded && args.siteId) {
    const siteCode =
      (await prisma.site.findUnique({ where: { id: args.siteId }, select: { code: true } }))
        ?.code ?? '';
    // ADR-0066 §1.4 — routing is person→person now, resolved by the SAME shared
    // function the authorization check uses. The old site-roster lookup
    // (`activeSecondApproversForSite`) is what returned EMPTY for Woodland and
    // silently notified nobody; it is no longer read from this path.
    const routed = await resolveSecondApproval(prisma, {
      firstApproverId: args.actorUserId,
    }).catch(() => null);

    const subject =
      (
        await prisma.apRequest.findUnique({
          where: { id: args.requestId },
          select: { subject: true },
        })
      )?.subject ?? null;
    // §1.6 — `second_approval_request` is NEVER a broadcast: exactly the routed
    // individual (plus the fallback once escalated), filtered by their own pref.
    const recipients = await filterBySecondApprovalPref(prisma, routed?.recipients ?? []);

    // §B.5 — fail-soft is right for the SEND, but an empty recipient set (or any
    // routing misconfiguration) must be a LOUD condition, not silence. That
    // indistinguishability is the whole defect.
    //
    // ⚠ THE ALARM MUST SEE THE POST-FILTER SET. An earlier revision alarmed on
    // `routed.recipients` (pre-filter) and then sent to the post-filter list with
    // nothing re-checking emptiness — so an admin turning ONE person's
    // `second_approval_request` pref off at /admin/ap/notifications silently
    // recreated the original outage: resolver returns a healthy single recipient,
    // no alarm fires, the filter empties the list, and the send logs a warn and
    // returns. Zero email, zero alarm, indistinguishable from success. The hole
    // was closed at the resolver and reopened one layer downstream, through the
    // very screen this ADR added. Alarm on what will ACTUALLY be sent.
    const filteredToNobody = (routed?.recipients.length ?? 0) > 0 && recipients.length === 0;
    if (!routed || recipients.length === 0 || routed.problems.length > 0) {
      const problems = [...(routed?.problems ?? [])];
      if (!routed) problems.push('Second-approval routing resolver threw.');
      if (filteredToNobody) {
        problems.push(
          `Every routed second approver (${routed?.recipients.map((r) => r.name).join(', ')}) has notify_second_approval_request OFF — the request is authorized but nobody will be told. Re-enable the pref at /admin/ap/notifications.`,
        );
      }
      await reportSecondApprovalRoutingProblem({
        requestId: args.requestId,
        firstApproverId: args.actorUserId,
        problems,
        recipientCount: recipients.length,
      }).catch(() => undefined);
    }
    await notifySecondApprovalNeeded({
      requestId: args.requestId,
      subject,
      siteCode,
      // ADR-0066 — the label is the resolved PERSON now, not "Woodland (Bill)".
      // `secondApproverSiteLabel` became wrong the moment routing stopped
      // depending on the site.
      siteLabel: routed?.routedTo?.name ?? 'the fallback approver',
      approverEmails: recipients.map((r: { email: string }) => r.email),
    }).catch(() => undefined);
    return {
      requestId: args.requestId,
      decision: args.decision,
      mail: 'second_approval_pending',
      secondApprovalPending: true,
      secondApproverLabel: routed?.routedTo?.name ?? 'the fallback approver',
    };
  }

  // Won. The flip + its audit already committed atomically above. The decision
  // email/stamp/R2 work stays OUTSIDE the tx — a committed decision must NEVER
  // roll back because a later mail/render/R2 step failed (that is surfaced via
  // `mail` + a page, never silently).
  const mail = await sendDecisionEmail(prisma, args.requestId, args.renderer);
  return { requestId: args.requestId, decision: args.decision, mail };
}

/**
 * Amendment 9 (§2.4) — resolve the site + recipients for a freshly filed equipment
 * request and send the site-manager email.
 *
 * Split out of `decideRequest` so the decision path reads as one thing. Everything
 * here is post-commit and best-effort; the CALLER wraps it in `.catch()`.
 */
async function notifyEquipmentRequest(
  prisma: PrismaClient,
  args: {
    equipmentRequestId: string;
    apRequestId: string;
    siteId: string;
    actorUserId: string;
    description: string;
    vendor: string | null;
    amountCents: number | null;
  },
): Promise<void> {
  const [site, approver, roster] = await Promise.all([
    prisma.site.findUnique({
      where: { id: args.siteId },
      select: { id: true, code: true, name: true },
    }),
    prisma.user.findUnique({ where: { id: args.actorUserId }, select: { name: true } }),
    equipmentRequestRecipients(prisma, args.siteId),
  ]);
  if (!site) return;
  await notifyEquipmentRequestCreated({
    requestId: args.equipmentRequestId,
    apRequestId: args.apRequestId,
    description: args.description,
    approverName: approver?.name ?? null,
    vendor: args.vendor,
    amountCents: args.amountCents,
    site: { id: site.id, code: site.code, name: site.name },
    recipients: roster.to,
    cc: roster.cc,
  });
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
      // ADR-0046 Amendment 5 (D-M5-1/4) — structured Approve columns. On an Approve
      // these carry the decision facts; the deprecated vendor/amount_cents stay null.
      // The email prefers the structured value and falls back to the legacy column so
      // pre-Amendment-5 rows (and Reject/NOT-DR3) still render correctly.
      vendor_freeform: true,
      confirmed_amount_cents: true,
      explanation: true,
      variance_flag_state: true,
      variance_acknowledgment_note: true,
      variance_acknowledged_by: true,
      // ADR-0046 Amendment 5 (D-M5-3) — dual-approval identities + times. Present on
      // a >= $1,000 decision; the mail renders BOTH approvers + PT timestamps, and a
      // second-approver override reject CCs the first approver.
      first_approver_id: true,
      first_approved_at: true,
      second_approver_id: true,
      second_approved_at: true,
      second_approver_note: true,
      decided_by: true,
      sender_address: true,
      body_html_sanitized: true,
      body_text: true,
      // Operator directive 2026-07-15: the site tag the approver selected must
      // be unmissable on everything accounting receives. site_id is a bare
      // column (AP block convention: DB-level FK, no Prisma relation) — the
      // name resolves with an explicit lookup below.
      site_id: true,
      // ADR-0046 amendment (2026-07-20): NOT-DR3 disposition — when true the mail +
      // stamp render "NOT DR3 — see reason" in the location slot instead of a site.
      filed_not_dr3: true,
    },
  });
  if (!req) throw new ApRequestNotFoundError(requestId);
  const filedNotDr3 = req.filed_not_dr3 === true;
  // A NOT-DR3 decision is never filed against a site, so no name is resolved.
  const siteName =
    !filedNotDr3 && req.site_id
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
  // ADR-0046 Amendment 5 (D-M5-3) — dual-approval (>= $1,000). Both approvers ride
  // the mail + stamp. The stamp's leading "Approved by …" is the FIRST approver +
  // their approval time; the second-approval clause names the second approver +
  // confirmation time. A second-approver override REJECT CCs the first approver so
  // they see the override.
  const isDual = req.first_approver_id != null;
  const firstApproverName = isDual ? await resolveName(prisma, req.first_approver_id) : null;
  const secondApproverName = req.second_approver_id
    ? await resolveName(prisma, req.second_approver_id)
    : null;
  const firstApprovedAt = req.first_approved_at ?? null;
  const secondApprovedAt = req.second_approved_at ?? null;
  // Bill + both facilities read Pacific; the fleet host clock is UTC. Render the
  // decision instant in Pacific wall-clock (+ ' PT') like every other AP surface
  // (notify.ts new-request "Received", stamp.ts stamp line, the hold-notice email).
  const decidedLabel = `${formatPacificDateTime(decidedAt)} PT`;
  // Amendment 5 — prefer the structured Approve columns, falling back to the
  // deprecated vendor/amount_cents (Reject/NOT-DR3 + pre-Amendment-5 rows).
  const effectiveAmountCents =
    typeof req.confirmed_amount_cents === 'number' ? req.confirmed_amount_cents : req.amount_cents;
  const effectiveVendor = req.vendor_freeform ?? req.vendor;
  // On an Approve the transaction narrative is `explanation`; otherwise decision_note.
  const effectiveNote =
    req.status === 'approved' ? (req.explanation ?? req.decision_note) : req.decision_note;
  const amountLine =
    typeof effectiveAmountCents === 'number'
      ? `<li>Amount: $${(effectiveAmountCents / 100).toFixed(2)}</li>`
      : '';
  const vendorLine = effectiveVendor ? `<li>Vendor: ${escapeHtml(effectiveVendor)}</li>` : '';
  // ADR-0126 (D5) — the NOT-DR3 reason is rendered ONCE.
  //
  // A NOT-DR3 filing puts `decision_note` in the location slot below as
  // "NOT DR3 — see reason: …". On a REJECT, `effectiveNote` resolves to that same
  // `decision_note`, so the identical sentence was also emitted as "Note: …" a few
  // lines further down. Mary received every NOT-DR3 rejection with its reason
  // stated twice, which reads like two different facts and invites a second look
  // for a difference that is not there. The location slot wins because it is the
  // unmissable one (bolded, and mirrored into the subject line).
  const notDr3Reason = filedNotDr3 ? (req.decision_note?.trim() ?? '') : '';
  const noteDuplicatesLocation =
    filedNotDr3 && !!effectiveNote && effectiveNote.trim() === notDr3Reason;
  const noteLine =
    effectiveNote && !noteDuplicatesLocation ? `<li>Note: ${escapeHtml(effectiveNote)}</li>` : '';
  // D-M5-3 — the approver line. For a >= $1,000 decision both approvers + PT
  // timestamps appear (first approved / second confirmed-or-overrode); otherwise the
  // single terminal approver. A second-approver override reject also states the
  // override note explicitly.
  const approverLine = isDual
    ? `<li>First approval: ${escapeHtml(firstApproverName ?? approverName)}${
        firstApprovedAt ? ` on ${escapeHtml(formatPacificDateTime(firstApprovedAt))} PT` : ''
      }</li>
      <li>Second ${req.status === 'rejected' ? 'approval (override)' : 'approval'}: ${escapeHtml(
        secondApproverName ?? approverName,
      )}${secondApprovedAt ? ` on ${escapeHtml(formatPacificDateTime(secondApprovedAt))} PT` : ''}</li>`
    : `<li>Approver: ${escapeHtml(approverName)}</li>
      <li>Decided at: ${escapeHtml(decidedLabel)}</li>`;
  const overrideNoteLine =
    isDual && req.status === 'rejected' && req.second_approver_note
      ? `<li>Second-approver override reason: ${escapeHtml(req.second_approver_note)}</li>`
      : '';
  // D-M5-3 — a second-approver override REJECT must carry the FIRST approver's full
  // context so the forwarder + CC'd first approver see WHAT was approved, not just
  // the override reason. On a structured Approve the narrative lives in `explanation`
  // (decision_note stays null), so the effectiveNote fallback above resolves it to
  // NULL on a reject and drops it — render `explanation` explicitly here. The first
  // approver's equipment linkage rides the same block (spec §D-M5-3, line 680).
  const isDualOverrideReject = isDual && req.status === 'rejected';
  const firstApprovalNoteLine =
    isDualOverrideReject && req.explanation
      ? `<li>First approval note: ${escapeHtml(req.explanation)}</li>`
      : '';
  let firstApprovalEquipmentLine = '';
  if (isDualOverrideReject) {
    const links = await prisma.apEquipmentLink.findMany({
      where: { request_id: requestId },
      select: {
        equipment_id: true,
        is_not_equipment_related: true,
        // Amendment 9 — the escape-hatch disposition. Without this the override
        // reject would render NO equipment line at all for a hatch decision:
        // `equipment_id` is null and `is_not_equipment_related` is false, so both
        // branches below fall through silently. That would drop the one thing the
        // first approver actually said about the asset, in the exact email whose
        // purpose is to carry their context to the forwarder.
        equipment_request: { select: { description: true } },
      },
    });
    const described = links.find((l) => l.equipment_request)?.equipment_request?.description;
    if (described) {
      firstApprovalEquipmentLine = `<li>Equipment: not in the fleet list — described as “${escapeHtml(
        described,
      )}” (a request to add it was filed)</li>`;
    } else if (links.some((l) => l.is_not_equipment_related)) {
      firstApprovalEquipmentLine = '<li>Equipment: not equipment-related</li>';
    } else {
      const ids = links
        .map((l) => l.equipment_id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        const equipment = await prisma.equipment.findMany({
          where: { id: { in: ids } },
          select: { display_name: true },
        });
        const names = equipment.map((e) => e.display_name).filter(Boolean);
        if (names.length > 0) {
          firstApprovalEquipmentLine = `<li>Equipment: ${escapeHtml(names.join(', '))}</li>`;
        }
      }
    }
  }
  // D-M5-4 — an acknowledged variance rides the decision email as an audit footer.
  const varianceLine =
    req.variance_flag_state === 'acknowledged'
      ? `<li>⚠ Variance acknowledged by ${escapeHtml(await resolveName(prisma, req.variance_acknowledged_by))}${
          req.variance_acknowledgment_note
            ? ` — ${escapeHtml(req.variance_acknowledgment_note)}`
            : ''
        }</li>`
      : '';
  // ADR-0046 Amendment 4 — the Great Plains matching keys (request id + original
  // subject) are STRIPPED from the mail body. They already ride the SUBJECT line
  // (below) and the stamped decision PDF, so repeating them inline was redundant
  // clutter that made the body read like a machine record instead of a decision
  // notice. The body now carries only the human-facing decision facts.
  // 2026-07-15 operator directive: when the approver tagged a site, it leads
  // the decision facts — accounting must never guess which site's books.
  // 2026-07-20 amendment: a NOT-DR3 decision leads with an unmissable marker + the
  // reason (in the same slot) so Mary never mistakes it for a DR3-site invoice.
  const locationLine = filedNotDr3
    ? `<li><b>NOT DR3 — see reason:</b> ${escapeHtml(notDr3Reason || '(no reason provided)')}</li>`
    : siteName
      ? `<li>Site: <b>${escapeHtml(siteName)}</b></li>`
      : '';
  const htmlBody = `<p>A vendor-invoice approval decision has been recorded in DR3-Vision.</p>
    <ul>
      <li>Decision: <b>${escapeHtml(req.status.toUpperCase())}</b></li>
      ${locationLine}
      ${approverLine}
      ${vendorLine}
      ${amountLine}
      ${noteLine}
      ${firstApprovalNoteLine}
      ${firstApprovalEquipmentLine}
      ${overrideNoteLine}
      ${varianceLine}
    </ul>`;

  // ADR-0046 Amendment 4 — stamp the ORIGINAL invoice (both decisions), attach the
  // stamped original(s), and archive them to R2. BODY-only originals re-render the
  // (re-)sanitized body; PDF/image attachments get a TRUE overlay (pdf-lib /
  // Playwright); an R2-unconfigured window degrades to the stamped cover page.
  // Fail-soft: a render/download/R2 failure must NEVER block the decision mail to
  // accounting (the decision itself already stands). Preserve the .catch(→null).
  // D-M5-3 — on a >= $1,000 APPROVED row the stamp leads with the FIRST approver +
  // their approval time and appends the second-approval clause; every other decision
  // (sub-$1K approve, any reject, NOT-DR3) uses the single terminal approver.
  const dualApproved = isDual && req.status === 'approved';
  const stampApproverName = dualApproved ? (firstApproverName ?? approverName) : approverName;
  const stampDecidedAt = dualApproved ? (firstApprovedAt ?? decidedAt) : decidedAt;
  const artifacts = await buildDecisionStamp(
    prisma,
    req,
    stampApproverName,
    stampDecidedAt,
    siteName,
    filedNotDr3,
    renderer,
    dualApproved ? secondApproverName : null,
    dualApproved ? secondApprovedAt : null,
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

  // D-M5-3 — a second-approver override REJECT CCs the FIRST approver so they see
  // their approval was overridden. Resolve their address and add it to the CC set
  // (de-duped, and never the primary recipient).
  let effectiveCc = cc;
  if (isDual && req.status === 'rejected' && req.first_approver_id) {
    const firstEmail = (
      await prisma.user.findUnique({
        where: { id: req.first_approver_id },
        select: { email: true },
      })
    )?.email;
    if (
      firstEmail &&
      !recipients.some((r) => r.toLowerCase() === firstEmail.toLowerCase()) &&
      !effectiveCc.some((c) => c.toLowerCase() === firstEmail.toLowerCase())
    ) {
      effectiveCc = [...effectiveCc, firstEmail];
    }
  }

  // ADR-0047 — the AP module is org-wide + born pilot; the actual delivery
  // routes through the rollout gate (in pilot it reroutes to admins). The
  // empty-recipient REFUSE above still guards the LIVE roster (Mary's GP filing)
  // so a config gap pages before ramp — the gate does not mask it.
  const notified = await notifyStaff({
    surfaceCode: NOTIFY_SURFACE.AP_NOTIFY,
    site: null,
    recipients,
    ...(effectiveCc.length > 0 ? { cc: effectiveCc } : {}),
    // Location rides the SUBJECT line too (2026-07-15 directive) — visible before
    // the mail is even opened, next to the GP matching key. NOT-DR3 (2026-07-20)
    // shows "NOT DR3" here so accounting sees it in the inbox list.
    subject: `DR3-Vision AP decision (${req.status}${
      filedNotDr3 ? ' — NOT DR3' : siteName ? ` — ${siteName}` : ''
    }) — ${subject}`.slice(0, 200),
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

  // ── ADR-0126. M365 unconfigured / credentials unresolved ──────────────────
  //
  // This path used to `return 'disabled'` in silence: no error log, no page, and
  // no `decision_mail_sent_at` stamp. Fail-OPEN is right for the transport (a mail
  // outage must never roll back a committed decision) but fail-SILENT is not — a
  // credential expiry takes out decision mail for EVERY request at once, and the
  // only trace was a return value nobody reads. That is the same
  // indistinguishable-from-success shape that let two rejections go unnoticed.
  //
  // Not per-request: one page names the outage, and the sweep in the 06:00 digest
  // is the backstop that enumerates every affected row even if this page is missed
  // entirely (an unstamped decision is caught by STATE, not by this alert firing).
  if (notified.disabled) {
    log.error(
      { requestId, status: req.status },
      '[ap-approvals] decision email NOT sent — M365 is disabled or its credentials could not be resolved',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'AP decision email NOT sent — mail transport disabled',
      body: `AP request ${requestId} was decided (${req.status}) but M365 mail is disabled or its credentials could not be resolved, so NO decision email reached accounting. This affects EVERY decision while it persists. Check the M365 credentials on the app container; decided requests with no confirmed mail are listed in the 06:00 AP digest and flagged in the AP queue.`,
      priority: 'high',
      tags: ['error', 'ap', 'config', 'dr3-vision'],
      clickUrl: `${baseUrl()}/dashboard/ops/ap`,
      // Config-class fingerprint, matching the empty-roster alarm above: the
      // condition is the OUTAGE, not the request that happened to hit it. A
      // per-request key would page once per decision for the whole outage.
      fingerprint: 'ap-decision-mail-disabled',
      cooldownMs: 6 * 60 * 60 * 1000,
    }).catch(() => undefined);
    return 'disabled';
  }
  // Size refusal is reported BEFORE the generic failure branch: both leave
  // `delivered === 0`, but only this one is caused by the attachment rather than
  // the transport, and only this one is unfixable by re-sending. Pages so the
  // decision does not sit looking delivered.
  if (notified.oversize) {
    const { rawAttachmentBytes, limitBytes, filenames } = notified.oversize;
    log.error(
      { requestId, rawAttachmentBytes, limitBytes, filenames },
      '[ap-approvals] decision email REFUSED — stamped attachments exceed the Graph inline-send ceiling',
    );
    await publishNtfy({
      topic: 'dr3-vision-system',
      title: 'AP decision email NOT sent — stamped invoice too large to attach',
      // ADR-0114: since the upload-session transport shipped, this refusal means
      // the message exceeds what the MAILBOX will transmit — not what one Graph
      // request will carry. Naming the wrong ceiling would send the operator to
      // shrink an attachment that is already well inside Graph's limits.
      body: `AP request ${requestId} was decided (${req.status}) but the stamped attachment(s) total ${Math.round(
        rawAttachmentBytes / 1024,
      )} KB, above the ${Math.round(
        limitBytes / 1024,
      )} KB per-message limit on the sending mailbox. NO email was sent to accounting and re-sending will not help until the attachments are smaller or the mailbox limit is raised. The decision stands and the stamped original is archived in Vision — open the AP queue for request ${requestId} to retrieve it.`,
      priority: 'high',
      tags: ['error', 'ap', 'dr3-vision'],
      fingerprint: `ap-decision-mail-too-large:${requestId}`,
    });
    return 'too_large';
  }
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
  // Amendment 5 (D-M5-1/4) — the Approve narrative + an acknowledged-variance note
  // ride the stamped PDF band too. Null on Reject / NOT-DR3 / pre-Amendment-5 rows.
  explanation?: string | null;
  variance_flag_state?: string | null;
  variance_acknowledgment_note?: string | null;
  // D-M5-3 — a second-approver override reject's note rides the stamp band (the
  // single-reject note stays in decision_note).
  second_approver_note?: string | null;
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
  | 'requestId'
  | 'subject'
  | 'approverName'
  | 'decision'
  | 'decidedAt'
  | 'note'
  | 'siteName'
  | 'notDr3'
  // D-M5-3 — dual-approval clause on a >= $1,000 approved stamp.
  | 'secondApproverName'
  | 'secondApprovedAt'
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
/**
 * The note stamped onto the decision PDF band. On an Approve the narrative is the
 * structured `explanation` (falling back to `decision_note` for pre-Amendment-5
 * rows); Reject/NOT-DR3 keep `decision_note`. An acknowledged variance appends a
 * compact audit suffix so the stamped document itself records the vetting.
 */
function stampNote(req: StampSourceRequest): string | null {
  // On an Approve the narrative is `explanation`; on a Reject it is the single
  // `decision_note`, or — for a >= $1,000 second-approver override — the
  // `second_approver_note` explaining the override.
  const base =
    req.status === 'approved'
      ? (req.explanation ?? req.decision_note)
      : (req.second_approver_note ?? req.decision_note);
  if (req.variance_flag_state !== 'acknowledged') return base;
  const suffix = req.variance_acknowledgment_note
    ? `[Variance acknowledged: ${req.variance_acknowledgment_note}]`
    : '[Variance acknowledged]';
  return base ? `${base} ${suffix}` : suffix;
}

async function buildDecisionStamp(
  prisma: PrismaClient,
  req: StampSourceRequest,
  approverName: string,
  decidedAt: Date,
  siteName: string | null,
  filedNotDr3: boolean,
  renderer?: PdfRenderer,
  // D-M5-3 — the second approver (name + confirmation time) on a >= $1,000 approved
  // stamp; null on every single-approver decision.
  secondApproverName: string | null = null,
  secondApprovedAt: Date | null = null,
): Promise<StampedArtifact[]> {
  const decision: ApDecision = req.status === 'approved' ? 'approved' : 'rejected';
  const base: StampBase = {
    requestId: req.id,
    subject: req.subject ?? '(no subject)',
    approverName,
    decision,
    decidedAt,
    secondApproverName,
    secondApprovedAt,
    // ADR-0046 Amendment 3 — the decision note rides on the stamped PDF too. Because
    // the note is stamped onto every attachment, dropping the body render (below)
    // when attachments exist loses no approver-relevant context. Amendment 5: on an
    // Approve the narrative is `explanation`; an acknowledged variance appends an
    // audit suffix so the stamped document shows the vetting.
    note: stampNote(req),
    // 2026-07-15 directive — the site tag rides the per-page stamp line.
    siteName,
    // 2026-07-20 amendment — NOT-DR3 replaces the site slot with an explicit marker
    // on every stamped page (the reason rides the note band).
    notDr3: filedNotDr3,
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
