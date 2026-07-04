// ADR-0042 — manager COR API: list + generate (draft). Site-scoped (hard rule #2).
// CA-only: the service throws CorJurisdictionError for an Oregon site.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { generateCorDraft, listCor } from '@/lib/cor/service';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Generate = z.object({
  coverMonth: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/),
  notes: z.string().max(1000).optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const rows = await listCor(ctx.siteId);
    return NextResponse.json({ rows });
  } catch (e) {
    return corErrorResponse(e, { site, op: 'cor.list', requestId: req.headers.get('x-request-id') });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Generate.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const cert = await generateCorDraft({
      siteId: ctx.siteId,
      coverMonthISO: parsed.data.coverMonth,
      actorUserId: ctx.userId,
      ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
    });
    return NextResponse.json({ cert }, { status: 201 });
  } catch (e) {
    return corErrorResponse(e, { site, op: 'cor.generate', requestId: req.headers.get('x-request-id') });
  }
}
