// ADR-0072 — release or discard a held count REMOTELY.
//
// The other half of the Tier 2 gate: when no manager is on the floor, the count
// waits and a manager approves from their own screen. The manager's own session
// is the identity here — no PIN, because a desktop session already IS the
// authentication, and asking for a second factor a manager does not carry on
// desktop would just push people toward releasing everything at the iPad.
//
// `releaseHold` applies the same three checks regardless of path: still pending,
// eligible approver, and never the operator who entered it. A manager who also
// happens to have entered the count on the floor cannot release it from their
// desk either — the rule is about the person, not the surface.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { checkManagerForSite } from '@/lib/auth-helpers';
import {
  HoldNotFoundError,
  HoldNotPendingError,
  NotAManagerError,
  SelfReleaseRefusedError,
  discardHold,
  releaseHold,
} from '@/lib/inventory/anchor-holds';
import { log } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ site: string; holdId: string }> };

function mapError(e: unknown): Response | null {
  if (e instanceof SelfReleaseRefusedError) {
    return NextResponse.json(
      {
        error: 'operator_cannot_self_release',
        message: 'You entered this count. Someone else must approve it.',
      },
      { status: 403 },
    );
  }
  if (e instanceof NotAManagerError) {
    return NextResponse.json({ error: 'not_a_manager' }, { status: 403 });
  }
  if (e instanceof HoldNotFoundError) {
    return NextResponse.json({ error: 'hold_not_found' }, { status: 404 });
  }
  if (e instanceof HoldNotPendingError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  return null;
}

export async function POST(_req: Request, { params }: Params) {
  const { site, holdId } = await params;
  const gate = await checkManagerForSite(site);
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  try {
    const out = await releaseHold(prisma, {
      holdId,
      approverUserId: gate.ctx.userId,
      path: 'remote',
    });
    return NextResponse.json({
      released: true,
      snapshotId: out.snapshotId,
      newTotal: out.classification.newTotal,
      priorTotal: out.classification.prior?.total ?? null,
    });
  } catch (e) {
    const mapped = mapError(e);
    if (mapped) return mapped;
    log.error({ err: e, holdId }, '[anchor-hold] remote release failed');
    return NextResponse.json({ error: 'release_failed' }, { status: 500 });
  }
}

const Discard = z.object({ reason: z.string().min(1).max(500) });

export async function DELETE(req: Request, { params }: Params) {
  const { site, holdId } = await params;
  const gate = await checkManagerForSite(site);
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: gate.status });

  const parsed = Discard.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'reason_required' }, { status: 422 });

  try {
    await discardHold(prisma, {
      holdId,
      userId: gate.ctx.userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ discarded: true });
  } catch (e) {
    const mapped = mapError(e);
    if (mapped) return mapped;
    log.error({ err: e, holdId }, '[anchor-hold] remote discard failed');
    return NextResponse.json({ error: 'discard_failed' }, { status: 500 });
  }
}
