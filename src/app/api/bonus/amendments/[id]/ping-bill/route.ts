import { NextResponse, type NextRequest } from 'next/server';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { pingBill, AmendmentRequestError } from '@/lib/bonus/amendment-requests';
import { buildNotifyContext, notifyAmendmentBillPinged } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireBonusAccess(siteFromRequest(req));

  try {
    const { request: updated, firstPing } = await pingBill(
      id,
      access.userId,
      req.headers.get('x-forwarded-for'),
      req.headers.get('user-agent'),
    );

    if (firstPing) {
      const notifyCtx = await buildNotifyContext(updated.id);
      if (notifyCtx) {
        const bill = await prisma.user.findFirst({
          where: { role: 'admin', is_active: true, deleted_at: null },
          select: { email: true },
        });
        await notifyAmendmentBillPinged(notifyCtx, bill?.email ?? null);
      }
    }

    return NextResponse.json({ request: updated });
  } catch (e) {
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
