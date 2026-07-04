// ADR-0042 D2.2 — enter the FT/PT headcount split at review (draft only).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { setCorHeadcountSplit } from '@/lib/cor/service';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Headcount = z.object({
  ftHeadcount: z.number().int().min(0).max(100000),
  ptHeadcount: z.number().int().min(0).max(100000),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Headcount.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const cert = await setCorHeadcountSplit({
      siteId: ctx.siteId,
      certId: id,
      ftHeadcount: parsed.data.ftHeadcount,
      ptHeadcount: parsed.data.ptHeadcount,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ cert });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.headcount', requestId: req.headers.get('x-request-id') });
  }
}
