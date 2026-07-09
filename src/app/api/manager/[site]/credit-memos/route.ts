// 2026-07-09 rollup §1.4 — site-scoped credit-memo list (manager read).

import { NextResponse } from 'next/server';
import { requireManagerForSite } from '@/lib/auth-helpers';
import { listCreditMemos } from '@/lib/invoices/credit-memos';
import { invoiceErrorResponse } from '@/lib/invoices/route-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ site: string }> }) {
  const { site } = await params;
  try {
    const ctx = await requireManagerForSite(site);
    const memos = await listCreditMemos(ctx.siteId);
    return NextResponse.json({ memos });
  } catch (e) {
    return invoiceErrorResponse(e, {
      site,
      op: 'credit_memos.list',
      requestId: req.headers.get('x-request-id'),
    });
  }
}
