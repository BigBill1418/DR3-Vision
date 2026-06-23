import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getInviteByToken, saveDraft, SurveyCampaignError } from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';

const Body = z.object({
  answers: z.array(
    z.object({
      question_id: z.string().uuid(),
      answer_text: z.string().nullable().optional(),
      answer_json: z.unknown().optional(),
    }),
  ),
});

interface Ctx {
  params: Promise<{ token: string }>;
}

export async function PUT(req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isValidTokenShape(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const invite = await getInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    await saveDraft(invite.id, parsed.data.answers, { ip, userAgent });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
