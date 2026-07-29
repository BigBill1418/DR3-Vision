// ADR-0068 §4 — the second signature.
//
// Approve / Reject / Hold. Reject and Hold require a note; Approve does not,
// because the substantive data was captured at submission (D7).
//
// This route is layer 1 of the three-layer control. It does NOT trust the client
// about who the actor is (that comes from the session) and it does not decide
// eligibility itself — `decideReimbursement` consults the shared resolver, and
// the database CHECK stands behind both. A hand-crafted POST from the submitter
// is refused here, and would still be refused by the constraint if it somehow
// got past.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { prisma } from '@/lib/prisma';
import {
  decideReimbursement,
  ReimbursementAlreadyDecidedError,
  ReimbursementNotEligibleError,
  ReimbursementNotFoundError,
  ReimbursementNoteRequiredError,
  type ReimbursementDecision,
} from '@/lib/reimbursements/service';
import { notifyReimbursementDecided } from '@/lib/reimbursements/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DECISIONS: readonly ReimbursementDecision[] = ['approved', 'rejected', 'held'];

export async function POST(
  req: Request,
  ctx: { params: Promise<{ site: string; id: string }> },
): Promise<Response> {
  const { site, id } = await ctx.params;

  let auth;
  try {
    auth = await requireManagerForSite(site);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const body = (await req.json().catch(() => null)) as {
    decision?: unknown;
    note?: unknown;
  } | null;
  const decision = body?.decision as ReimbursementDecision;
  if (!DECISIONS.includes(decision)) {
    return NextResponse.json({ error: 'invalid_decision' }, { status: 400 });
  }
  const note = typeof body?.note === 'string' ? body.note : undefined;

  try {
    const result = await decideReimbursement({
      prisma,
      requestId: id,
      decision,
      actor: { userId: auth.userId, role: auth.role },
      ...(note === undefined ? {} : { note }),
    });

    // Fail-soft: a mail failure must never roll back a committed decision. The
    // outcome is surfaced rather than swallowed.
    const mail = await notifyReimbursementDecided(prisma, id).catch(() => null);

    return NextResponse.json({
      ok: true,
      decision: result.decision,
      mail: mail?.mode ?? 'not_sent',
      problems: mail?.problems ?? [],
    });
  } catch (e) {
    if (
      e instanceof ReimbursementNotEligibleError ||
      e instanceof ReimbursementNoteRequiredError ||
      e instanceof ReimbursementAlreadyDecidedError ||
      e instanceof ReimbursementNotFoundError
    ) {
      return NextResponse.json({ error: 'refused', message: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
