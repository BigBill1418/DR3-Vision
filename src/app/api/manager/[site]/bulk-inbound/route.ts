// ADR-0037 Phase 3 (§3.2 option b) — bulk daily inbound manager API (list + upsert).
//
// Site-scoped + D7 activation-gated via `requireActivatedManager`, identical to the
// other manager loads/inventory surfaces. POST writes (or amends) the ONE
// `paper_bulk` aggregate row for that site + day; the split invariant is enforced in
// the service, never here.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { upsertBulkInboundDay, listBulkInboundDays } from '@/lib/loads/bulk-inbound';
import { requireActivatedManager, loadsErrorResponse, clampLimit } from '@/lib/loads/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Upsert = z.object({
  inboundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalUnits: z.number().int().positive(),
  programUnits: z.number().int().nonnegative(),
  nonProgramUnits: z.number().int().nonnegative(),
  slipNumber: z.string().max(120).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const limit = clampLimit(new URL(req.url).searchParams.get('limit'), 60);
    return NextResponse.json({ rows: await listBulkInboundDays(ctx.siteId, limit) });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'bulk-inbound.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireActivatedManager(site);
    const parsed = Upsert.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const d = parsed.data;
    const row = await upsertBulkInboundDay({
      siteId: ctx.siteId,
      inboundDate: new Date(`${d.inboundDate}T00:00:00Z`),
      totalUnits: d.totalUnits,
      programUnits: d.programUnits,
      nonProgramUnits: d.nonProgramUnits,
      slipNumber: d.slipNumber ?? null,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ row }, { status: 201 });
  } catch (e) {
    return loadsErrorResponse(e, {
      site,
      op: 'bulk-inbound.upsert',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
