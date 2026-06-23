import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { renderInviteHtml } from '@/lib/survey/notifications';
import { getInviteWithQuestions } from '@/lib/survey/campaigns';

interface Ctx {
  params: Promise<{ id: string; inviteId: string }>;
}

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

export async function POST(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const invite = await getInviteWithQuestions(inviteId);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const html = renderInviteHtml({
    campaign: invite.campaign,
    invite: {
      recipient_name: invite.recipient_name,
      recipient_email: invite.recipient_email,
      role_label: invite.role_label,
      token: invite.token,
    },
    baseUrl: baseUrl(),
  });

  return NextResponse.json({
    preview: {
      subject: invite.campaign.subject_template,
      from_address: invite.campaign.from_address,
      from_display_name: invite.campaign.from_display_name,
      reply_to: invite.campaign.reply_to,
      to_email: invite.recipient_email,
      to_name: invite.recipient_name,
      html_body: html,
    },
  });
}
