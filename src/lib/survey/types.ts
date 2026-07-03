// ADR-0034 — Shared types for the operational intelligence survey system.

export type CampaignStatus = 'draft' | 'open' | 'closed';
export type InviteStatus = 'draft' | 'approved' | 'sent' | 'opened' | 'submitted';
export type QuestionKind = 'short_text' | 'long_text' | 'single_select' | 'multi_select';

export interface QuestionOption {
  label: string;
  value: string;
}

export interface QuestionInput {
  position: number;
  kind: QuestionKind;
  prompt: string;
  description?: string | null | undefined;
  options?: QuestionOption[] | null | undefined;
  is_required?: boolean | undefined;
}

export interface InviteInput {
  recipient_name: string;
  recipient_email: string;
  role_label: string;
  questions: QuestionInput[];
}

export interface CampaignInput {
  title: string;
  slug: string;
  intro_text: string;
  subject_template?: string | undefined;
  from_address?: string | undefined;
  from_display_name?: string | undefined;
  reply_to?: string | undefined;
}

export interface DraftAnswer {
  question_id: string;
  answer_text?: string | null | undefined;
  answer_json?: unknown;
}

export interface ActorContext {
  userId: string;
  ip: string | null;
  userAgent: string | null;
}

export interface PublicActor {
  ip: string | null;
  userAgent: string | null;
}

// ADR-0036 — an autonomous system actor (e.g. the survey-reminder cron). Audits
// under `actor_label` rather than `actor_user_id`, mirroring the public/system
// audit style already used by `markInviteOpened` ('public:survey-respondent').
export interface SystemActor {
  actorLabel: string;
  ip?: string | null;
  userAgent?: string | null;
}
