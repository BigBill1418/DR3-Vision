// ADR-0072 — release or discard a held count FROM THE DEVICE.
//
// This is the on-floor path: a manager walks over, picks their name, enters
// their PIN on the same iPad, and the count writes immediately. ADR-0072 Am.2:
// the PIN is the floor PIN of the operator account linked to their manager
// account (`floor_user_id`); a manager with no link is told to use the desktop. It reuses the
// existing operator-PIN mechanism — no new login surface, no session change, and
// the operator's session is never elevated.
//
// ── What the operator's session buys, and what it does not ──────────────────
// The operator session gets you to this route and no further. Releasing requires
// a DIFFERENT person's identity plus their PIN, and `releaseHold` refuses when
// the approver is the operator who entered the count — checked before the PIN, so
// a self-release attempt cannot be used to probe whether a PIN is correct.
//
// DELETE discards a hold. Discarding writes nothing to inventory, so an operator
// may do it: abandoning your own mistyped count is not a privileged act. It is
// recorded with a reason either way.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireActivatedOperator, loadsErrorResponse } from '@/lib/loads/route-helpers';
import { UI_SURFACE } from '@/lib/notify/rollout';
import {
  BadPinError,
  HoldNotFoundError,
  HoldNotPendingError,
  NoFloorPinError,
  PinLockedError,
  NotAManagerError,
  SelfReleaseRefusedError,
  discardHold,
  isHoldAtSite,
  releaseHold,
} from '@/lib/inventory/anchor-holds';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Release = z.object({
  approverUserId: z.string().min(1),
  pin: z.string().min(1),
});

type Params = { params: Promise<{ site: string; holdId: string }> };

function mapError(e: unknown): Response | null {
  if (e instanceof SelfReleaseRefusedError) {
    return NextResponse.json(
      {
        error: 'operator_cannot_self_release',
        message:
          'The person who entered this count cannot release it. A manager must approve, on this device or from their own screen.',
      },
      { status: 403 },
    );
  }
  if (e instanceof NotAManagerError) {
    return NextResponse.json({ error: 'not_a_manager' }, { status: 403 });
  }
  // ADR-0072 Am.2 — the picked manager's account has no linked floor (operator)
  // account, so no PIN can work here. 403, not 401: the client reads a bare 401
  // as an expired operator session. Decided before any PIN is verified, so it
  // reveals nothing about the PIN and burns no lockout attempt.
  if (e instanceof NoFloorPinError) {
    return NextResponse.json(
      {
        error: 'no_floor_pin',
        message:
          'This manager has no floor PIN. Approve from the desktop Held counts page instead.',
      },
      { status: 403 },
    );
  }
  // The linked floor account is locked out after repeated wrong PINs. 423, not
  // 401 (a bare 401 reads as an expired session) — and only reachable after the
  // PIN path was already chosen for an eligible approver, so it leaks nothing.
  if (e instanceof PinLockedError) {
    return NextResponse.json({ error: 'pin_locked' }, { status: 423 });
  }
  // A wrong PIN is 401 and says nothing about whether the name exists.
  if (e instanceof BadPinError) {
    return NextResponse.json({ error: 'bad_pin' }, { status: 401 });
  }
  if (e instanceof HoldNotFoundError) {
    return NextResponse.json({ error: 'hold_not_found' }, { status: 404 });
  }
  if (e instanceof HoldNotPendingError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  return null;
}

export async function POST(req: Request, { params }: Params) {
  const { site, holdId } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT);
    const parsed = Release.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    if (!(await isHoldAtSite(prisma, holdId, ctx.siteId))) {
      return NextResponse.json({ error: 'hold_not_found' }, { status: 404 });
    }

    const out = await releaseHold(prisma, {
      holdId,
      approverUserId: parsed.data.approverUserId,
      path: 'pin',
      pin: parsed.data.pin,
    });
    return NextResponse.json(
      {
        released: true,
        snapshotId: out.snapshotId,
        newTotal: out.classification.newTotal,
        priorTotal: out.classification.prior?.total ?? null,
      },
      { status: 200 },
    );
  } catch (e) {
    const mapped = mapError(e);
    if (mapped) return mapped;
    return loadsErrorResponse(e, {
      site,
      op: 'operator.count.hold.release',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

const Discard = z.object({ reason: z.string().min(1).max(500) });

export async function DELETE(req: Request, { params }: Params) {
  const { site, holdId } = await params;
  try {
    const ctx = await requireActivatedOperator(site, UI_SURFACE.IPAD_COUNT);
    const parsed = Discard.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'reason_required' }, { status: 422 });
    if (!(await isHoldAtSite(prisma, holdId, ctx.siteId))) {
      return NextResponse.json({ error: 'hold_not_found' }, { status: 404 });
    }

    await discardHold(prisma, {
      holdId,
      userId: ctx.userId,
      reason: parsed.data.reason,
    });
    return NextResponse.json({ discarded: true }, { status: 200 });
  } catch (e) {
    const mapped = mapError(e);
    if (mapped) return mapped;
    return loadsErrorResponse(e, {
      site,
      op: 'operator.count.hold.discard',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
