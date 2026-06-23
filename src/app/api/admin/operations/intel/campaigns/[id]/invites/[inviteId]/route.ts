import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import {
  getInviteWithQuestions,
  SurveyCampaignError,
  updateInviteQuestions,
} from '@/lib/survey/campaigns';

const Body = z.object({
  questions: z
    .array(
      z.object({
        position: z.number().int().nonnegative(),
        kind: z.enum(['short_text', 'long_text', 'single_select', 'multi_select']),
        prompt: z.string().min(1),
        description: z.string().nullable().optional(),
        options: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .nullable()
          .optional(),
        is_required: z.boolean().optional(),
      }),
    )
    .min(1),
});

interface Ctx {
  params: Promise<{ id: string; inviteId: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const invite = await getInviteWithQuestions(inviteId);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ invite });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    await updateInviteQuestions(inviteId, parsed.data.questions, {
      userId: session.user.id,
      ip,
      userAgent,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
