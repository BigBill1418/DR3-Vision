import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getInviteByToken, markInviteOpened } from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';
import { SurveyForm } from './SurveyForm';
import { ThankYou } from './ThankYou';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ token: string }>;
}

export default async function SurveyTokenPage({ params }: PageProps) {
  const { token } = await params;
  if (!isValidTokenShape(token)) notFound();

  const invite = await getInviteByToken(token);
  if (!invite) notFound();
  if (invite.campaign.status === 'closed') notFound();

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');
  await markInviteOpened(invite.id, { ip, userAgent }).catch(() => undefined);

  if (invite.submitted_at !== null) {
    return (
      <ThankYou
        submittedAt={invite.submitted_at}
        recipientName={invite.recipient_name}
      />
    );
  }

  // SurveyForm receives only what the client needs — never the raw token in
  // any place that could be logged. The token in the URL is sufficient for
  // /api/survey/[token]/draft and /submit.
  return (
    <SurveyForm
      invite={{
        id: invite.id,
        recipient_name: invite.recipient_name,
        role_label: invite.role_label,
        campaign: {
          title: invite.campaign.title,
          intro_text: invite.campaign.intro_text,
          from_display_name: invite.campaign.from_display_name,
        },
        questions: invite.questions.map((q) => ({
          id: q.id,
          position: q.position,
          kind: q.kind as 'short_text' | 'long_text' | 'single_select' | 'multi_select',
          prompt: q.prompt,
          description: q.description,
          options: (q.options as Array<{ label: string; value: string }> | null) ?? null,
          is_required: q.is_required,
        })),
        responses: invite.responses.map((r) => ({
          question_id: r.question_id,
          answer_text: r.answer_text,
          answer_json: r.answer_json,
        })),
        token,
      }}
    />
  );
}
