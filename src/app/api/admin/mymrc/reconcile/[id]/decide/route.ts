// ADR-0057 D4 — decide one reconciliation item (approve / reject / snooze).
// Admin-only. EVERY decision carries a required note (mirrors the AP decide
// boundary): validated + length-capped BEFORE any state change. Approve writes the
// operational table; reject writes nothing; snooze defers 7 days. First action wins.

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  applyReconcileDecision,
  assertReconcileNote,
  ReconNoteRequiredError,
  ReconNotActionableError,
  ReconNotFoundError,
  ReconUnsupportedTargetError,
  type ReconDecision,
} from '@/lib/reconcile/apply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Storage-DoS boundary — same cap as the AP decide route.
const NOTE_MAX_LEN = 2000;
const DECISIONS: readonly ReconDecision[] = ['approved', 'rejected', 'snoozed'];

interface DecideBody {
  decision?: string;
  note?: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let actorUserId: string;
  try {
    actorUserId = (await requireAdmin()).userId;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as DecideBody;
    if (!DECISIONS.includes(body.decision as ReconDecision)) {
      return NextResponse.json(
        { error: "decision must be 'approved', 'rejected', or 'snoozed'" },
        { status: 400 },
      );
    }
    if (typeof body.note === 'string' && body.note.length > NOTE_MAX_LEN) {
      return NextResponse.json(
        { error: `note must be ${NOTE_MAX_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    const decision = body.decision as ReconDecision;
    // Required note — throws ReconNoteRequiredError (→ 400) BEFORE any state change.
    assertReconcileNote(decision, body.note);

    const result = await applyReconcileDecision({
      prisma,
      id,
      decision,
      actorUserId,
      note: (body.note as string).trim(),
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ReconNoteRequiredError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ReconUnsupportedTargetError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ReconNotFoundError)
      return NextResponse.json({ error: e.message }, { status: 404 });
    if (e instanceof ReconNotActionableError)
      return NextResponse.json({ error: e.message, alreadyDecided: true }, { status: 409 });
    throw e;
  }
}
