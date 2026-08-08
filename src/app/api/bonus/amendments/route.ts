import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireBonusAccess, siteFromRequest } from '@/lib/bonus/access';
import { AmendmentNewValue } from '@/lib/bonus/amendment-schemas';
import {
  submitAmendmentBatch,
  listPendingForApprover,
  AmendmentRequestError,
  type AmendmentItemInput,
} from '@/lib/bonus/amendment-requests';
import { AmendmentWorkflowForbiddenError } from '@/lib/bonus/amendment-approvers';
import {
  buildBatchNotifyContext,
  notifyAmendmentBatchSubmitted,
} from '@/lib/bonus/amendment-notifications';
import { prisma } from '@/lib/prisma';
import { dayKeyUTCFromISO } from '@/lib/time';

// ADR-0083 — the proposed-value contract lives in `@/lib/bonus/amendment-schemas`
// so the route and its tests validate against ONE definition. A copy pasted into
// a test would stay green through any change here, measuring the copy instead of
// the endpoint. See that module for why `saves` is required rather than optional.
const NewValue = AmendmentNewValue;

// ADR-0029: the submit endpoint accepts EITHER a single-item body (back-compat
// with ADR-0028 clients) OR a batch body sharing one period/date/justification
// across an array of items. Both flow through `submitAmendmentBatch`, which fires
// exactly one notification. The single-item shape is normalised into a 1-element
// batch below.
const SingleBody = z.object({
  bonusPayPeriodId: z.string().uuid(),
  targetEntryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bonusEmployeeId: z.string().uuid(),
  changeType: z.enum(['update', 'insert']),
  newValue: NewValue,
  justification: z.string().min(20),
});

const BatchBody = z.object({
  bonusPayPeriodId: z.string().uuid(),
  targetEntryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  justification: z.string().min(20),
  items: z
    .array(
      z.object({
        bonusEmployeeId: z.string().uuid(),
        changeType: z.enum(['update', 'insert']),
        newValue: NewValue,
      }),
    )
    .min(1)
    .max(200),
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

  const raw = await req.json();

  // Normalise to a batch. A body with `items` is a batch; otherwise it's the
  // legacy single-item shape, wrapped into a 1-element batch.
  let bonusPayPeriodId: string;
  let targetEntryDate: string;
  let justification: string;
  let items: AmendmentItemInput[];

  if (raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)) {
    const parsed = BatchBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid_body', issues: parsed.error.issues },
        { status: 422 },
      );
    }
    bonusPayPeriodId = parsed.data.bonusPayPeriodId;
    targetEntryDate = parsed.data.targetEntryDate;
    justification = parsed.data.justification;
    items = parsed.data.items.map((i) => ({
      bonusEmployeeId: i.bonusEmployeeId,
      changeType: i.changeType,
      newValue: i.newValue,
    }));
  } else {
    const parsed = SingleBody.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'invalid_body', issues: parsed.error.issues },
        { status: 422 },
      );
    }
    bonusPayPeriodId = parsed.data.bonusPayPeriodId;
    targetEntryDate = parsed.data.targetEntryDate;
    justification = parsed.data.justification;
    items = [
      {
        bonusEmployeeId: parsed.data.bonusEmployeeId,
        changeType: parsed.data.changeType,
        newValue: parsed.data.newValue,
      },
    ];
  }

  try {
    const { created } = await submitAmendmentBatch({
      siteId: ctx.siteId,
      bonusPayPeriodId,
      targetEntryDate: dayKeyUTCFromISO(targetEntryDate),
      justification,
      requesterUserId: ctx.userId,
      items,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });

    // ADR-0029: ONE submitted notification for the whole batch.
    const notifyCtx = await buildBatchNotifyContext(created.map((c) => c.id));
    if (notifyCtx) {
      const approver = await prisma.user.findUnique({
        where: { id: created[0]!.expected_approver_user_id },
        select: { email: true },
      });
      await notifyAmendmentBatchSubmitted(notifyCtx, approver?.email ?? null);
    }

    return NextResponse.json({ requests: created, count: created.length }, { status: 201 });
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
