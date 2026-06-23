import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendInvite } from '@/lib/survey/notifications';
import { markInviteSent, SurveyCampaignError } from '@/lib/survey/campaigns';
import { log } from '@/lib/observability/logger';

const Body = z.object({
  confirmed_recipient_count: z.number().int().nonnegative(),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

function baseUrl(): string {
  return process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
}

interface PerRecipientResult {
  invite_id: string;
  recipient_name: string;
  delivered: boolean;
  last_status: number | null;
  error?: string;
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id: campaignId } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  const campaign = await prisma.surveyCampaign.findUnique({
    where: { id: campaignId },
    include: { invites: { where: { status: 'approved' } } },
  });
  if (!campaign) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (campaign.status === 'closed') {
    return NextResponse.json({ error: 'campaign_locked' }, { status: 409 });
  }

  const approvedCount = campaign.invites.length;
  if (parsed.data.confirmed_recipient_count !== approvedCount) {
    return NextResponse.json(
      {
        error: 'count_diverged',
        expected: approvedCount,
        provided: parsed.data.confirmed_recipient_count,
      },
      { status: 422 },
    );
  }

  if (approvedCount === 0) {
    return NextResponse.json({ error: 'no_approved_invites' }, { status: 422 });
  }

  // Open the campaign if it's still draft.
  if (campaign.status === 'draft') {
    await prisma.surveyCampaign.update({
      where: { id: campaignId },
      data: { status: 'open', opened_at: new Date() },
    });
  }

  const results: PerRecipientResult[] = [];
  for (const invite of campaign.invites) {
    try {
      const r = await sendInvite({
        campaign: {
          title: campaign.title,
          intro_text: campaign.intro_text,
          subject_template: campaign.subject_template,
          from_address: campaign.from_address,
          from_display_name: campaign.from_display_name,
          reply_to: campaign.reply_to,
        },
        invite: {
          recipient_name: invite.recipient_name,
          recipient_email: invite.recipient_email,
          role_label: invite.role_label,
          token: invite.token,
        },
        baseUrl: baseUrl(),
      });
      if (r.delivered) {
        await markInviteSent(invite.id, r.last_status, {
          userId: session.user.id,
          ip,
          userAgent,
        });
      }
      results.push({
        invite_id: invite.id,
        recipient_name: invite.recipient_name,
        delivered: r.delivered,
        last_status: r.last_status,
      });
      log.info(
        { inviteId: invite.id, delivered: r.delivered, lastStatus: r.last_status },
        '[survey] invite sent',
      );
    } catch (e) {
      if (e instanceof SurveyCampaignError) {
        results.push({
          invite_id: invite.id,
          recipient_name: invite.recipient_name,
          delivered: false,
          last_status: null,
          error: e.reason,
        });
      } else {
        log.warn({ err: e, inviteId: invite.id }, '[survey] send error');
        results.push({
          invite_id: invite.id,
          recipient_name: invite.recipient_name,
          delivered: false,
          last_status: null,
          error: 'unknown',
        });
      }
    }
  }

  return NextResponse.json({ ok: true, results });
}
