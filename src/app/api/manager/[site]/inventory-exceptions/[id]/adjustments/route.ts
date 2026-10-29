// ADR-0143 D4 + Bill B4 — a site manager PROPOSES a pool adjustment against an open
// inventory exception. Moves nothing until a second person approves it
// (`/api/manager/[site]/inventory-adjustments/[id]`). Site-scoped; born pilot
// (`inventory_exceptions` rollout surface).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { UI_SURFACE } from '@/lib/notify/rollout';
import { loadsErrorResponse, requireActivatedManagerSurface } from '@/lib/loads/route-helpers';
import { MIN_REASON_CHARS, proposePoolAdjustment } from '@/lib/inventory/exception-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fromPool: z.enum(['program', 'non_program']),
  toPool: z.enum(['program', 'non_program']),
  units: z.number().positive().max(100_000),
  reason: z.string().min(MIN_REASON_CHARS).max(2000),
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
    const adjustment = await proposePoolAdjustment({
      siteId: ctx.siteId,
      exceptionId: id,
      ...parsed.data,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ adjustment }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      id,
      op: 'manager.inventory_exception.propose_adjustment',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
