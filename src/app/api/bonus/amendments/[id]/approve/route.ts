import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  approveAmendmentRequest,
  approveAmendmentGroup,
  AmendmentRequestError,
} from '@/lib/bonus/amendment-requests';
import {
  buildBatchNotifyContext,
  notifyAmendmentBatchDecided,
  requestIdsForGroup,
} from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  let decisionNotes: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.decisionNotes === 'string' && body.decisionNotes.trim().length > 0) {
      decisionNotes = body.decisionNotes.trim();
    }
  } catch {
    /* empty body fine */
  }

  // ADR-0029: if this request is part of a submission group, "Approve" applies
  // the WHOLE group in one transaction and fires ONE result notification.
  // Otherwise it's a singleton: approve the one, one notification.
  const head = await prisma.bonusAmendmentRequest.findUnique({
    where: { id },
    select: { submission_group_id: true },
  });
  const groupId = head?.submission_group_id ?? null;

  try {
    let representativeRequestId: string;
    let notifyRequestIds: string[];

    if (groupId) {
      const result = await approveAmendmentGroup({
        submissionGroupId: groupId,
        reviewerUserId: access.userId,
        reviewerIsAdmin: access.isAdmin,
        decisionNotes,
        ip: req.headers.get('x-forwarded-for'),
        userAgent: req.headers.get('user-agent'),
      });
      representativeRequestId = result.representativeRequestId;
      notifyRequestIds = await requestIdsForGroup(groupId);
    } else {
      const result = await approveAmendmentRequest({
        requestId: id,
        reviewerUserId: access.userId,
        reviewerIsAdmin: access.isAdmin,
        decisionNotes,
        ip: req.headers.get('x-forwarded-for'),
        userAgent: req.headers.get('user-agent'),
      });
      representativeRequestId = result.request.id;
      notifyRequestIds = [result.request.id];
    }

    const notifyCtx = await buildBatchNotifyContext(notifyRequestIds);
    if (notifyCtx) {
      const reviewer = await prisma.user.findUnique({
        where: { id: access.userId },
        select: { name: true },
      });
      const bill = await prisma.user.findFirst({
        where: { role: 'admin', is_active: true, deleted_at: null },
        select: { email: true },
      });
      const requester = await prisma.bonusAmendmentRequest.findUnique({
        where: { id: representativeRequestId },
        select: { requested_by: { select: { email: true } } },
      });
      await notifyAmendmentBatchDecided(
        notifyCtx,
        'approved',
        reviewer?.name ?? 'Reviewer',
        decisionNotes,
        bill?.email ?? null,
        requester?.requested_by.email ?? null,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
