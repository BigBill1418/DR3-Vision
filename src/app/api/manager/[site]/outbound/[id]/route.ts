// ADR-0037 D4 — outbound_materials edit-before-lock (PATCH).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateOutbound } from '@/lib/loads/outbound';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Patch = z.object({
  subCategory: z.enum(['renovation', 'baled', 'shredded']).optional(),
  weightLbs: z.number().int().nonnegative().optional(),
  wholeUnits: z.number().int().positive().nullable().optional(),
  programUnits: z.number().int().nonnegative().nullable().optional(),
  nonProgramUnits: z.number().int().nonnegative().nullable().optional(),
  ticketNumber: z.string().max(120).nullable().optional(),
  retracId: z.string().max(120).nullable().optional(),
  baleCount: z.number().int().nonnegative().nullable().optional(),
  buyer: z.string().max(200).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await updateOutbound({ id, siteId: ctx.siteId, actorUserId: ctx.userId, ...parsed.data });
    return NextResponse.json({ row });
  } catch (e) {
    return loadsErrorResponse(e);
  }
}
