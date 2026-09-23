// ADR-0135 F — the "possible duplicates" queue.
//
// GET  /api/admin/equipment/duplicates            -> { pairs: DuplicatePair[] }
// POST /api/admin/equipment/duplicates { aId, bId, reason }
//   -> records "these two are DIFFERENT assets" so the pair stops being proposed
//
// ADMIN-ONLY, like the merge it feeds (ADR-0075: declaring two records the same —
// or different — physical machine is a judgement about financial evidence; hard
// rule #2 keeps admin POWERS on `role === 'admin'`). The matcher proposes; the
// admin disposes, one pair at a time. Merging is the sibling `merge` route.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin } from '@/lib/auth-helpers';
import { listPossibleDuplicates, markEquipmentDistinct } from '@/lib/admin-equipment';
import { OVERRIDE_REASON_MAX } from '@/app/admin/constants';
import { adminMessages as M } from '@/app/admin/messages';
import { actorFrom } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  return NextResponse.json({ pairs: await listPossibleDuplicates() });
}

const distinctSchema = z.object({
  aId: z.string().min(1),
  bId: z.string().min(1),
  reason: z.string().max(OVERRIDE_REASON_MAX),
});

export async function POST(req: Request): Promise<Response> {
  let ctx;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const parsed = distinctSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: M.errors.invalidPayload }, { status: 422 });
  }
  const r = await markEquipmentDistinct(
    parsed.data.aId,
    parsed.data.bId,
    parsed.data.reason,
    actorFrom(req, ctx.userId),
  );
  if (r.ok) return NextResponse.json({ ok: true });
  switch (r.reason) {
    case 'not_found':
      return NextResponse.json({ error: M.equipment.notFound }, { status: 404 });
    case 'same_row':
      return NextResponse.json({ error: M.equipment.mergeSameRow }, { status: 422 });
    case 'reason_required':
      return NextResponse.json({ error: M.equipment.distinctReasonRequired }, { status: 422 });
  }
}
