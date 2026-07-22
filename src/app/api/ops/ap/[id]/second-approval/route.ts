// ADR-0046 Amendment 5 (D-M5-3) — fulfill (or override) a $1,000 second approval.
//
// A request in `pending_second_approval` awaits its site's second approver
// (Woodland → Bill, Eugene → Shannon). This route is the SECOND leg: the second
// approver's Approve (→ approved) or Reject (→ rejected, override). ALL
// authorization is server-side — a non-eligible user is refused (403), the
// first==second self-fulfillment path requires an explicit re-confirmation flag +
// a 30-second minimum wait, and a Reject requires an override note. The client is
// never trusted.

import { NextResponse } from 'next/server';
import { requireApApprover } from '@/lib/ap/approvers';
import {
  ApAlreadyDecidedError,
  ApNoteRequiredError,
  ApNotActionableError,
  ApRequestNotFoundError,
  type ApDecision,
} from '@/lib/ap/approvals';
import {
  decideSecondApproval,
  ApSecondApprovalNotEligibleError,
  ApSecondApprovalReconfirmRequiredError,
  ApSecondApprovalTooSoonError,
} from '@/lib/ap/second-approval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NOTE_MAX_LEN = 2000;

interface SecondApprovalBody {
  decision?: string;
  /** Override note — REQUIRED on a Reject (persisted as second_approver_note). */
  note?: string;
  /** Explicit re-confirmation on the first==second self-fulfillment path. */
  reconfirm?: boolean;
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const body = (await _req.json().catch(() => ({}))) as SecondApprovalBody;
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
    }
    if (typeof body.note === 'string' && body.note.length > NOTE_MAX_LEN) {
      return NextResponse.json({ error: `note must be ${NOTE_MAX_LEN} characters or fewer` }, { status: 400 });
    }
    const decision = body.decision as ApDecision;
    const result = await decideSecondApproval({
      requestId: id,
      decision,
      actor: { userId: identity.userId, role: identity.viewer.role },
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(body.reconfirm === true ? { reconfirm: true } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApSecondApprovalNotEligibleError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof ApSecondApprovalReconfirmRequiredError)
      return NextResponse.json({ error: e.message, reconfirmRequired: true }, { status: 400 });
    if (e instanceof ApSecondApprovalTooSoonError)
      return NextResponse.json(
        { error: e.message, tooSoon: true, secondsRemaining: e.secondsRemaining },
        { status: 400 },
      );
    if (e instanceof ApNoteRequiredError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApRequestNotFoundError)
      return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ApAlreadyDecidedError)
      return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
    if (e instanceof ApNotActionableError)
      return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
