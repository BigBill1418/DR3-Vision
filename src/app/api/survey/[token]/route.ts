import { NextResponse } from 'next/server';
import { getInviteByToken } from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';

export const dynamic = 'force-dynamic';

interface Ctx {
  params: Promise<{ token: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isValidTokenShape(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const invite = await getInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Public payload — never echo the token.
  return NextResponse.json({
    invite: {
      id: invite.id,
      recipient_name: invite.recipient_name,
      role_label: invite.role_label,
      status: invite.status,
      submitted_at: invite.submitted_at,
    },
    campaign: {
      title: invite.campaign.title,
      intro_text: invite.campaign.intro_text,
      from_display_name: invite.campaign.from_display_name,
      status: invite.campaign.status,
    },
    questions: invite.questions.map((q) => ({
      id: q.id,
      position: q.position,
      kind: q.kind,
      prompt: q.prompt,
      description: q.description,
      options: q.options,
      is_required: q.is_required,
    })),
    responses: invite.responses.map((r) => ({
      question_id: r.question_id,
      answer_text: r.answer_text,
      answer_json: r.answer_json,
    })),
  });
}
