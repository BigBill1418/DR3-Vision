// ADR-0037 D4/D6 — landfilled_units manager API (list + create). Program split
// validated in the service (program + non-program == units).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createLandfilledUnit, listLandfilledUnits } from '@/lib/loads/landfilled';
import { requireActivatedManager, loadsErrorResponse } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REASONS = ['bed_bug', 'soiled', 'water_logged', 'other'] as const;

const Create = z.object({
  disposalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  units: z.number().int().positive(),
  programUnits: z.number().int().nonnegative(),
  nonProgramUnits: z.number().int().nonnegative(),
  reason: z.enum(REASONS),
  slipNumber: z.string().max(120).optional(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    return NextResponse.json({ rows: await listLandfilledUnits(ctx.siteId) });
  } catch (e) {
    return loadsErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await createLandfilledUnit({
      siteId: ctx.siteId,
      disposalDate: new Date(`${d.disposalDate}T00:00:00Z`),
      units: d.units,
      programUnits: d.programUnits,
      nonProgramUnits: d.nonProgramUnits,
      reason: d.reason,
      slipNumber: d.slipNumber ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e);
  }
}
