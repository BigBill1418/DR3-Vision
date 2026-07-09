// 2026-07-09 rollup §1.4 (ADR-0041 addendum) — raise a credit memo against an
// APPROVED invoice (the over-billed correction path; MRC acceptance required
// before it can ever apply — see src/lib/invoices/credit-memos.ts).

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { createCreditMemo } from '@/lib/invoices/credit-memos';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Create = z.object({
  amountCents: z.number().int().positive(),
  reason: z.string().min(1).max(1000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ site: string; id: string }> },
) {
  const { site, id } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Create.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const memo = await createCreditMemo({
      siteId: ctx.siteId,
      invoiceId: id,
      amountCents: parsed.data.amountCents,
      reason: parsed.data.reason,
      actorUserId: ctx.userId,
    });
    return NextResponse.json({ memo }, { status: 201 });
  } catch (e) {
    return invoiceErrorResponse(e, {
      site,
      id,
      op: 'credit_memos.create',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
