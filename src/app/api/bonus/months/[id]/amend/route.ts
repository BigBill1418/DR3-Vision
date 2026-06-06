// T-116 — Amendment unlock endpoint (ADR-0019 §6, ADMIN-ONLY).
//
// POST /api/bonus/months/<id>/amend — unlock a `signed` or `paid` Woodland bonus
// month for correction. Gates through `requireBonusAccess()` (Woodland scope) AND
// additionally requires `ctx.isAdmin` — Janette, Morena, and Rick can never reach
// this (managers get 403). A free-text reason is REQUIRED (ADR-0019 §6).
//
// On success the data layer transitions signed|paid -> amended, clears BOTH
// signature column sets (preserving the prior signed state in an audit row), and
// sets the amended_* tracking columns — all in one transaction. Daily entries
// become editable again while `amended`.

import { NextResponse } from 'next/server';
import { requireBonusAccess } from '@/lib/bonus/access';
import { prisma } from '@/lib/prisma';
import { unlockMonthForAmendment, type AmendmentDb } from '@/lib/bonus/amendment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
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
  // Admin-only (Bill / Kelsey). Managers — incl. Janette/Morena — are denied.
  if (!ctx.isAdmin) {
    return NextResponse.json(
      { error: 'Amending a month is restricted to administrators.' },
      {
        status: 403,
      },
    );
  }

  const { id } = await params;

  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = typeof body?.reason === 'string' ? body.reason : '';

  const result = await unlockMonthForAmendment({
    db: prisma as unknown as AmendmentDb,
    monthId: id,
    siteId: ctx.siteId,
    actor: { userId: ctx.userId, ip: clientIp(req), userAgent: req.headers.get('user-agent') },
    reason,
  });

  if (result.ok) {
    return NextResponse.json({ ok: true, state: result.state }, { status: 200 });
  }
  switch (result.reason) {
    case 'not_found':
      return NextResponse.json({ error: 'Bonus month not found.' }, { status: 404 });
    case 'missing_reason':
      return NextResponse.json(
        { error: 'A reason is required to unlock this month for amendment.' },
        { status: 422 },
      );
    case 'wrong_state':
      return NextResponse.json(
        { error: `This month is ${result.state}; only a signed or paid month can be amended.` },
        { status: 409 },
      );
    default:
      return NextResponse.json({ error: 'Server error.' }, { status: 500 });
  }
}
