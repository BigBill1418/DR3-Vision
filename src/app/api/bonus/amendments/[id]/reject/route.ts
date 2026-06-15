import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { rejectAmendmentRequest, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentRejected } from '@/lib/bonus/amendment-notifications';
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

  try {
    const updated = await rejectAmendmentRequest({
      requestId: id,
      reviewerUserId: access.userId,
      reviewerIsAdmin: access.isAdmin,
      decisionNotes: parsed.data.decisionNotes,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(updated.id);
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
        where: { id: updated.requested_by_user_id },
        select: { email: true },
      });
      await notifyAmendmentRejected(
        notifyCtx,
        reviewer?.name ?? 'Reviewer',
        parsed.data.decisionNotes,
        bill?.email ?? null,
        requester?.email ?? null,
      );
    }

    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
