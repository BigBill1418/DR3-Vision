import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import type {
  ActorContext,
  CampaignInput,
  DraftAnswer,
  InviteInput,
  PublicActor,
  QuestionInput,
  SystemActor,
} from './types';
import { generateToken } from './tokens';

export class SurveyCampaignError extends Error {
  readonly status: number;
  constructor(
    public readonly reason:
      | 'not_found'
      | 'invalid_status'
      | 'duplicate_email'
      | 'invalid_input'
      | 'campaign_locked'
      | 'already_submitted',
    statusCode = 422,
  ) {
    super(`survey-campaign: ${reason}`);
    this.name = 'SurveyCampaignError';
    this.status = statusCode;
  }
}

function serialize(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

// Nullable Json columns (`options`, `answer_json`) take Prisma.JsonNull — not a
// raw `null` — to write a JSON null. Prisma 5's strict input types reject `null`.
function jsonOrNull(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return v == null ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
}

// ADR-0036 — resolve the audit-log actor columns from either a signed-in admin
// (`actor_user_id`) or an autonomous system actor (`actor_label`). Lets
// `closeCampaign` serve both the admin close route and the reminder cron with a
// single audited path.
function actorAuditFields(actor: ActorContext | SystemActor):
  | { actor_user_id: string; ip: string | null; user_agent: string | null }
  | {
      actor_label: string;
      ip: string | null;
      user_agent: string | null;
    } {
  return 'actorLabel' in actor
    ? { actor_label: actor.actorLabel, ip: actor.ip ?? null, user_agent: actor.userAgent ?? null }
    : { actor_user_id: actor.userId, ip: actor.ip, user_agent: actor.userAgent };
}

// ─── Admin reads ───────────────────────────────────────────────

export async function listCampaigns() {
  return prisma.surveyCampaign.findMany({
    orderBy: { created_at: 'desc' },
    include: {
      created_by: { select: { name: true, email: true } },
      _count: { select: { invites: true } },
    },
  });
}

export async function getCampaignWithInvites(id: string) {
  return prisma.surveyCampaign.findUnique({
    where: { id },
    include: {
      created_by: { select: { name: true, email: true } },
      invites: {
        orderBy: { recipient_name: 'asc' },
        include: {
          approved_by: { select: { name: true, email: true } },
          questions: { orderBy: { position: 'asc' } },
          _count: { select: { responses: { where: { is_draft: false } } } },
        },
      },
    },
  });
}

export async function getInviteWithQuestions(inviteId: string) {
  return prisma.surveyInvite.findUnique({
    where: { id: inviteId },
    include: {
      campaign: true,
      approved_by: { select: { name: true, email: true } },
      questions: { orderBy: { position: 'asc' } },
      responses: true,
    },
  });
}

// ─── Admin writes ──────────────────────────────────────────────

export async function createCampaign(input: CampaignInput, actor: ActorContext) {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.create({
      data: {
        title: input.title,
        slug: input.slug,
        intro_text: input.intro_text,
        ...(input.subject_template ? { subject_template: input.subject_template } : {}),
        ...(input.from_address ? { from_address: input.from_address } : {}),
        ...(input.from_display_name ? { from_display_name: input.from_display_name } : {}),
        ...(input.reply_to ? { reply_to: input.reply_to } : {}),
        created_by_user_id: actor.userId,
      },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'insert',
        table_name: 'survey_campaigns',
        row_id: campaign.id,
        before: Prisma.JsonNull,
        after: serialize(campaign),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return campaign;
  });
}

export async function addInvite(campaignId: string, invite: InviteInput, actor: ActorContext) {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new SurveyCampaignError('not_found', 404);
    if (campaign.status === 'closed') throw new SurveyCampaignError('campaign_locked', 409);

    const lowerEmail = invite.recipient_email.toLowerCase();
    const existing = await tx.surveyInvite.findUnique({
      where: {
        campaign_id_recipient_email: { campaign_id: campaignId, recipient_email: lowerEmail },
      },
    });
    if (existing) throw new SurveyCampaignError('duplicate_email', 409);

    const token = generateToken();
    const created = await tx.surveyInvite.create({
      data: {
        campaign_id: campaignId,
        recipient_name: invite.recipient_name,
        recipient_email: lowerEmail,
        role_label: invite.role_label,
        token,
        status: 'draft',
        questions: {
          create: invite.questions.map((q) => ({
            position: q.position,
            kind: q.kind,
            prompt: q.prompt,
            description: q.description ?? null,
            options: jsonOrNull(q.options),
            is_required: q.is_required ?? false,
          })),
        },
      },
      include: { questions: { orderBy: { position: 'asc' } } },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'insert',
        table_name: 'survey_invites',
        row_id: created.id,
        before: Prisma.JsonNull,
        after: serialize({
          recipient_name: created.recipient_name,
          recipient_email: created.recipient_email,
          role_label: created.role_label,
          question_count: created.questions.length,
        }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return created;
  });
}

export async function updateInviteQuestions(
  inviteId: string,
  questions: QuestionInput[],
  actor: ActorContext,
) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new SurveyCampaignError('not_found', 404);
    if (invite.status !== 'draft' && invite.status !== 'approved') {
      throw new SurveyCampaignError('invalid_status', 409);
    }

    const before = await tx.surveyQuestion.findMany({
      where: { invite_id: inviteId },
      orderBy: { position: 'asc' },
    });

    await tx.surveyQuestion.deleteMany({ where: { invite_id: inviteId } });
    await tx.surveyQuestion.createMany({
      data: questions.map((q) => ({
        invite_id: inviteId,
        position: q.position,
        kind: q.kind,
        prompt: q.prompt,
        description: q.description ?? null,
        options: jsonOrNull(q.options),
        is_required: q.is_required ?? false,
      })),
    });

    // Approval clears when questions change (re-preview required).
    const statusReset = invite.status === 'approved';
    if (statusReset) {
      await tx.surveyInvite.update({
        where: { id: inviteId },
        data: { status: 'draft', approved_by_user_id: null, approved_at: null },
      });
    }

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'survey_invites',
        row_id: inviteId,
        before: serialize({ question_count: before.length, status: invite.status }),
        after: serialize({ question_count: questions.length, status_reset: statusReset }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });
}

export async function approveInvite(inviteId: string, actor: ActorContext) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new SurveyCampaignError('not_found', 404);
    if (invite.status !== 'draft') throw new SurveyCampaignError('invalid_status', 409);

    const updated = await tx.surveyInvite.update({
      where: { id: inviteId },
      data: {
        status: 'approved',
        approved_by_user_id: actor.userId,
        approved_at: new Date(),
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'survey_invites',
        row_id: inviteId,
        before: serialize({ status: 'draft' }),
        after: serialize({ status: 'approved', approved_at: updated.approved_at }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return updated;
  });
}

export async function markInviteSent(
  inviteId: string,
  lastStatus: number | null,
  actor: ActorContext,
) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new SurveyCampaignError('not_found', 404);
    if (invite.status !== 'approved') throw new SurveyCampaignError('invalid_status', 409);

    const updated = await tx.surveyInvite.update({
      where: { id: inviteId },
      data: { status: 'sent', sent_at: new Date(), last_status: lastStatus },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'survey_invites',
        row_id: inviteId,
        before: serialize({ status: 'approved' }),
        after: serialize({ status: 'sent', sent_at: updated.sent_at, last_status: lastStatus }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return updated;
  });
}

export async function openCampaign(campaignId: string, actor: ActorContext) {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new SurveyCampaignError('not_found', 404);
    if (campaign.status !== 'draft') throw new SurveyCampaignError('invalid_status', 409);

    const updated = await tx.surveyCampaign.update({
      where: { id: campaignId },
      data: { status: 'open', opened_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'survey_campaigns',
        row_id: campaignId,
        before: serialize({ status: 'draft' }),
        after: serialize({ status: 'open', opened_at: updated.opened_at }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return updated;
  });
}

// Accepts either a signed-in admin (`ActorContext`, from the admin close route)
// or an autonomous `SystemActor` (the reminder cron's auto-close, audited under
// `actor_label: 'system:survey-reminder-cron'`). ADR-0036.
export async function closeCampaign(campaignId: string, actor: ActorContext | SystemActor) {
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.surveyCampaign.findUnique({ where: { id: campaignId } });
    if (!campaign) throw new SurveyCampaignError('not_found', 404);
    if (campaign.status === 'closed') throw new SurveyCampaignError('invalid_status', 409);

    const updated = await tx.surveyCampaign.update({
      where: { id: campaignId },
      data: { status: 'closed', closed_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        ...actorAuditFields(actor),
        action: 'update',
        table_name: 'survey_campaigns',
        row_id: campaignId,
        before: serialize({ status: campaign.status }),
        after: serialize({ status: 'closed', closed_at: updated.closed_at }),
      },
    });
    return updated;
  });
}

// ─── Public reads/writes (token-gated, no userId) ──────────────

export async function getInviteByToken(token: string) {
  return prisma.surveyInvite.findUnique({
    where: { token },
    include: {
      campaign: {
        select: {
          id: true,
          title: true,
          intro_text: true,
          status: true,
          from_display_name: true,
        },
      },
      questions: { orderBy: { position: 'asc' } },
      responses: true,
    },
  });
}

export async function markInviteOpened(inviteId: string, actor: PublicActor) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) return;
    if (invite.status !== 'sent') return;
    await tx.surveyInvite.update({
      where: { id: inviteId },
      data: { status: 'opened', first_opened_at: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actor_label: 'public:survey-respondent',
        action: 'update',
        table_name: 'survey_invites',
        row_id: inviteId,
        before: serialize({ status: 'sent' }),
        after: serialize({ status: 'opened' }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });
}

export async function saveDraft(
  inviteId: string,
  answers: readonly DraftAnswer[],
  actor: PublicActor,
) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({ where: { id: inviteId } });
    if (!invite) throw new SurveyCampaignError('not_found', 404);
    if (invite.submitted_at !== null) throw new SurveyCampaignError('already_submitted', 409);

    for (const a of answers) {
      await tx.surveyResponse.upsert({
        where: {
          invite_id_question_id: { invite_id: inviteId, question_id: a.question_id },
        },
        create: {
          invite_id: inviteId,
          question_id: a.question_id,
          answer_text: a.answer_text ?? null,
          answer_json: jsonOrNull(a.answer_json),
          is_draft: true,
        },
        update: {
          answer_text: a.answer_text ?? null,
          answer_json: jsonOrNull(a.answer_json),
          is_draft: true,
          updated_at: new Date(),
        },
      });
    }

    // Audit captures counts + timestamp, not raw answer text.
    await tx.auditLog.create({
      data: {
        actor_label: 'public:survey-respondent',
        action: 'update',
        table_name: 'survey_responses',
        row_id: inviteId,
        before: Prisma.JsonNull,
        after: serialize({ saved_count: answers.length }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });
}

export async function submitResponse(inviteId: string, actor: PublicActor) {
  return prisma.$transaction(async (tx) => {
    const invite = await tx.surveyInvite.findUnique({
      where: { id: inviteId },
      include: {
        responses: true,
        questions: { where: { is_required: true } },
      },
    });
    if (!invite) throw new SurveyCampaignError('not_found', 404);
    if (invite.submitted_at !== null) throw new SurveyCampaignError('already_submitted', 409);

    const respByQ = new Map(invite.responses.map((r) => [r.question_id, r]));
    for (const q of invite.questions) {
      const r = respByQ.get(q.id);
      const hasText = r?.answer_text && r.answer_text.trim() !== '';
      const hasJson = r?.answer_json != null;
      if (!hasText && !hasJson) {
        throw new SurveyCampaignError('invalid_input', 422);
      }
    }

    await tx.surveyResponse.updateMany({
      where: { invite_id: inviteId },
      data: { is_draft: false },
    });
    const updated = await tx.surveyInvite.update({
      where: { id: inviteId },
      data: { status: 'submitted', submitted_at: new Date() },
    });

    await tx.auditLog.create({
      data: {
        actor_label: 'public:survey-respondent',
        action: 'update',
        table_name: 'survey_invites',
        row_id: inviteId,
        before: serialize({ status: invite.status }),
        after: serialize({ status: 'submitted', submitted_at: updated.submitted_at }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return updated;
  });
}
