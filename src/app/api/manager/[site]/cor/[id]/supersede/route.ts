// ADR-0042 D1 — supersede a finalized COR: create a new draft version in the same
// (site, cover_month) chain. Both rows retained.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { supersedeCor } from '@/lib/cor/lifecycle';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Supersede = z.object({ notes: z.string().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const body = await req.json().catch(() => ({}));
    const parsed = Supersede.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const cert = await supersedeCor({
      siteId: ctx.siteId,
      certId: id,
      actorUserId: ctx.userId,
      ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
    });
    return NextResponse.json({ cert }, { status: 201 });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.supersede', requestId: req.headers.get('x-request-id') });
  }
}
