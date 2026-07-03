// ADR-0037 D4/D6 — landfilled_units edit-before-lock (PATCH).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { updateLandfilledUnit } from '@/lib/loads/landfilled';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REASONS = ['bed_bug', 'soiled', 'water_logged', 'other'] as const;

const Patch = z.object({
  units: z.number().int().positive().optional(),
  programUnits: z.number().int().nonnegative().optional(),
  nonProgramUnits: z.number().int().nonnegative().optional(),
  reason: z.enum(REASONS).optional(),
  slipNumber: z.string().max(120).nullable().optional(),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Patch.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const row = await updateLandfilledUnit({ id, siteId: ctx.siteId, actorUserId: ctx.userId, ...parsed.data });
    return NextResponse.json({ row });
  } catch (e) {
    return loadsErrorResponse(e);
  }
}
