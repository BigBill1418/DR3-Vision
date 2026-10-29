// ADR-0143 + Bill B4 — close an inventory exception WITHOUT an adjustment (e.g. a
// count already reset the pool). POST proposes (the pool must be >= 0 now); PUT
// approves, by a different person. Four-eyes is enforced here and by a DB CHECK.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import {
  MIN_REASON_CHARS,
  approveExceptionResolution,
  proposeExceptionResolution,
} from '@/lib/inventory/exception-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Approve = z.object({ expectedProposedAt: z.string().datetime() });

const Propose = z.object({ note: z.string().min(MIN_REASON_CHARS).max(2000) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.INVENTORY_EXCEPTIONS);
    const parsed = Propose.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    await proposeExceptionResolution({
      siteId: ctx.siteId,
      exceptionId: id,
      note: parsed.data.note,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'manager.inventory_exception.propose_resolution',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.INVENTORY_EXCEPTIONS);
    // The approver confirms the exact proposal they saw (four-eyes TOCTOU guard).
    const parsed = Approve.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    await approveExceptionResolution({
      siteId: ctx.siteId,
      exceptionId: id,
      actorUserId: ctx.userId,
      expectedProposedAt: parsed.data.expectedProposedAt,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'manager.inventory_exception.approve_resolution',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
