// ADR-0042 — COR detail (cert + prior version for diff + live reconcile verdict).

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { getCorDetail } from '@/lib/cor/service';
import { corErrorResponse } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const detail = await getCorDetail(ctx.siteId, id);
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.detail', requestId: req.headers.get('x-request-id') });
  }
}
