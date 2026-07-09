// ADR-0046 D4 — AP queue list (org reach: admin or all_sites). AP requests are
// org-level accounting records, NOT site-scoped — the surface reaches admins +
// all_sites managers (hard rule #2 site-reach, never admin powers).

import { NextResponse } from 'next/server';
import { requireApApprover } from '@/lib/ap/approvers';
import { isApListFilter, listApRequests } from '@/lib/ap/queue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  try {
    await requireApApprover();
    const statusParam = new URL(req.url).searchParams.get('status');
    const filter = isApListFilter(statusParam) ? statusParam : 'pending';
    const { rows, counts } = await listApRequests(filter);
    return NextResponse.json({ rows, counts, filter });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
