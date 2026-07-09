// ADR-0046 D4 — decide an AP request (approve/reject). Org reach; first action
// wins, atomically. Email can only CREATE requests — this decision requires an
// authenticated Vision session over the stored record (D6).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import {
  ApAlreadyDecidedError,
  ApInvalidSiteError,
  ApNoteRequiredError,
  ApNotActionableError,
  ApRequestNotFoundError,
  assertDecisionNote,
  decideRequest,
  resolveDecisionSiteId,
  type ApDecision,
} from '@/lib/ap/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DecideBody {
  decision?: string;
  note?: string;
  vendor?: string;
  amountCents?: number;
  /** ADR-0046 §3 amendment — optional site tag: a site id or 'eugene'/'woodland' code. */
  siteId?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as DecideBody;
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
    }
    // Amendment 3 — a rejection MUST carry a note explaining why (approvals stay
    // note-optional). Validate BEFORE any state change.
    assertDecisionNote(body.decision as ApDecision, body.note);
    const amountCents =
      typeof body.amountCents === 'number' && Number.isFinite(body.amountCents) && body.amountCents >= 0
        ? Math.round(body.amountCents)
        : undefined;
    // Validate + resolve the optional site tag (id or 'eugene'/'woodland' code)
    // BEFORE the decision — a bad site id must not flip the request.
    const siteId = await resolveDecisionSiteId(prisma, body.siteId);

    const result = await decideRequest({
      requestId: id,
      decision: body.decision as ApDecision,
      actorUserId: identity.userId,
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(typeof body.vendor === 'string' && body.vendor.trim() ? { vendor: body.vendor.trim() } : {}),
      ...(amountCents !== undefined ? { amountCents } : {}),
      ...(siteId ? { siteId } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApNoteRequiredError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApInvalidSiteError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApRequestNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ApAlreadyDecidedError) {
      return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
    }
    if (e instanceof ApNotActionableError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
