// ADR-0046 D4 — decide an AP request (approve/reject). Org reach; first action
// wins, atomically. Email can only CREATE requests — this decision requires an
// authenticated Vision session over the stored record (D6).

import { NextResponse } from 'next/server';
import { requireOrgReach } from '@/lib/ops/viewer';
import {
  ApAlreadyDecidedError,
  ApNotActionableError,
  ApRequestNotFoundError,
  decideRequest,
  type ApDecision,
} from '@/lib/ap/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface DecideBody {
  decision?: string;
  note?: string;
  vendor?: string;
  amountCents?: number;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireOrgReach();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as DecideBody;
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return NextResponse.json({ error: "decision must be 'approved' or 'rejected'" }, { status: 400 });
    }
    const amountCents =
      typeof body.amountCents === 'number' && Number.isFinite(body.amountCents) && body.amountCents >= 0
        ? Math.round(body.amountCents)
        : undefined;

    const result = await decideRequest({
      requestId: id,
      decision: body.decision as ApDecision,
      actorUserId: identity.userId,
      ...(typeof body.note === 'string' && body.note.trim() ? { note: body.note.trim() } : {}),
      ...(typeof body.vendor === 'string' && body.vendor.trim() ? { vendor: body.vendor.trim() } : {}),
      ...(amountCents !== undefined ? { amountCents } : {}),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApRequestNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ApAlreadyDecidedError) {
      return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
    }
    if (e instanceof ApNotActionableError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
