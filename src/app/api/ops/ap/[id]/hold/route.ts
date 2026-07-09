// ADR-0046 Amendment 3 — place a pending request ON HOLD ("pending review") or
// update the hold note. Same permission surface as decide (admin OR active
// approver); email can only CREATE requests, so a hold requires an authenticated
// Vision session over the stored record. First-action-wins (atomic) mirrors decide.
//
//   POST  → place hold (pending → pending_review), REQUIRED hold note.
//   PATCH → update the hold note on an on-hold request, REQUIRED note.

import { NextResponse } from 'next/server';
import { requireApApprover } from '@/lib/ap/approvers';
import {
  ApAlreadyDecidedError,
  ApNoteRequiredError,
  ApNotActionableError,
  ApRequestNotFoundError,
  holdRequest,
  updateHoldNote,
} from '@/lib/ap/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface HoldBody {
  note?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as HoldBody;
    const note = typeof body.note === 'string' ? body.note : '';
    const result = await holdRequest({ requestId: id, actorUserId: identity.userId, note });
    return NextResponse.json(result);
  } catch (e) {
    return mapError(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as HoldBody;
    const note = typeof body.note === 'string' ? body.note : '';
    await updateHoldNote({ requestId: id, actorUserId: identity.userId, note });
    return NextResponse.json({ requestId: id, updated: true });
  } catch (e) {
    return mapError(e);
  }
}

function mapError(e: unknown): Response {
  if (e instanceof Response) return e;
  if (e instanceof ApNoteRequiredError) return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof ApRequestNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
  if (e instanceof ApAlreadyDecidedError) {
    return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
  }
  if (e instanceof ApNotActionableError) return NextResponse.json({ error: e.message }, { status: 409 });
  throw e;
}
