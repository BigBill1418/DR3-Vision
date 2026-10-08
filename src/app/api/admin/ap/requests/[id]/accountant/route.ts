// ADR-0141 — an admin corrects the accountant a team submission was routed to.
//
// The accountant is fixed at submit (Bill, 2026-10-08); this is the only way to
// change it. Admin-only, audited, and it re-sends whatever mail the corrected
// accountant should already have (the decision, or the hold notice).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { TeamCorrectionError, correctTeamAccountant } from '@/lib/ap/team-submit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({ accountant_id: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { id } = await params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_request' }, { status: 422 });
  try {
    const result = await correctTeamAccountant({
      requestId: id,
      accountantId: parsed.data.accountant_id,
      actorUserId: ctx.userId,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof TeamCorrectionError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status });
    }
    throw e;
  }
}
