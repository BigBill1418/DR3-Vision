import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  rejectAmendmentRequest,
  rejectAmendmentGroup,
  AmendmentRequestError,
} from '@/lib/bonus/amendment-requests';
import {
  buildBatchNotifyContext,
  notifyAmendmentBatchDecided,
  requestIdsForGroup,
} from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

const Body = z.object({ decisionNotes: z.string().min(1) });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const decisionNotes = parsed.data.decisionNotes;

  // ADR-0029: a grouped request rejects the WHOLE group (one shared reason) and
  // fires ONE result notification; a singleton rejects the one.
  const head = await prisma.bonusAmendmentRequest.findUnique({
    where: { id },
    select: { submission_group_id: true },
  });
  const groupId = head?.submission_group_id ?? null;

  try {
    let representativeRequestId: string;
    let notifyRequestIds: string[];

    if (groupId) {
      const result = await rejectAmendmentGroup({
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
      const result = await rejectAmendmentRequest({
        requestId: id,
        reviewerUserId: access.userId,
        reviewerIsAdmin: access.isAdmin,
        decisionNotes,
        ip: req.headers.get('x-forwarded-for'),
        userAgent: req.headers.get('user-agent'),
      });
      representativeRequestId = result.id;
      notifyRequestIds = [result.id];
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
        'rejected',
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
