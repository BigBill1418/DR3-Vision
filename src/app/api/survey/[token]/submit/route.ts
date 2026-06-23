import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import {
  getInviteByToken,
  submitResponse,
  SurveyCampaignError,
} from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';

interface Ctx {
  params: Promise<{ token: string }>;
}

export async function POST(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isValidTokenShape(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const invite = await getInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    const updated = await submitResponse(invite.id, { ip, userAgent });
    return NextResponse.json({ ok: true, submitted_at: updated.submitted_at });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
