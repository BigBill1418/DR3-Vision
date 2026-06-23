import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { approveInvite, SurveyCampaignError } from '@/lib/survey/campaigns';

interface Ctx {
  params: Promise<{ id: string; inviteId: string }>;
}

export async function POST(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    const updated = await approveInvite(inviteId, {
      userId: session.user.id,
      ip,
      userAgent,
    });
    return NextResponse.json({ invite: updated });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
