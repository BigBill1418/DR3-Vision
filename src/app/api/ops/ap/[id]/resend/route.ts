// ADR-0046 D4 — re-send the decision email for an already-decided request. The
// recovery path when the decision-recipient list was empty at decision time
// (configure ap_decision_recipients, then re-send here). Org reach.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { ApRequestNotFoundError, sendDecisionEmail } from '@/lib/ap/approvals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    await requireApApprover();
    const { id } = await params;
    const row = await prisma.apRequest.findUnique({ where: { id }, select: { status: true } });
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (row.status !== 'approved' && row.status !== 'rejected') {
      return NextResponse.json({ error: 'only a decided request can have its decision email re-sent' }, { status: 409 });
    }
    const mail = await sendDecisionEmail(prisma, id);
    return NextResponse.json({ requestId: id, mail });
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof ApRequestNotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
