// ADR-0041 — void an invoice (discard a draft, or cancel an approved one).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { voidInvoice } from '@/lib/invoices/lifecycle';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Void = z.object({ reason: z.string().max(1000).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Void.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const invoice = await voidInvoice({
      siteId: ctx.siteId,
      invoiceId: id,
      actorUserId: ctx.userId,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    });
    return NextResponse.json({ invoice });
  } catch (e) {
    return invoiceErrorResponse(e, { site, id, op: 'invoices.void', requestId: req.headers.get('x-request-id') });
  }
}
