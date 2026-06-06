// T-116 — Amendment re-submission endpoint (ADR-0019 §6, ADMIN-ONLY).
//
// POST /api/bonus/months/<id>/resubmit — re-submit an `amended` Woodland month
// for re-signature. Gates through `requireBonusAccess()` (Woodland scope) AND
// additionally requires `ctx.isAdmin` (managers get 403). Transitions
// amended -> pending_signatures via the data layer / state machine, then
// re-prompts the next signer (Janette) off the request path (ADR-0019 §5a).
// The normal dual-signature flow (T-110) runs again; a subsequent re-sign
// produces an AMENDED PDF (the month now self-references amended_from_month_id).

import { NextResponse } from 'next/server';
import { requireBonusAccess } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { resubmitAmendedMonth, type AmendmentDb } from '@/lib/bonus/amendment';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/** Email the next signer after re-opening, off the request path (fail-open). */
function triggerSignaturePrompt(monthId: string): void {
  void notifyPendingSigner(monthId).catch((err) => {
    log.error({ monthId, err }, '[resubmit] signature-request email failed (non-fatal)');
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireBonusAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  if (!ctx.isAdmin) {
    return NextResponse.json(
      { error: 'Re-submitting a month is restricted to administrators.' },
      { status: 403 },
    );
  }

  const { id } = await params;

  const result = await resubmitAmendedMonth({
    db: prisma as unknown as AmendmentDb,
    monthId: id,
    siteId: ctx.siteId,
    actor: { userId: ctx.userId, ip: clientIp(req), userAgent: req.headers.get('user-agent') },
  });

  if (result.ok) {
    triggerSignaturePrompt(id);
    return NextResponse.json({ ok: true, state: result.state }, { status: 200 });
  }
  switch (result.reason) {
    case 'not_found':
      return NextResponse.json({ error: 'Bonus month not found.' }, { status: 404 });
    case 'wrong_state':
      return NextResponse.json(
        {
          error: `This month is ${result.state}; only an amended month can be re-submitted for signatures.`,
        },
        { status: 409 },
      );
    default:
      return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}
