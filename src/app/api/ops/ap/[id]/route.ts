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
import { SECOND_APPROVAL_SELF_MIN_WAIT_MS } from '@/lib/ap/second-approval';
// ADR-0066 §1.4 — the SHARED resolver, the same one `decideSecondApproval` uses.
// This panel's `eligible` flag MUST be answered by the identical function that
// authorizes the write, or the UI and the server disagree (see below).
import { canFulfillSecondApprovalByRouting } from '@/lib/ap/second-approval-resolver';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const identity = await requireApApprover();
    const { id } = await params;
    const detail = await getApRequestDetail(id);
    if (!detail) return NextResponse.json({ error: 'not found' }, { status: 404 });

    let secondApproval: {
      eligible: boolean;
      isFirstApprover: boolean;
      selfWaitRemainingMs: number;
    } | null = null;
    if (detail.status === 'pending_second_approval') {
      const row = await prisma.apRequest.findUnique({
        where: { id },
        select: {
          site_id: true,
          first_approver_id: true,
          first_approved_at: true,
          // ADR-0066 §1.5 — escalation widens the eligible set additively, so the
          // panel must ask the same question the decide leg asks.
          escalated_at: true,
          filed_not_dr3: true,
        },
      });
      // ADR-0066 incident (2026-09-18): this block used to call the SUPERSEDED
      // `canFulfillSecondApproval(prisma, actor, siteCode)` — the pre-0066 check
      // against the per-site `ap_second_approvers` roster. That table holds exactly
      // one row (Shannon/eugene), so for every routed peer it answered FALSE, the
      // panel below never rendered, and four managers could not act as second
      // signer even though `decideSecondApproval` would have accepted the write.
      // The UI read one function and the server enforced another — the exact drift
      // ADR-0066 exists to prevent. Both halves now go through the resolver.
      //
      // NOT-DR3 / siteless rows never reach this state; mirror the decide leg's guard.
      const eligible =
        row && row.site_id && !row.filed_not_dr3
          ? await canFulfillSecondApprovalByRouting(
              prisma,
              { userId: identity.userId, role: identity.viewer.role },
              {
                firstApproverId: row.first_approver_id ?? '',
                escalated: row.escalated_at != null,
                // Hard rule #2 — site reach is still enforced inside the resolver.
                requestSiteId: row.site_id,
              },
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
