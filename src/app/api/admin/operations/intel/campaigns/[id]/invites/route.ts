import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { addInvite, SurveyCampaignError } from '@/lib/survey/campaigns';

const QuestionSchema = z.object({
  position: z.number().int().nonnegative(),
  kind: z.enum(['short_text', 'long_text', 'single_select', 'multi_select']),
  prompt: z.string().min(1),
  description: z.string().nullable().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .nullable()
    .optional(),
  is_required: z.boolean().optional(),
});

const Body = z.object({
  recipient_name: z.string().min(1),
  recipient_email: z.string().email(),
  role_label: z.string().min(1),
  questions: z.array(QuestionSchema).min(1),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    const created = await addInvite(id, parsed.data, {
      userId: session.user.id,
      ip,
      userAgent,
    });
    return NextResponse.json({ invite: created }, { status: 201 });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
