// ADR-0041 — invoice detail (invoice + lines + inline gate verdict + prior version).

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { getInvoiceDetail } from '@/lib/invoices/service';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const detail = await getInvoiceDetail(ctx.siteId, id);
    if (!detail) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    return invoiceErrorResponse(e, { site, id, op: 'invoices.get', requestId: req.headers.get('x-request-id') });
  }
}
