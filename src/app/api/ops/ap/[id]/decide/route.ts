// ADR-0046 D4 — decide an AP request (approve/reject). Org reach; first action
// wins, atomically. Email can only CREATE requests — this decision requires an
// authenticated Vision session over the stored record (D6).
//
// ADR-0046 Amendment 5 (D-M5-1/4/6) — the Approve path is now STRUCTURED: a
// real-site Approve requires four non-empty fields (vendor freeform, explanation,
// confirmed amount, equipment linkage) and, when the vendor's established baseline
// trips the variance thresholds, an explicit acknowledgment. All four requirements
// and the variance gate are enforced HERE server-side — the client is never
// trusted. Reject / NOT-DR3 keep their single reason/note field unchanged.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { assertEquipmentForSite, ApEquipmentInvalidError } from '@/lib/ap/equipment';
import { evaluateVarianceForDecision } from '@/lib/ap/variance';
import {
  ApAlreadyDecidedError,
  ApInvalidSiteError,
  ApLocationConflictError,
  ApNoteRequiredError,
  ApNotActionableError,
  ApRequestNotFoundError,
  ApSiteRequiredError,
  assertDecisionNote,
  assertDecisionSite,
  decideRequest,
  resolveDecisionSiteId,
  type ApDecision,
} from '@/lib/ap/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// F7-AP — free-text length caps (storage-DoS boundary). Generous enough for a
// real decision note / vendor name, bounded enough to refuse an abusive payload.
const NOTE_MAX_LEN = 2000;
const VENDOR_MAX_LEN = 200;
// D-M5-6 — a decision links at most a handful of assets; cap the array to refuse an
// abusive payload before it reaches the DB validation.
const EQUIPMENT_MAX_IDS = 50;

interface DecideBody {
  decision?: string;
  note?: string;
  vendor?: string;
  amountCents?: number;
  /** REQUIRED for a DR3-site decision (operator directive 2026-07-15) — a site id or
   * 'eugene'/'woodland' code. Omitted when `notDr3` is true. */
  siteId?: string;
  /** ADR-0046 amendment (2026-07-20) — the "NOT DR3 — See Reason" disposition: this
   * invoice is NOT for a DR3 location. When true, a non-empty `note` (the reason) is
   * REQUIRED and `siteId` MUST be absent (mutually exclusive). */
  notDr3?: boolean;
  // ─── ADR-0046 Amendment 5 (D-M5-1/4/6) — structured Approve payload (real-site
  // Approve only). Reject / NOT-DR3 ignore these and use `note`.
  /** D-M5-1 — approver-typed vendor name (required to Approve). */
  vendorFreeform?: string;
  /** D-M5-1 — what the transaction was for (required to Approve; replaces `note`). */
  explanation?: string;
  /** D-M5-1 — approver-confirmed amount in cents (required to Approve). */
  confirmedAmountCents?: number;
  /** D-M5-6 — selected equipment ids (mutually exclusive with notEquipmentRelated). */
  equipmentIds?: string[];
  /** D-M5-6 — the explicit "Not equipment-related" choice. */
  notEquipmentRelated?: boolean;
  /** D-M5-4 — the approver acknowledged an above-threshold variance. */
  varianceAcknowledged?: boolean;
  /** D-M5-4 — optional additional acknowledgment note. */
  varianceAckNote?: string;
}

function tooLong(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length > max;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as DecideBody;
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return NextResponse.json(
        { error: "decision must be 'approved' or 'rejected'" },
        { status: 400 },
      );
    }
    const decision = body.decision as ApDecision;
    // F7-AP — cap stored free-text (storage-DoS boundary); 400 on overflow rather
    // than silently truncating text that rides the returned invoice. Runs BEFORE any
    // state change or site resolution.
    if (tooLong(body.note, NOTE_MAX_LEN))
      return NextResponse.json({ error: `note must be ${NOTE_MAX_LEN} characters or fewer` }, { status: 400 });
    if (tooLong(body.explanation, NOTE_MAX_LEN))
      return NextResponse.json({ error: `explanation must be ${NOTE_MAX_LEN} characters or fewer` }, { status: 400 });
    if (tooLong(body.varianceAckNote, NOTE_MAX_LEN))
      return NextResponse.json({ error: `variance note must be ${NOTE_MAX_LEN} characters or fewer` }, { status: 400 });
    if (tooLong(body.vendor, VENDOR_MAX_LEN))
      return NextResponse.json({ error: `vendor must be ${VENDOR_MAX_LEN} characters or fewer` }, { status: 400 });
    if (tooLong(body.vendorFreeform, VENDOR_MAX_LEN))
      return NextResponse.json({ error: `vendor must be ${VENDOR_MAX_LEN} characters or fewer` }, { status: 400 });

    // ADR-0046 amendment (2026-07-20) — the NOT-DR3 disposition. A decision is EITHER
    // filed against a real DR3 site OR marked NOT DR3, never both/neither.
    const notDr3 = body.notDr3 === true;
    const hasSiteInput = typeof body.siteId === 'string' && body.siteId.trim().length > 0;
    if (notDr3 && hasSiteInput) {
      return NextResponse.json(
        { error: 'A decision is filed against a DR3 site OR marked NOT DR3 — not both.' },
        { status: 400 },
      );
    }
    const noteTrimmed =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

    // ── NOT-DR3 path (single reason field; approve or reject). Unchanged.
    if (notDr3) {
      if (!noteTrimmed) {
        return NextResponse.json(
          {
            error:
              'NOT DR3 requires a reason — add why this invoice is not for a DR3 site in the note, then decide.',
          },
          { status: 400 },
        );
      }
      const amountCents = normalizeAmount(body.amountCents);
      const result = await decideRequest({
        requestId: id,
        decision,
        actorUserId: identity.userId,
        note: noteTrimmed,
        ...(typeof body.vendor === 'string' && body.vendor.trim()
          ? { vendor: body.vendor.trim() }
          : {}),
        ...(amountCents !== undefined ? { amountCents } : {}),
        filedNotDr3: true,
      });
      return NextResponse.json(result);
    }

    // ── Normal path — resolve + REQUIRE the site tag BEFORE deciding.
    const siteId = await resolveDecisionSiteId(prisma, body.siteId);
    assertDecisionSite(siteId);

    // ── STRUCTURED APPROVE (D-M5-1/4/6). A real-site Approve requires the four
    // fields + the variance gate. Reject on a real site falls through to the single-
    // note path below.
    if (decision === 'approved') {
      const vendorFreeform =
        typeof body.vendorFreeform === 'string' ? body.vendorFreeform.trim() : '';
      const explanation = typeof body.explanation === 'string' ? body.explanation.trim() : '';
      if (!vendorFreeform)
        return NextResponse.json(
          { error: 'Enter the vendor name to approve.' },
          { status: 400 },
        );
      if (!explanation)
        return NextResponse.json(
          { error: 'Enter what this transaction was for (explanation) to approve.' },
          { status: 400 },
        );
      const confirmedAmountCents = normalizeAmount(body.confirmedAmountCents);
      if (confirmedAmountCents === undefined)
        return NextResponse.json(
          { error: 'Confirm the invoice amount to approve.' },
          { status: 400 },
        );

      // D-M5-6 — equipment linkage is required: exactly one of a non-empty selection
      // OR the explicit "Not equipment-related" choice (never both, never neither).
      const equipmentIds = Array.isArray(body.equipmentIds)
        ? body.equipmentIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : [];
      const notEquipmentRelated = body.notEquipmentRelated === true;
      if (equipmentIds.length > EQUIPMENT_MAX_IDS)
        return NextResponse.json(
          { error: `select at most ${EQUIPMENT_MAX_IDS} equipment items` },
          { status: 400 },
        );
      if (notEquipmentRelated && equipmentIds.length > 0)
        return NextResponse.json(
          { error: 'Choose equipment OR "Not equipment-related" — not both.' },
          { status: 400 },
        );
      if (!notEquipmentRelated && equipmentIds.length === 0)
        return NextResponse.json(
          {
            error:
              'Select the equipment this invoice relates to, or choose "Not equipment-related", to approve.',
          },
          { status: 400 },
        );
      // Server-authoritative: every submitted id must be ACTIVE and on this site.
      if (equipmentIds.length > 0) await assertEquipmentForSite(prisma, siteId, equipmentIds);

      // D-M5-4 — re-evaluate variance server-side; NEVER trust the client's flag. An
      // above-threshold trip that was not explicitly acknowledged is refused.
      const variance = await evaluateVarianceForDecision(prisma, vendorFreeform, confirmedAmountCents);
      if (variance.state === 'above_threshold' && body.varianceAcknowledged !== true) {
        return NextResponse.json(
          {
            error:
              'This amount is a variance from the vendor baseline — acknowledge the variance before approving.',
            varianceRequired: true,
          },
          { status: 400 },
        );
      }
      const varianceFlagState =
        variance.state === 'above_threshold' ? ('acknowledged' as const) : variance.state;
      const ackNote =
        typeof body.varianceAckNote === 'string' && body.varianceAckNote.trim()
          ? body.varianceAckNote.trim()
          : undefined;

      const result = await decideRequest({
        requestId: id,
        decision,
        actorUserId: identity.userId,
        siteId,
        vendorFreeform,
        explanation,
        confirmedAmountCents,
        equipmentLinks: { equipmentIds, notEquipmentRelated },
        varianceFlagState,
        ...(varianceFlagState === 'acknowledged'
          ? { varianceAcknowledgedBy: identity.userId, ...(ackNote ? { varianceAcknowledgmentNote: ackNote } : {}) }
          : {}),
      });
      return NextResponse.json(result);
    }

    // ── REJECT on a real site — single reason/note field (unchanged).
    assertDecisionNote(decision, body.note);
    const amountCents = normalizeAmount(body.amountCents);
    const result = await decideRequest({
      requestId: id,
      decision,
      actorUserId: identity.userId,
      ...(noteTrimmed ? { note: noteTrimmed } : {}),
      ...(typeof body.vendor === 'string' && body.vendor.trim()
        ? { vendor: body.vendor.trim() }
        : {}),
      ...(amountCents !== undefined ? { amountCents } : {}),
      siteId,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApEquipmentInvalidError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApNoteRequiredError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApSiteRequiredError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApInvalidSiteError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApLocationConflictError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApRequestNotFoundError)
      return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ApAlreadyDecidedError) {
      return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
    }
    if (e instanceof ApNotActionableError)
      return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}

/** Round a client-sent amount to a non-negative integer cents, or undefined. */
function normalizeAmount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}
