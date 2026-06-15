import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { approveAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentApproved } from '@/lib/bonus/amendment-notifications';
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

  try {
    const result = await approveAmendmentRequest({
      requestId: id,
      reviewerUserId: access.userId,
      reviewerIsAdmin: access.isAdmin,
      decisionNotes,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(result.request.id);
    if (notifyCtx) {
      const reviewer = await prisma.user.findUnique({
        where: { id: access.userId },
        select: { name: true },
      });
      const bill = await prisma.user.findFirst({
        where: { role: 'admin', is_active: true, deleted_at: null },
        select: { email: true },
      });
      const requester = await prisma.user.findUnique({
        where: { id: result.request.requested_by_user_id },
        select: { email: true },
      });
      await notifyAmendmentApproved(
        notifyCtx,
        reviewer?.name ?? 'Reviewer',
        bill?.email ?? null,
        requester?.email ?? null,
      );
    }

    return NextResponse.json({ request: result.request });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
