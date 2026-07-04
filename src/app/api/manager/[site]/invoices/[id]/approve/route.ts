// ADR-0041 D4 — approve a draft invoice (the freeze). Trust-gate enforced;
// super-admin may override with a justification.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { approveInvoice } from '@/lib/invoices/lifecycle';
import { invoiceErrorResponse, resolveApprover } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Approve = z.object({
  overrideJustification: z.string().min(1).max(2000).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ site: string; id: string }> }) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const approver = await resolveApprover(ctx.siteId);
    const body = await req.json().catch(() => ({}));
    const parsed = Approve.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const invoice = await approveInvoice({
      siteId: ctx.siteId,
      invoiceId: id,
      approver,
      ...(parsed.data.overrideJustification ? { gateOverride: { justification: parsed.data.overrideJustification } } : {}),
    });
    return NextResponse.json({ invoice });
  } catch (e) {
    return invoiceErrorResponse(e, { site, id, op: 'invoices.approve', requestId: req.headers.get('x-request-id') });
  }
}
