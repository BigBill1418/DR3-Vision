// ADR-0042 D3 — finalize a draft COR (the freeze). Manager-of-site or admin;
// requires the FT/PT split; re-asserts the inventory reconcile tripwire. A human
// signs the printed copy — the rendered signature block is empty.

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { finalizeCor } from '@/lib/cor/lifecycle';
import { corErrorResponse, resolveFinalizer } from '@/lib/cor/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const finalizer = await resolveFinalizer(ctx.siteId);
    const cert = await finalizeCor({ siteId: ctx.siteId, certId: id, finalizer });
    return NextResponse.json({ cert });
  } catch (e) {
    return corErrorResponse(e, { site, id, op: 'cor.finalize', requestId: req.headers.get('x-request-id') });
  }
}
