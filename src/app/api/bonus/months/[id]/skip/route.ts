// T-203 — Skip a draft pay period (ADR-0019.1 "Bootstrapping question", ADMIN-ONLY).
//
// POST /api/bonus/months/<id>/skip — transition a `draft` pay period to the
// terminal `skipped` state. This is the deploy-time disposition for a period that
// has no real data (e.g. Period 12 of 2026 at cutover): no fabricated counts, no
// signature workflow, no payroll PDF. A skipped period is permanently inert —
// daily-entry mutations and the signature workflow both refuse it.
//
// Gates through `requireBonusAccess()` (site-scoped) AND additionally requires
// `ctx.isAdmin` — managers (Janette / Morena / Rick) get 403 here, server-side,
// never trusting the client (CLAUDE.md hard rule #6). The state machine enforces
// the same admin-only constraint as a backstop (`draft -> skipped` is in
// ADMIN_ONLY_TRANSITIONS).
//
// Idempotent-ish: a period that has already left `draft` returns 409 (the state
// machine rejects any non-`draft -> skipped` edge).

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireBonusAccess } from '@/lib/bonus/access';
import {
  transitionMonth,
  TransitionError,
  TransitionForbiddenError,
} from '@/lib/bonus/state-machine';
import { recordStateGauge } from '@/lib/bonus/signatures';
import { log } from '@/lib/observability/logger';

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
  // Admin-only (Bill / Kelsey). Managers — incl. Janette/Morena/Rick — are denied.
  if (!ctx.isAdmin) {
    return NextResponse.json(
      { error: 'Skipping a pay period is restricted to administrators.' },
      { status: 403 },
    );
  }

  const { id } = await params;

  // Site-scope the period so an admin can never skip another site's period by id.
  const period = await prisma.bonusPayPeriod.findFirst({
    where: { id, site_id: ctx.siteId },
    select: { id: true, state: true },
  });
  if (!period) {
    return NextResponse.json({ error: 'Bonus pay period not found.' }, { status: 404 });
  }
  if (period.state !== 'draft') {
    return NextResponse.json(
      { error: `This pay period is ${period.state}; only a draft period can be skipped.` },
      { status: 409 },
    );
  }

  try {
    await transitionMonth({
      db: prisma as never,
      monthId: id,
      to: 'skipped',
      actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
      ip: clientIp(req),
      userAgent: req.headers.get('user-agent'),
    });
  } catch (err) {
    if (err instanceof TransitionForbiddenError) {
      return NextResponse.json(
        { error: 'Skipping a pay period is restricted to administrators.' },
        { status: 403 },
      );
    }
    if (err instanceof TransitionError) {
      return NextResponse.json(
        { error: 'This pay period can no longer be skipped.' },
        { status: 409 },
      );
    }
    log.error({ periodId: id, err }, '[skip] draft -> skipped failed');
    return NextResponse.json({ error: 'Could not skip the pay period.' }, { status: 500 });
  }

  recordStateGauge(ctx.siteId, 'draft', 'skipped');

  return NextResponse.json({ ok: true, state: 'skipped' });
}
