// 2026-07-09 rollup §1.4 — walk a credit memo one legal state-machine step
// (proposed → sent_to_mrc → accepted | rejected → applied |
// void_and_reissue_triggered). Illegal jumps 409 with the allowed set; the
// reissue step generates the superseding draft via the ADR-0041 supersede chain.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { transitionCreditMemo } from '@/lib/invoices/credit-memos';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Transition = z.object({
  to: z.enum(['sent_to_mrc', 'accepted', 'rejected', 'applied', 'void_and_reissue_triggered']),
  note: z.string().max(1000).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ site: string; memoId: string }> },
) {
  const { site, memoId } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const parsed = Transition.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
    const memo = await transitionCreditMemo({
      siteId: ctx.siteId,
      memoId,
      to: parsed.data.to,
      actorUserId: ctx.userId,
      ...(parsed.data.note ? { note: parsed.data.note } : {}),
    });
    return NextResponse.json({ memo });
  } catch (e) {
    return invoiceErrorResponse(e, {
      site,
      id: memoId,
      op: 'credit_memos.transition',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
