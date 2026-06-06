// Manual "Month complete — ready to sign" close (ADR-0019 §5a).
//
// Lets Janette/Morena/Bill close the current DRAFT month on demand (transition
// draft -> pending_signatures) the moment the month's counts are complete, rather
// than waiting for the month-end auto-close cron. Same transition + same
// signature-request email (trigger #1) as the cron — just operator-initiated.
//
// Gated via requireBonusAccess (Woodland-scoped; Rick/operators 403). Idempotent-
// ish: a month that has already left `draft` returns 409.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireBonusAccess } from '@/lib/bonus/access';
import { transitionMonth } from '@/lib/bonus/state-machine';
import { notifyPendingSigner } from '@/lib/bonus/signature-notifications';
import { recordStateGauge } from '@/lib/bonus/signatures';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let ctx;
  try {
    ctx = await requireBonusAccess();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const { id } = await params;

  // Site-scope the month so a manager can never close another site's month by id.
  const month = await prisma.bonusPayPeriod.findFirst({
    where: { id, site_id: ctx.siteId },
    select: { id: true, state: true },
  });
  if (!month) {
    return NextResponse.json({ error: 'Bonus month not found.' }, { status: 404 });
  }
  if (month.state !== 'draft') {
    return NextResponse.json(
      { error: 'This month is already closed for signatures.' },
      { status: 409 },
    );
  }

  try {
    await transitionMonth({
      db: prisma as never,
      monthId: id,
      to: 'pending_signatures',
      actor: { userId: ctx.userId },
    });
  } catch (err) {
    log.error({ monthId: id, err }, '[close] draft -> pending_signatures failed');
    return NextResponse.json({ error: 'Could not close the month.' }, { status: 500 });
  }

  recordStateGauge(ctx.siteId, 'draft', 'pending_signatures');

  // Email the facility-manager signer (Janette), off the request path (fail-open).
  void notifyPendingSigner(id).catch((err) => {
    log.error({ monthId: id, err }, '[close] signature-request email failed (non-fatal)');
  });

  return NextResponse.json({ ok: true, state: 'pending_signatures' });
}
