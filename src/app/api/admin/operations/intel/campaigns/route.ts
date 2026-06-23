import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { createCampaign, listCampaigns } from '@/lib/survey/campaigns';

const Body = z.object({
  title: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  intro_text: z.string().min(1),
  subject_template: z.string().optional(),
  from_address: z.string().email().optional(),
  from_display_name: z.string().optional(),
  reply_to: z.string().email().optional(),
});

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await auth();
  if (!session?.user?.is_super_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({ campaigns: await listCampaigns() });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  const created = await createCampaign(parsed.data, {
    userId: session.user.id,
    ip,
    userAgent,
  });
  return NextResponse.json({ campaign: created }, { status: 201 });
}
