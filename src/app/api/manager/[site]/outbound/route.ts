// ADR-0037 D4 — outbound_materials manager API (list + create).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createOutbound, listOutbound } from '@/lib/loads/outbound';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMMODITIES = [
  'trash', 'toppers', 'foam', 'metal', 'wood', 'cardboard', 'plastic', 'shoddy', 'cotton',
] as const;
const SUB_CATEGORIES = ['renovation', 'baled', 'shredded'] as const;

const Create = z.object({
  shipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  commodity: z.enum(COMMODITIES),
  subCategory: z.enum(SUB_CATEGORIES),
  weightLbs: z.number().int().nonnegative(),
  wholeUnits: z.number().int().positive().nullable().optional(),
  programUnits: z.number().int().nonnegative().nullable().optional(),
  nonProgramUnits: z.number().int().nonnegative().nullable().optional(),
  ticketNumber: z.string().max(120).optional(),
  retracId: z.string().max(120).optional(),
  baleCount: z.number().int().nonnegative().optional(),
  buyer: z.string().max(200).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 100);
    return NextResponse.json({ rows: await listOutbound(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'outbound.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Create.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await createOutbound({
      siteId: ctx.siteId,
      shipDate: new Date(`${d.shipDate}T00:00:00Z`),
      commodity: d.commodity,
      subCategory: d.subCategory,
      weightLbs: d.weightLbs,
      wholeUnits: d.wholeUnits ?? null,
      programUnits: d.programUnits ?? null,
      nonProgramUnits: d.nonProgramUnits ?? null,
      ticketNumber: d.ticketNumber ?? null,
      retracId: d.retracId ?? null,
      baleCount: d.baleCount ?? null,
      buyer: d.buyer ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, { site, op: 'outbound.create', requestId: req.headers.get('x-request-id') });
  }
}
