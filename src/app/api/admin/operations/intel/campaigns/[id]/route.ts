import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getCampaignWithInvites } from '@/lib/survey/campaigns';

export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const campaign = await getCampaignWithInvites(id);
  if (!campaign) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ campaign });
}
