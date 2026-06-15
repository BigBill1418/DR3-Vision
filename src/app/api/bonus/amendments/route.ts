import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import {
  submitAmendmentRequest,
  listPendingForApprover,
  AmendmentRequestError,
} from '@/lib/bonus/amendment-requests';
import { AmendmentWorkflowForbiddenError } from '@/lib/bonus/amendment-approvers';
import { buildNotifyContext, notifyAmendmentSubmitted } from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';
import { dayKeyUTCFromISO } from '@/lib/time';

const SubmitBody = z.object({
  bonusPayPeriodId: z.string().uuid(),
  targetEntryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bonusEmployeeId: z.string().uuid(),
  changeType: z.enum(['update', 'insert']),
  newValue: z.object({
    mattress_count: z.number().min(0).max(999),
    note: z.string().nullable(),
  }),
  justification: z.string().min(20),
});

export async function GET(req: NextRequest) {
  const ctx = await requireBonusAccess(siteFromRequest(req));
  const requests = await listPendingForApprover(
    ctx.userId,
    ctx.isAdmin,
    ctx.isAdmin ? null : ctx.siteId,
  );
  return NextResponse.json({ requests });
}

export async function POST(req: NextRequest) {
  const ctx = await requireBonusAccess(siteFromRequest(req));
  if (ctx.isAdmin) {
    return NextResponse.json({ error: 'admin_uses_direct_path' }, { status: 400 });
  }

  const parsed = SubmitBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_body', issues: parsed.error.issues },
      { status: 422 },
    );
  }
  const body = parsed.data;

  try {
    const created = await submitAmendmentRequest({
      siteId: ctx.siteId,
      bonusPayPeriodId: body.bonusPayPeriodId,
      targetEntryDate: dayKeyUTCFromISO(body.targetEntryDate),
      bonusEmployeeId: body.bonusEmployeeId,
      changeType: body.changeType,
      newValue: body.newValue,
      justification: body.justification,
      requesterUserId: ctx.userId,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    const notifyCtx = await buildNotifyContext(created.id);
    if (notifyCtx) {
      const approver = await prisma.user.findUnique({
        where: { id: created.expected_approver_user_id },
        select: { email: true },
      });
      await notifyAmendmentSubmitted(notifyCtx, approver?.email ?? null);
    }

    return NextResponse.json({ request: created }, { status: 201 });
  } catch (e) {
    if (e instanceof AmendmentWorkflowForbiddenError) {
      return NextResponse.json({ error: e.forbiddenReason }, { status: 403 });
    }
    if (e instanceof AmendmentRequestError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
