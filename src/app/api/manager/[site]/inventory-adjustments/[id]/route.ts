// ADR-0143 D4 + Bill B4 — the SECOND person approves or rejects a proposed pool
// adjustment. The approver is never the proposer (403 `four_eyes`; the DB CHECK
// refuses it too). A decided adjustment is final (409 `already_decided`).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import { decidePoolAdjustment } from '@/lib/inventory/exception-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(2000).optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManagerSurface(site, UI_SURFACE.INVENTORY_EXCEPTIONS);
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const result = await decidePoolAdjustment({
      siteId: ctx.siteId,
      adjustmentId: id,
      decision: parsed.data.decision,
      note: parsed.data.note ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ result });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'manager.inventory_adjustment.decide',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
