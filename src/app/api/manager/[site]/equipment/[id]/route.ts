// ADR-0044 D1 — equipment_events edit + soft-void.
//
//   PATCH  → edit (freely editable; every write audited)
//   DELETE → SOFT-void (sets voided_at; NO hard delete — hard rule #6). The row is
//            retained and excluded from derived series; the void is itself audited.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { updateEquipmentEvent, voidEquipmentEvent } from '@/lib/equipment/service';
import { equipmentErrorResponse } from '@/lib/equipment/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['downtime', 'maintenance', 'repair', 'cost', 'note'] as const;

const Patch = z.object({
  kind: z.enum(KINDS).optional(),
  equipmentCode: z.string().trim().min(1).max(60).optional(),
  hoursDown: z.number().nonnegative().max(999.99).nullable().optional(),
  costCents: z.number().int().nonnegative().nullable().optional(),
  vendor: z.string().max(200).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await updateEquipmentEvent({ id, siteId: ctx.siteId, actorUserId: ctx.userId, ...parsed.data });
    return NextResponse.json({ row });
  } catch (e) {
    return equipmentErrorResponse(e, { site, id, op: 'equipment.update', requestId: req.headers.get('x-request-id') });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const row = await voidEquipmentEvent({ id, siteId: ctx.siteId, actorUserId: ctx.userId });
    return NextResponse.json({ row });
  } catch (e) {
    return equipmentErrorResponse(e, { site, id, op: 'equipment.void', requestId: req.headers.get('x-request-id') });
  }
}
