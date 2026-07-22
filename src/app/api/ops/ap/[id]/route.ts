// ADR-0046 D4 — AP request detail (org reach). Returns the sanitized body (for
// the sandboxed-iframe render), attachments, and follow-ups.
//
// ADR-0046 Amendment 5 (D-M5-3) — for a request AWAITING second approval, the
// response also carries a viewer-scoped `secondApproval` block: whether THIS viewer
// may fulfill it, whether they were the first approver (self-fulfillment path), and
// the residual self-reconfirm wait. Authorization is still re-checked server-side at
// the decide route — this block only shapes the panel, it does not grant anything.

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireApApprover } from '@/lib/ap/approvers';
import { getApRequestDetail } from '@/lib/ap/queue';
import {
  canFulfillSecondApproval,
  SECOND_APPROVAL_SELF_MIN_WAIT_MS,
} from '@/lib/ap/second-approval';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const detail = await getApRequestDetail(id);
    if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

    let secondApproval:
      | { eligible: boolean; isFirstApprover: boolean; selfWaitRemainingMs: number }
      | null = null;
    if (detail.status === 'pending_second_approval') {
      const row = await prisma.apRequest.findUnique({
        where: { id },
        select: { site_id: true, first_approver_id: true, first_approved_at: true },
      });
      const site = row?.site_id
        ? await prisma.site.findUnique({ where: { id: row.site_id }, select: { code: true } })
        : null;
      const siteCode = site?.code ?? '';
      const eligible = siteCode
        ? await canFulfillSecondApproval(
            prisma,
            { userId: identity.userId, role: identity.viewer.role },
            siteCode,
          )
        : false;
      const isFirstApprover = row?.first_approver_id === identity.userId;
      const elapsedMs = row?.first_approved_at
        ? Date.now() - row.first_approved_at.getTime()
        : SECOND_APPROVAL_SELF_MIN_WAIT_MS;
      const selfWaitRemainingMs = isFirstApprover
        ? Math.max(0, SECOND_APPROVAL_SELF_MIN_WAIT_MS - elapsedMs)
        : 0;
      secondApproval = { eligible, isFirstApprover, selfWaitRemainingMs };
    }

    return NextResponse.json({ request: { ...detail, secondApproval } });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
