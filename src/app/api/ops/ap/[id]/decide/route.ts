// ADR-0046 D4 — decide an AP request (approve/reject). Org reach; first action
// wins, atomically. Email can only CREATE requests — this decision requires an
// authenticated Vision session over the stored record (D6).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
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
    // F7-AP — cap stored free-text (storage-DoS boundary); 400 on overflow rather
    // than silently truncating the note that rides the returned invoice.
    if (typeof body.note === 'string' && body.note.length > NOTE_MAX_LEN) {
      return NextResponse.json(
        { error: `note must be ${NOTE_MAX_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    if (typeof body.vendor === 'string' && body.vendor.length > VENDOR_MAX_LEN) {
      return NextResponse.json(
        { error: `vendor must be ${VENDOR_MAX_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    // Amendment 3 — a rejection MUST carry a note explaining why (approvals stay
    // note-optional). Validate BEFORE any state change.
    assertDecisionNote(body.decision as ApDecision, body.note);
    const amountCents =
      typeof body.amountCents === 'number' &&
      Number.isFinite(body.amountCents) &&
      body.amountCents >= 0
        ? Math.round(body.amountCents)
        : undefined;
    // ADR-0046 amendment (2026-07-20) — the NOT-DR3 disposition. A decision is
    // EITHER filed against a real DR3 site OR marked NOT DR3, never both/neither.
    const notDr3 = body.notDr3 === true;
    const hasSiteInput = typeof body.siteId === 'string' && body.siteId.trim().length > 0;
    if (notDr3 && hasSiteInput) {
      // Mutual exclusion — refuse rather than silently pick one location.
      return NextResponse.json(
        { error: 'A decision is filed against a DR3 site OR marked NOT DR3 — not both.' },
        { status: 400 },
      );
    }

    const noteTrimmed =
      typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

    if (notDr3) {
      // NOT DR3 requires a reason (the note); no site is resolved or asserted.
      if (!noteTrimmed) {
        return NextResponse.json(
          {
            error:
              'NOT DR3 requires a reason — add why this invoice is not for a DR3 site in the note, then decide.',
          },
          { status: 400 },
        );
      }
      const result = await decideRequest({
        requestId: id,
        decision: body.decision as ApDecision,
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

    // Normal path — resolve + REQUIRE the site tag (id or 'eugene'/'woodland' code)
    // BEFORE the decision (operator directive 2026-07-15) — a missing or bad site
    // must not flip the request.
    const siteId = await resolveDecisionSiteId(prisma, body.siteId);
    assertDecisionSite(siteId);

    const result = await decideRequest({
      requestId: id,
      decision: body.decision as ApDecision,
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
