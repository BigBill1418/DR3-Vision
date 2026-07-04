// ADR-0042 D1 — void a COR (discard a draft, or cancel a finalized one).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { voidCor } from '@/lib/cor/lifecycle';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Void = z.object({ reason: z.string().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const body = await req.json().catch(() => ({}));
    const parsed = Void.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const cert = await voidCor({
      siteId: ctx.siteId,
      certId: id,
      actorUserId: ctx.userId,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    return NextResponse.json({ cert });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.void', requestId: req.headers.get('x-request-id') });
  }
}
