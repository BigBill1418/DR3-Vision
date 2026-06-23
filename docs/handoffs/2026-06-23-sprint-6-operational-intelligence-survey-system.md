# Sprint 6 Handoff — Operational Intelligence Survey System (ADR-0034)

**Status:** Ready for build
**Branch:** `sprint-6-operational-intelligence-survey`
**ADR:** ADR-0034 (content in §3)
**Author:** Bill Barnard, Director of Operations
**Date:** 2026-06-22

This handoff arrives as multiple chunks appended to the same file/PR via ClaudeSync continuation_ref. Sections are numbered §0 through §18; the implementing agent (Claude Code) reads them in order.

---

## §0 — Instructions to the implementing agent

You are executing Sprint 6 of DR3-Vision. This document is the only input. Do the following in order:

1. Cut `sprint-6-operational-intelligence-survey` from `main`.
2. Create every file in §2 and apply every patch verbatim. Mirror existing repo conventions:
   - M365 send: `sendSystemEmail` from `@/lib/m365-mail` (extended this sprint to accept `fromDisplayName`, `replyTo`, `cc`)
   - Auth gate: `is_super_admin` on `User` (introduced ADR-0030, propagated through `auth.ts` session)
   - Audit: `writeAudit` from `@/lib/audit` — `actor_label = 'public:survey-respondent'` for public route writes; `actor_user_id` for admin writes
   - SVdP-branded email shell: same red `#a3151a` masthead / gold `#ffcc69` / cream `#f7f3ea` table-based inline-styled ≤600px Outlook fidelity pattern as the daily production report email
3. Run `npx prisma generate` after the schema patch lands.
4. Implement the test files in §14 to the case-list level.
5. Run the full gate:
   - `npx tsc --noEmit` exits 0
   - `npx eslint . --max-warnings 0` clean
   - `npx vitest run` green; suite grew by ≥ 28 cases
   - `npx next build` succeeds
6. Open a PR titled **"Sprint 6: operational intelligence survey system (ADR-0034)"** with the description in §15.
7. **Do not send any surveys.** Bill personally previews and approves each invite before any email goes out.

### Non-negotiables

- **No auth on the public survey route.** The token IS the access. Tokens are 32-char URL-safe cryptographic random (`crypto.randomBytes(24).toString('base64url')`), generated once at invite creation, never re-issued, never exposed in logs or error messages.
- **Super-admin gate on every admin route.** Same pattern as `/admin/production-report`. `session.user.is_super_admin === true` or 403.
- **Per-invite approval gate.** No email fires unless `invite.status === 'approved'`. Approval is one-click per invite after preview.
- **Send confirmation interstitial.** `/send` requires a `confirmed_recipient_count` parameter matching the actual count of approved invites at request time. Mismatch → 422 `count_diverged`.
- **Drafts auto-save during entry; freeze on submit.** Every PUT to `/api/survey/[token]/draft` overwrites the existing draft answers. POST to `/api/survey/[token]/submit` sets `invite.submitted_at`, flips response `is_draft` flags, and locks responses immutable.
- **Re-visit after submit shows thank-you, no edit.** Public route GET on a submitted invite renders read-only; PATCH/PUT/POST returns 409 `already_submitted`.
- **Closing question on every packet.** Every invite's question packet ends with a "What are we missing? What should we be looking at?" `long_text` question.
- **Email sender/reply-to configurable per campaign.** Defaults: `from_address = dr3-vision@svdp.us`, `from_display_name = Bill Barnard via DR3-Vision`, `reply_to = bill.barnard@svdp.us`.
- **CLAUDE.md hard rules apply:** every config mutation has its audit row in the same transaction; M365 fail-soft (unconfigured → log + skip, never throw); no HTML `<form>` tags in React (use `onClick`/`onChange` handlers).

---

## §1 — Context

ADR-0033 (operations system-of-record expansion — daily-log + invoice-prep replacement) is mostly designed but blocked on operational depth that only specific team members can supply. Eight-plus parked questions sit with named individuals across DR3, accounting, leadership, and the floor.

Rather than block ADR-0033 indefinitely waiting for asks-by-email to come back asynchronously, we built a structured intake tool that closes those questions in parallel.

Microsoft Forms was rejected: no Graph API for template creation; responses live in OneDrive requiring manual export; no per-recipient personalization.

### Recipients (seeded in §13)

| Recipient | Role label | Survey focus |
|---|---|---|
| Bethany Cartledge | Executive Director | ED dashboard needs, mission framing, board-facing metrics |
| Leisha Wallace | Personnel Director | Historical context, longitudinal workforce data |
| Shannon Rockwell | Director of Stores Operations | Rick's supervisor — oversight, cross-site visibility |
| Mary Scott | Accounting / GP Entry for MRC Billing | GP integration path, billing process, ideal data format |
| Rick Albritton | Eugene Manager + MRC Billing Contact | Data Mary uses today, CA mid-month cutoff rule, Eugene equivalent |
| Janette Tomas | Woodland Manager | Daily log mechanics, DR3#/Material#, container rentals, format drift |
| Morena Gomez | DR3 California Operations Manager | Cross-facility coordination, dashboard needs, where the sheet has been wrong |
| Kelsey Ruhland | Data / Compliance | MRC reporting cadence, per-state fee schedules, Re-Trac, CalRecycle |
| Juan | Woodland production floor | Floor view, equipment downtime, quality issues, what supervisors don't see |
| Patrick Dills | Eugene lead processor | Floor view, bonus system from processor side, processor-facing dashboards |

Bill is the campaign owner. He does not receive a survey but he sees every response.

---

## §2 — File manifest

### New files

1. `docs/adr/0034-operational-intelligence-survey.md` (§3)
2. `prisma/migrations/20260622_operational_intelligence_survey/migration.sql` (§4)
3. `src/lib/survey/types.ts` (§6)
4. `src/lib/survey/campaigns.ts` (§6)
5. `src/lib/survey/tokens.ts` (§7)
6. `src/lib/survey/notifications.ts` (§8)
7. `src/lib/survey/export.ts` (§9)
8. `src/lib/survey/__tests__/campaigns.test.ts` (§14.1)
9. `src/lib/survey/__tests__/tokens.test.ts` (§14.2)
10. `src/lib/survey/__tests__/notifications.test.ts` (§14.3)
11. `src/lib/survey/__tests__/export.test.ts` (§14.4)
12. `src/app/survey/[token]/page.tsx` (§10.1)
13. `src/app/survey/[token]/SurveyForm.tsx` (§10.2)
14. `src/app/survey/[token]/ThankYou.tsx` (§10.3)
15. `src/app/admin/operations/intel/page.tsx` (§11.1)
16. `src/app/admin/operations/intel/CampaignList.tsx` (§11.2)
17. `src/app/admin/operations/intel/[campaignId]/page.tsx` (§11.3)
18. `src/app/admin/operations/intel/[campaignId]/CampaignDetail.tsx` (§11.4)
19. `src/app/admin/operations/intel/[campaignId]/InviteEditor.tsx` (§11.5)
20. `src/app/admin/operations/intel/[campaignId]/InvitePreview.tsx` (§11.6)
21. `src/app/admin/operations/intel/[campaignId]/SendInterstitial.tsx` (§11.7)
22. `src/app/api/survey/[token]/route.ts` (§12.1)
23. `src/app/api/survey/[token]/draft/route.ts` (§12.2)
24. `src/app/api/survey/[token]/submit/route.ts` (§12.3)
25. `src/app/api/admin/operations/intel/campaigns/route.ts` (§12.4)
26. `src/app/api/admin/operations/intel/campaigns/[id]/route.ts` (§12.5)
27. `src/app/api/admin/operations/intel/campaigns/[id]/invites/route.ts` (§12.6)
28. `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/route.ts` (§12.7)
29. `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/approve/route.ts` (§12.8)
30. `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/preview/route.ts` (§12.9)
31. `src/app/api/admin/operations/intel/campaigns/[id]/send/route.ts` (§12.10)
32. `src/app/api/admin/operations/intel/campaigns/[id]/close/route.ts` (§12.11)
33. `src/app/api/admin/operations/intel/__tests__/routes.test.ts` (§14.5)
34. `src/app/api/survey/__tests__/routes.test.ts` (§14.6)
35. `prisma/seed/survey_dr3_intel_2026.ts` (§13)
36. `docs/operator/operational-intelligence-survey.md` (§16)

### Modified files

37. `prisma/schema.prisma` (§5)
38. `src/lib/m365-mail.ts` — extend `sendSystemEmail` for `fromDisplayName`, `replyTo`, `cc`
39. `src/lib/m365-mail.test.ts` — new cases
40. `src/lib/dashboard-tiles.ts` — adds "Operational Intelligence" admin tile (`is_super_admin`-gated)
41. `CHANGELOG.md` — entry at top of Unreleased (§17)
42. `prisma/seed.ts` — invoke new seed file (idempotent)

---

## §3 — `docs/adr/0034-operational-intelligence-survey.md`

```markdown
# ADR-0034 — Operational intelligence survey system

**Status:** Accepted (Sprint 6, 2026-06-22)
**Related:** ADR-0021 (M365 Graph mail-send), ADR-0030 (super-admin flag); informs ADR-0033 (operations system-of-record expansion).

## Context

ADR-0033 is blocked on operational depth that only specific team members can supply. Eight-plus parked questions sit with named individuals: Rick (CA mid-month cutoff rule), Janette (DR3#/Material# sequences, container rentals, format drift), Mary (Great Plains integration), Morena (cross-facility coordination), Kelsey (MRC reporting cadence, Re-Trac, per-state fee schedules), floor staff Juan and Patrick.

Microsoft Forms was rejected: no Graph API for template creation; responses live in OneDrive requiring manual export; no per-recipient personalization.

## Decision

Admin-gated route group at `/admin/operations/intel` plus a public route at `/survey/{token}` implementing a one-shot, per-recipient-personalized survey system. Four new tables. Responses export as markdown to `docs/operations-intel/{campaign-slug}/` via the existing ClaudeSync handoff path.

### Public access model

Unauthenticated. Tokens are 32-char URL-safe cryptographic random values, generated once per invite. The token IS the access. Tokens never logged, never echoed in errors. Audit references invites by UUID, not token.

### Per-recipient personalization

Each invite has its own question packet (one `survey_questions` row per question, FK'd to invite). No sharing across invites. The closing question "What are we missing? What should we be looking at?" duplicated at the end of every packet.

Question kinds: `short_text`, `long_text`, `single_select`, `multi_select`. File uploads schema-deferred.

### Approval gate

`status` enum: `draft` → `approved` (Bill clicked after preview) → `sent` (email fired) → `opened` (recipient loaded the page) → `submitted` (locked).

`/send` refuses any invite not in `approved` state. Also requires `confirmed_recipient_count` matching the actual approved-count at request time. Mismatch → 422 `count_diverged`.

### Draft auto-save and submit

PUT `/api/survey/[token]/draft` upserts answers by `(invite_id, question_id)`. POST `/api/survey/[token]/submit` flips all rows to `is_draft = false`, sets `invite.submitted_at`. After submit, GET renders read-only thank-you; PATCH/PUT/POST returns 409.

### Email sender

Defaults: `from_address = dr3-vision@svdp.us`, `from_display_name = "Bill Barnard via DR3-Vision"`, `reply_to = bill.barnard@svdp.us`. Override per campaign. Vision is SVdP, outbound identity must be the SVdP mailbox.

### ClaudeSync export

Campaign close generates one markdown file per submitted invite at `docs/operations-intel/{campaign-slug}/{recipient-slug}.md` plus a `_summary.md` consolidated index. Pushed via the same `create_handoff` mechanism the team uses for sprint handoffs.

### Audit trail

Every state transition writes one `audit_log` row. Bill's admin actions log with `actor_user_id`; public route actions log with `actor_label = 'public:survey-respondent'`, IP, and user-agent. Audit volume kept sane by storing counts and timestamps, not full response text.

## Consequences

Positive: closes ADR-0033's parked questions structurally; responses land where Claude reads via ClaudeSync; reusable for future campaigns; no auth burden on respondents who aren't Vision users.

Negative: four new tables plus a new admin route group; token-as-access means losing/forwarding a link would let the holder submit as the recipient (mitigation: short campaign window, audit log, trusted internal recipients).

Out of scope: file upload on questions; anonymous public surveys; recurring scheduled surveys; respondent view of past submissions; resubmission after submit (manual reset only).
```

---

## §4 — Migration SQL

**File:** `prisma/migrations/20260622_operational_intelligence_survey/migration.sql`

```sql
-- ADR-0034 — Operational intelligence survey system.

CREATE TABLE "survey_campaigns" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "title"               TEXT NOT NULL,
  "slug"                TEXT NOT NULL,
  "intro_text"          TEXT NOT NULL,
  "subject_template"    TEXT NOT NULL DEFAULT 'DR3 Operations — your input requested for our new data system',
  "from_address"        TEXT NOT NULL DEFAULT 'dr3-vision@svdp.us',
  "from_display_name"   TEXT NOT NULL DEFAULT 'Bill Barnard via DR3-Vision',
  "reply_to"            TEXT NOT NULL DEFAULT 'bill.barnard@svdp.us',
  "status"              TEXT NOT NULL DEFAULT 'draft',
  "created_by_user_id"  UUID NOT NULL,
  "opened_at"           TIMESTAMP(3),
  "closed_at"           TIMESTAMP(3),
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "survey_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "survey_campaigns_slug_uq" UNIQUE ("slug"),
  CONSTRAINT "survey_campaigns_creator_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "survey_campaigns_status_idx" ON "survey_campaigns"("status");

CREATE TABLE "survey_invites" (
  "id"                  UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id"         UUID NOT NULL,
  "recipient_name"      TEXT NOT NULL,
  "recipient_email"     TEXT NOT NULL,
  "role_label"          TEXT NOT NULL,
  "token"               TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'draft',
  "approved_by_user_id" UUID,
  "approved_at"         TIMESTAMP(3),
  "sent_at"             TIMESTAMP(3),
  "first_opened_at"     TIMESTAMP(3),
  "submitted_at"        TIMESTAMP(3),
  "last_status"         INTEGER,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "survey_invites_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "survey_invites_token_uq" UNIQUE ("token"),
  CONSTRAINT "survey_invites_campaign_email_uq" UNIQUE ("campaign_id", "recipient_email"),
  CONSTRAINT "survey_invites_campaign_fk"
    FOREIGN KEY ("campaign_id") REFERENCES "survey_campaigns"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "survey_invites_approver_fk"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "survey_invites_campaign_idx" ON "survey_invites"("campaign_id");
CREATE INDEX "survey_invites_status_idx" ON "survey_invites"("status");

CREATE TABLE "survey_questions" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "invite_id"    UUID NOT NULL,
  "position"     INTEGER NOT NULL,
  "kind"         TEXT NOT NULL,
  "prompt"       TEXT NOT NULL,
  "description"  TEXT,
  "options"      JSONB,
  "is_required"  BOOLEAN NOT NULL DEFAULT false,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "survey_questions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "survey_questions_invite_position_uq" UNIQUE ("invite_id", "position"),
  CONSTRAINT "survey_questions_invite_fk"
    FOREIGN KEY ("invite_id") REFERENCES "survey_invites"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "survey_questions_invite_idx" ON "survey_questions"("invite_id", "position");

CREATE TABLE "survey_responses" (
  "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
  "invite_id"    UUID NOT NULL,
  "question_id"  UUID NOT NULL,
  "answer_text"  TEXT,
  "answer_json"  JSONB,
  "is_draft"     BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "survey_responses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "survey_responses_invite_question_uq" UNIQUE ("invite_id", "question_id"),
  CONSTRAINT "survey_responses_invite_fk"
    FOREIGN KEY ("invite_id") REFERENCES "survey_invites"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "survey_responses_question_fk"
    FOREIGN KEY ("question_id") REFERENCES "survey_questions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "survey_responses_invite_idx" ON "survey_responses"("invite_id");
```

---

## §5 — Prisma schema additions

Append to `schema.prisma`:

```prisma
// ────────────────────────────────────────────────────────────────────────
// Operational intelligence survey (ADR-0034)
// ────────────────────────────────────────────────────────────────────────

model SurveyCampaign {
  id                String   @id @default(uuid())
  title             String
  slug              String   @unique
  intro_text        String
  subject_template  String   @default("DR3 Operations — your input requested for our new data system")
  from_address      String   @default("dr3-vision@svdp.us")
  from_display_name String   @default("Bill Barnard via DR3-Vision")
  reply_to          String   @default("bill.barnard@svdp.us")
  status            String   @default("draft")
  created_by_user_id String
  created_by         User    @relation("SurveyCampaignCreator", fields: [created_by_user_id], references: [id])
  opened_at  DateTime?
  closed_at  DateTime?
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  invites SurveyInvite[]
  @@index([status])
  @@map("survey_campaigns")
}

model SurveyInvite {
  id                  String  @id @default(uuid())
  campaign_id         String
  campaign            SurveyCampaign @relation(fields: [campaign_id], references: [id], onDelete: Cascade)
  recipient_name      String
  recipient_email     String
  role_label          String
  token               String  @unique
  status              String  @default("draft")
  approved_by_user_id String?
  approved_by         User?   @relation("SurveyInviteApprover", fields: [approved_by_user_id], references: [id])
  approved_at      DateTime?
  sent_at          DateTime?
  first_opened_at  DateTime?
  submitted_at     DateTime?
  last_status      Int?
  created_at DateTime @default(now())
  updated_at DateTime @updatedAt
  questions SurveyQuestion[]
  responses SurveyResponse[]
  @@unique([campaign_id, recipient_email])
  @@index([campaign_id])
  @@index([status])
  @@map("survey_invites")
}

model SurveyQuestion {
  id          String  @id @default(uuid())
  invite_id   String
  invite      SurveyInvite @relation(fields: [invite_id], references: [id], onDelete: Cascade)
  position    Int
  kind        String
  prompt      String
  description String?
  options     Json?
  is_required Boolean @default(false)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt
  responses SurveyResponse[]
  @@unique([invite_id, position])
  @@index([invite_id, position])
  @@map("survey_questions")
}

model SurveyResponse {
  id          String  @id @default(uuid())
  invite_id   String
  invite      SurveyInvite @relation(fields: [invite_id], references: [id], onDelete: Cascade)
  question_id String
  question    SurveyQuestion @relation(fields: [question_id], references: [id], onDelete: Cascade)
  answer_text String?
  answer_json Json?
  is_draft    Boolean @default(true)
  created_at  DateTime @default(now())
  updated_at  DateTime @updatedAt
  @@unique([invite_id, question_id])
  @@index([invite_id])
  @@map("survey_responses")
}
```

Inside `model User`, add:

```prisma
  survey_campaigns_created  SurveyCampaign[] @relation("SurveyCampaignCreator")
  survey_invites_approved   SurveyInvite[]   @relation("SurveyInviteApprover")
```

(Chunk 1 ends here. Service modules in chunk 2; routes + UI in chunk 3; seed + tests + runbook + closing in chunk 4.)




---

## §6 — Service module: `src/lib/survey/`

### §6.1 — `src/lib/survey/types.ts`

```ts
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
  description?: string | null;
  options?: QuestionOption[] | null;
  is_required?: boolean;
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
  subject_template?: string;
  from_address?: string;
  from_display_name?: string;
  reply_to?: string;
}

export interface DraftAnswer {
  question_id: string;
  answer_text?: string | null;
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
```

### §6.2 — `src/lib/survey/campaigns.ts`

```ts
import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';
import type {
  ActorContext,
  CampaignInput,
  DraftAnswer,
  InviteInput,
  PublicActor,
  QuestionInput,
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
        before: null,
        after: serialize(campaign),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
    return campaign;
  });
}

export async function addInvite(
  campaignId: string,
  invite: InviteInput,
  actor: ActorContext,
) {
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
            options: (q.options ?? null) as Prisma.InputJsonValue | null,
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
        before: null,
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
        options: (q.options ?? null) as Prisma.InputJsonValue | null,
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

export async function closeCampaign(campaignId: string, actor: ActorContext) {
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
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'survey_campaigns',
        row_id: campaignId,
        before: serialize({ status: campaign.status }),
        after: serialize({ status: 'closed', closed_at: updated.closed_at }),
        ip: actor.ip,
        user_agent: actor.userAgent,
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
          answer_json: (a.answer_json ?? null) as Prisma.InputJsonValue | null,
          is_draft: true,
        },
        update: {
          answer_text: a.answer_text ?? null,
          answer_json: (a.answer_json ?? null) as Prisma.InputJsonValue | null,
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
        before: null,
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
```

---

## §7 — `src/lib/survey/tokens.ts`

```ts
// ADR-0034 — URL-safe cryptographic tokens for survey invite access.
//
// 32-char base64url tokens. crypto.randomBytes(24) gives 24 bytes = 192 bits
// entropy; base64url-encoded yields exactly 32 chars (no padding).
//
// Never log the token. Never include it in error messages. Always reference
// invites by their internal UUID in logs and audit rows.

import { randomBytes } from 'node:crypto';

const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isValidTokenShape(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}
```

---

## §8 — `src/lib/survey/notifications.ts`

```ts
// ADR-0034 — Render and send the survey invite email.
//
// SVdP-branded shell matching the daily production report email:
//   - red #a3151a masthead with SVdP wordmark
//   - gold #ffcc69 accent bar
//   - cream #f7f3ea panels
//   - inline-styled table-based ≤600px Outlook fidelity
//
// Per-recipient send. From, display name, reply-to drive from the campaign
// record. Never throws — fail-soft logs and returns delivered=false.

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import type { SurveyCampaign, SurveyInvite } from '@prisma/client';

export interface SendInviteArgs {
  campaign: Pick<
    SurveyCampaign,
    | 'title'
    | 'intro_text'
    | 'subject_template'
    | 'from_address'
    | 'from_display_name'
    | 'reply_to'
  >;
  invite: Pick<SurveyInvite, 'recipient_name' | 'recipient_email' | 'role_label' | 'token'>;
  baseUrl: string;
}

export interface SendInviteResult {
  delivered: boolean;
  last_status: number | null;
  graph_message_id: string | undefined;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderIntro(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 12px;line-height:1.55;color:#2a2a2a;font-size:14px">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`,
    )
    .join('');
}

export function renderInviteHtml(args: SendInviteArgs): string {
  const surveyUrl = `${args.baseUrl.replace(/\/+$/, '')}/survey/${args.invite.token}`;
  const intro = renderIntro(args.campaign.intro_text);
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f3ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f7f3ea">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #e8e2d4">
        <tr><td style="background:#a3151a;padding:18px 24px;color:#ffffff">
          <div style="font-size:18px;font-weight:600;letter-spacing:0.02em">St. Vincent de Paul · DR3</div>
          <div style="font-size:13px;opacity:0.9;margin-top:4px">DR3 Operational Intelligence</div>
        </td></tr>
        <tr><td style="background:#ffcc69;height:3px;line-height:3px;font-size:0">&nbsp;</td></tr>
        <tr><td style="padding:28px 28px 8px">
          <p style="margin:0 0 16px;font-size:15px;color:#1a1a1a">Hi ${escapeHtml(args.invite.recipient_name)},</p>
          ${intro}
        </td></tr>
        <tr><td style="padding:8px 28px 24px">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#a3151a;border-radius:4px">
              <a href="${escapeHtml(surveyUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.02em">Open your survey</a>
            </td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#666666">No login required. Responses save as you type; you can come back to finish later. Should take 20-45 minutes depending on how much detail you want to share.</p>
          <p style="margin:8px 0 0;font-size:11px;color:#999999;word-break:break-all">Direct link: ${escapeHtml(surveyUrl)}</p>
        </td></tr>
        <tr><td style="background:#f7f3ea;padding:14px 24px;border-top:1px solid #e8e2d4">
          <p style="margin:0;font-size:11px;color:#888888;line-height:1.4">This survey was created by Bill Barnard. Responses feed directly into the design of a new DR3 data management system intended to safeguard and automate processes, free up staff time, verify data accuracy, and improve overall operational tracking. Reply to this email if anything is unclear.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function sendInvite(args: SendInviteArgs): Promise<SendInviteResult> {
  const subject = args.campaign.subject_template;
  const htmlBody = renderInviteHtml(args);
  try {
    const r = await sendSystemEmail({
      to: { address: args.invite.recipient_email, name: args.invite.recipient_name },
      subject,
      htmlBody,
      importance: 'normal',
      fromDisplayName: args.campaign.from_display_name,
      replyTo: args.campaign.reply_to,
    });
    if (r.disabled) {
      log.warn({ inviteEmail: args.invite.recipient_email }, '[survey] M365 disabled — skip');
      return { delivered: false, last_status: null, graph_message_id: undefined };
    }
    return {
      delivered: r.delivered,
      last_status: r.lastStatus ?? null,
      graph_message_id: r.messageId,
    };
  } catch (e) {
    log.warn({ err: e, inviteEmail: args.invite.recipient_email }, '[survey] send threw');
    return { delivered: false, last_status: null, graph_message_id: undefined };
  }
}
```

### §8.1 — `src/lib/m365-mail.ts` extensions

Extend the `SendSystemEmailArgs` interface with three optional fields:

```ts
export interface SendSystemEmailArgs {
  to: string | { address: string; name?: string };
  subject: string;
  htmlBody: string;
  importance?: 'normal' | 'high';
  // ADR-0034 additions:
  fromDisplayName?: string;
  replyTo?: string;
  cc?: string[];
}
```

In the Graph send-mail payload construction:

```ts
const recipient =
  typeof args.to === 'string'
    ? { emailAddress: { address: args.to } }
    : {
        emailAddress: {
          address: args.to.address,
          ...(args.to.name ? { name: args.to.name } : {}),
        },
      };

const message: Record<string, unknown> = {
  subject: args.subject,
  body: { contentType: 'HTML', content: args.htmlBody },
  toRecipients: [recipient],
  importance: args.importance ?? 'normal',
};

if (args.fromDisplayName) {
  // The 'from' field overrides the default sender display name; mailbox must
  // still be one the app has SendAs permission for.
  message.from = {
    emailAddress: {
      address: senderMailbox,
      name: args.fromDisplayName,
    },
  };
}

if (args.replyTo) {
  message.replyTo = [{ emailAddress: { address: args.replyTo } }];
}

if (args.cc && args.cc.length > 0) {
  message.ccRecipients = args.cc.map((addr) => ({ emailAddress: { address: addr } }));
}
```

Existing callers keep their existing behavior — the three new fields are optional.

---

## §9 — `src/lib/survey/export.ts`

```ts
// ADR-0034 — Export survey responses as markdown to docs/operations-intel/.
//
// Generates one .md file per submitted invite plus a consolidated _summary.md.
// Files are pushed via the same ClaudeSync handoff mechanism used by sprint
// handoffs, just under docs/operations-intel/{campaign-slug}/.

import { prisma } from '@/lib/prisma';
import { log } from '@/lib/observability/logger';
import type { SurveyQuestion, SurveyResponse } from '@prisma/client';

const SLUG_NORMALIZE_RE = /[^a-z0-9-]+/g;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(SLUG_NORMALIZE_RE, '');
}

function renderAnswer(q: SurveyQuestion, r: SurveyResponse | undefined): string {
  if (!r) return '*(no response)*';
  if (q.kind === 'multi_select') {
    const json = r.answer_json as unknown;
    if (Array.isArray(json)) {
      return (json as unknown[]).map((v) => `- ${String(v)}`).join('\n');
    }
    return r.answer_text ?? '*(no response)*';
  }
  return (r.answer_text && r.answer_text.trim()) || '*(no response)*';
}

export interface ExportFile {
  path: string;
  body: string;
}

export async function buildExport(campaignId: string): Promise<ExportFile[]> {
  const campaign = await prisma.surveyCampaign.findUnique({
    where: { id: campaignId },
    include: {
      created_by: { select: { name: true, email: true } },
      invites: {
        where: { submitted_at: { not: null } },
        orderBy: { recipient_name: 'asc' },
        include: {
          questions: { orderBy: { position: 'asc' } },
          responses: true,
        },
      },
    },
  });
  if (!campaign) return [];

  const dir = `docs/operations-intel/${campaign.slug}`;
  const files: ExportFile[] = [];

  for (const invite of campaign.invites) {
    const respByQ = new Map(invite.responses.map((r) => [r.question_id, r]));
    const recipientSlug = slugify(invite.recipient_name);
    const lines: string[] = [];
    lines.push(`# ${invite.recipient_name} — ${invite.role_label}`);
    lines.push('');
    lines.push(`**Campaign:** ${campaign.title}`);
    lines.push(`**Recipient email:** ${invite.recipient_email}`);
    lines.push(`**Submitted at:** ${invite.submitted_at?.toISOString() ?? '—'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const q of invite.questions) {
      lines.push(`## ${q.position}. ${q.prompt}`);
      if (q.description) {
        lines.push('');
        lines.push(`> ${q.description}`);
      }
      lines.push('');
      lines.push(renderAnswer(q, respByQ.get(q.id)));
      lines.push('');
    }
    files.push({ path: `${dir}/${recipientSlug}.md`, body: lines.join('\n') });
  }

  const summaryLines: string[] = [];
  summaryLines.push(`# ${campaign.title} — submission summary`);
  summaryLines.push('');
  summaryLines.push(`**Slug:** \`${campaign.slug}\`  `);
  summaryLines.push(`**Owner:** ${campaign.created_by.name} (${campaign.created_by.email})  `);
  summaryLines.push(`**Opened:** ${campaign.opened_at?.toISOString() ?? '—'}  `);
  summaryLines.push(`**Closed:** ${campaign.closed_at?.toISOString() ?? '—'}  `);
  summaryLines.push(`**Submissions:** ${campaign.invites.length}`);
  summaryLines.push('');
  summaryLines.push('## Respondents');
  summaryLines.push('');
  summaryLines.push('| Recipient | Role | Submitted | File |');
  summaryLines.push('|---|---|---|---|');
  for (const invite of campaign.invites) {
    const recipientSlug = slugify(invite.recipient_name);
    summaryLines.push(
      `| ${invite.recipient_name} | ${invite.role_label} | ${invite.submitted_at?.toISOString() ?? '—'} | \`${recipientSlug}.md\` |`,
    );
  }
  files.push({ path: `${dir}/_summary.md`, body: summaryLines.join('\n') });

  return files;
}

/**
 * Logs the export file plan. The actual ClaudeSync push is invoked from the
 * admin UI route handler (which has the operator's auth context); this module
 * only builds the file contents and returns them.
 */
export async function logExportSummary(campaignId: string): Promise<void> {
  const files = await buildExport(campaignId);
  for (const f of files) {
    log.info({ path: f.path, bytes: f.body.length }, '[survey] export file ready');
  }
}
```

---

## §10 — Public survey route

### §10.1 — `src/app/survey/[token]/page.tsx`

```tsx
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
```

### §10.2 — `src/app/survey/[token]/SurveyForm.tsx`

Client component, no auth, 800ms debounced draft autosave, supports all four question kinds, SVdP-branded shell. Full source:

```tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

interface QuestionPropsBase {
  id: string;
  position: number;
  kind: 'short_text' | 'long_text' | 'single_select' | 'multi_select';
  prompt: string;
  description: string | null;
  options: Array<{ label: string; value: string }> | null;
  is_required: boolean;
}

interface InviteForForm {
  id: string;
  recipient_name: string;
  role_label: string;
  campaign: { title: string; intro_text: string; from_display_name: string };
  questions: QuestionPropsBase[];
  responses: Array<{ question_id: string; answer_text: string | null; answer_json: unknown }>;
  token: string;
}

interface AnswerMap {
  [questionId: string]: { answer_text?: string; answer_json?: unknown };
}

export function SurveyForm({ invite }: { invite: InviteForForm }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<AnswerMap>(() => {
    const init: AnswerMap = {};
    for (const r of invite.responses) {
      init[r.question_id] = {
        answer_text: r.answer_text ?? undefined,
        answer_json: r.answer_json ?? undefined,
      };
    }
    return init;
  });
  const [savingStatus, setSavingStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dirtyRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  function scheduleSave() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void saveDrafts(), 800);
  }

  function setText(qid: string, text: string) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_text: text } }));
    dirtyRef.current.add(qid);
    scheduleSave();
  }

  function setMulti(qid: string, values: string[]) {
    setAnswers((prev) => ({ ...prev, [qid]: { ...prev[qid], answer_json: values } }));
    dirtyRef.current.add(qid);
    scheduleSave();
  }

  async function saveDrafts() {
    const dirty = [...dirtyRef.current];
    if (dirty.length === 0) return;
    dirtyRef.current.clear();
    setSavingStatus('saving');
    try {
      const current = answersRef.current;
      const payload = dirty.map((qid) => ({
        question_id: qid,
        answer_text: current[qid]?.answer_text ?? null,
        answer_json: current[qid]?.answer_json ?? null,
      }));
      const r = await fetch(`/api/survey/${invite.token}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: payload }),
      });
      if (!r.ok) throw new Error(`save failed: ${r.status}`);
      setSavingStatus('saved');
      setTimeout(() => setSavingStatus('idle'), 1500);
    } catch {
      setSavingStatus('error');
      dirty.forEach((q) => dirtyRef.current.add(q));
    }
  }

  async function handleSubmit() {
    await saveDrafts();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await fetch(`/api/survey/${invite.token}/submit`, { method: 'POST' });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: 'unknown' }));
        throw new Error(
          err.error === 'invalid_input'
            ? 'Please answer all required questions.'
            : 'Submission failed. Try again.',
        );
      }
      router.refresh();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px 80px' }}>
        <header
          style={{
            background: '#a3151a',
            color: '#fff',
            padding: '20px 24px',
            borderRadius: 6,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>St. Vincent de Paul · DR3</div>
          <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{invite.campaign.title}</div>
        </header>
        <section
          style={{
            background: '#fff',
            padding: '24px',
            marginTop: 12,
            borderRadius: 6,
            border: '1px solid #e8e2d4',
          }}
        >
          <p style={{ margin: 0, fontWeight: 600, fontSize: 16 }}>
            Hi {invite.recipient_name},
          </p>
          <p style={{ marginTop: 4, fontSize: 13, color: '#666' }}>Role: {invite.role_label}</p>
          <div
            style={{
              marginTop: 16,
              color: '#1a1a1a',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.55,
            }}
          >
            {invite.campaign.intro_text}
          </div>
        </section>
        <ol style={{ listStyle: 'none', padding: 0, marginTop: 24 }}>
          {invite.questions.map((q) => (
            <li
              key={q.id}
              style={{
                background: '#fff',
                padding: '20px 24px',
                marginBottom: 12,
                borderRadius: 6,
                border: '1px solid #e8e2d4',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 12, color: '#999', fontFamily: 'monospace' }}>
                  {q.position}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, color: '#1a1a1a' }}>
                    {q.prompt}
                    {q.is_required && (
                      <span style={{ color: '#a3151a', marginLeft: 4 }}>*</span>
                    )}
                  </div>
                  {q.description && (
                    <div style={{ marginTop: 4, fontSize: 13, color: '#666' }}>
                      {q.description}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ marginTop: 14 }}>
                {q.kind === 'short_text' && (
                  <input
                    type="text"
                    value={answers[q.id]?.answer_text ?? ''}
                    onChange={(e) => setText(q.id, e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 10px',
                      fontSize: 14,
                      border: '1px solid #d0c8b4',
                      borderRadius: 4,
                    }}
                  />
                )}
                {q.kind === 'long_text' && (
                  <textarea
                    value={answers[q.id]?.answer_text ?? ''}
                    onChange={(e) => setText(q.id, e.target.value)}
                    rows={6}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: 14,
                      border: '1px solid #d0c8b4',
                      borderRadius: 4,
                      fontFamily: 'inherit',
                      resize: 'vertical',
                    }}
                  />
                )}
                {q.kind === 'single_select' && q.options && (
                  <div>
                    {q.options.map((opt) => (
                      <label
                        key={opt.value}
                        style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}
                      >
                        <input
                          type="radio"
                          name={q.id}
                          value={opt.value}
                          checked={answers[q.id]?.answer_text === opt.value}
                          onChange={() => setText(q.id, opt.value)}
                          style={{ marginRight: 8 }}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                )}
                {q.kind === 'multi_select' && q.options && (
                  <div>
                    {q.options.map((opt) => {
                      const current = (answers[q.id]?.answer_json as string[]) ?? [];
                      const checked = current.includes(opt.value);
                      return (
                        <label
                          key={opt.value}
                          style={{ display: 'block', padding: '4px 0', cursor: 'pointer' }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              const next = e.target.checked
                                ? [...current, opt.value]
                                : current.filter((v) => v !== opt.value);
                              setMulti(q.id, next);
                            }}
                            style={{ marginRight: 8 }}
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div
          style={{
            background: '#fff',
            padding: 20,
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ fontSize: 12, color: '#888' }}>
            {savingStatus === 'saving' && 'Saving…'}
            {savingStatus === 'saved' && 'Draft saved ✓'}
            {savingStatus === 'error' && (
              <span style={{ color: '#a3151a' }}>Save error — will retry</span>
            )}
            {savingStatus === 'idle' && 'Draft auto-saves as you type'}
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              background: '#a3151a',
              color: '#fff',
              padding: '10px 24px',
              border: 'none',
              borderRadius: 4,
              fontSize: 14,
              fontWeight: 600,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}
          >
            {submitting ? 'Submitting…' : 'Submit responses'}
          </button>
        </div>
        {submitError && (
          <p style={{ marginTop: 12, color: '#a3151a', fontSize: 13 }}>{submitError}</p>
        )}
      </div>
    </main>
  );
}
```

### §10.3 — `src/app/survey/[token]/ThankYou.tsx`

```tsx
export function ThankYou({
  submittedAt,
  recipientName,
}: {
  submittedAt: Date;
  recipientName: string;
}) {
  return (
    <main style={{ background: '#f7f3ea', minHeight: '100vh' }}>
      <div style={{ maxWidth: 560, margin: '0 auto', padding: '60px 16px' }}>
        <div
          style={{
            background: '#fff',
            padding: '40px 32px',
            borderRadius: 6,
            border: '1px solid #e8e2d4',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              background: '#a3151a',
              color: '#fff',
              padding: '16px 20px',
              borderRadius: 6,
              marginBottom: 24,
            }}
          >
            <div style={{ fontSize: 16, fontWeight: 600 }}>St. Vincent de Paul · DR3</div>
            <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>
              DR3 Operational Intelligence
            </div>
          </div>
          <h1 style={{ fontSize: 22, margin: '0 0 12px', color: '#1a1a1a' }}>
            Thank you, {recipientName}.
          </h1>
          <p style={{ fontSize: 14, color: '#666', margin: '0 0 8px' }}>
            Your responses were submitted on {submittedAt.toISOString().slice(0, 10)} at{' '}
            {submittedAt.toISOString().slice(11, 16)} UTC.
          </p>
          <p style={{ fontSize: 13, color: '#999', margin: '24px 0 0' }}>
            If you need to amend your responses, reply to the original email and Bill can
            reopen your invite.
          </p>
        </div>
      </div>
    </main>
  );
}
```

(End of chunk 2. Admin UI, API routes follow in chunk 3.)




---

## §11 — Admin UI under `/admin/operations/intel`

All admin routes super-admin gated via the existing pattern. Reference `/admin/production-report/` for the surrounding layout, header, and breadcrumb conventions.

### §11.1 — `src/app/admin/operations/intel/page.tsx`

Server component. Gates on `session.user.is_super_admin === true` → otherwise 403 redirect. Calls `listCampaigns()` and passes the result to `CampaignList`. Layout follows existing admin pages — SVdP-branded shell, breadcrumb `Admin / Operations / Intelligence Survey`.

```tsx
import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { listCampaigns } from '@/lib/survey/campaigns';
import { CampaignList } from './CampaignList';

export const dynamic = 'force-dynamic';

export default async function OperationsIntelPage() {
  const session = await auth();
  if (!session?.user?.is_super_admin) redirect('/');

  const campaigns = await listCampaigns();
  return <CampaignList campaigns={campaigns} />;
}
```

### §11.2 — `src/app/admin/operations/intel/CampaignList.tsx`

Client component. Renders the table of campaigns (title, status badge, invite count, opened_at, closed_at, link to detail page) plus a "New campaign" button that POSTs to `/api/admin/operations/intel/campaigns`. Status badges: gray for `draft`, green for `open`, neutral for `closed`. Each row links to `/admin/operations/intel/{campaignId}`.

Key behaviors:
- "New campaign" opens a modal collecting title, slug (auto-generated from title), intro_text, optional override of subject/from_address/from_display_name/reply_to. Defaults are the ADR-0034 values.
- Slug must match `^[a-z0-9-]+$`; client-validates before POST.
- On success, router push to the new campaign's detail page.

### §11.3 — `src/app/admin/operations/intel/[campaignId]/page.tsx`

Server component. Gates same as §11.1. Calls `getCampaignWithInvites(campaignId)`; 404s if not found. Passes campaign + invites to `CampaignDetail`.

```tsx
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getCampaignWithInvites } from '@/lib/survey/campaigns';
import { CampaignDetail } from './CampaignDetail';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ campaignId: string }>;
}

export default async function CampaignDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.user?.is_super_admin) redirect('/');

  const { campaignId } = await params;
  const campaign = await getCampaignWithInvites(campaignId);
  if (!campaign) notFound();
  return <CampaignDetail campaign={campaign} />;
}
```

### §11.4 — `src/app/admin/operations/intel/[campaignId]/CampaignDetail.tsx`

Client component. Three regions:

1. **Header** — campaign title, status badge, created-by, opened_at/closed_at, action buttons: "Send Campaign" (opens `SendInterstitial`, disabled if no approved invites), "Close Campaign" (opens confirmation, calls `/api/admin/operations/intel/campaigns/{id}/close`), "Export now" (calls `/api/admin/operations/intel/campaigns/{id}/close?export_only=true` — pushes the markdown export without state-changing the campaign).
2. **Invite list** — table of invites (name, email, role label, status badge, approved-by, sent_at, opened_at, submitted_at). Each row has a "View" button that opens `InviteEditor` for editing or `InvitePreview` for preview-and-approve, depending on status.
3. **"Add invite" button** — opens a modal to add a new recipient (name, email, role label, question packet — the question packet starts empty and the user adds questions one at a time, OR clicks "Use template" to load one of the pre-seeded packets).

Status badges:
- `draft` (gray) — questions can be edited
- `approved` (gold #ffcc69) — questions locked, preview shows the email and survey preview side-by-side
- `sent` (blue) — emailed, awaiting recipient
- `opened` (green border) — recipient opened the link
- `submitted` (green solid) — done

Editing questions on an `approved` invite clears approval back to `draft` (must re-preview and re-approve).

### §11.5 — `src/app/admin/operations/intel/[campaignId]/InviteEditor.tsx`

Client component. Modal with two columns:

Left — invite metadata: recipient_name, recipient_email, role_label (editable while in `draft`; readonly afterward).

Right — question packet editor. Each question is a card showing prompt, description, kind, options (for select kinds), required toggle, and reorder/delete buttons. Empty state shows the templated packets ("Load template: Bethany / Leisha / Shannon / Mary / Rick / Janette / Morena / Kelsey / Juan / Patrick").

Save calls `PATCH /api/admin/operations/intel/campaigns/{id}/invites/{inviteId}` with the full question list. Returns the updated invite (which is back in `draft` if it had been `approved`).

### §11.6 — `src/app/admin/operations/intel/[campaignId]/InvitePreview.tsx`

Client component. Modal with two tabs:

- **Email preview** — server-rendered iframe showing the EXACT HTML the recipient will receive (from `POST /api/admin/operations/intel/campaigns/{id}/invites/{inviteId}/preview`). Shows the From/Reply-To/Subject headers above the iframe so Bill can verify them.
- **Survey page preview** — server-rendered iframe of `/survey/{token}` (read-only preview mode — passes a query parameter `?preview=1` that the public route honors by not marking the invite as opened).

Footer buttons: "Edit questions" (closes preview, opens InviteEditor), "Approve" (POSTs `/api/admin/operations/intel/campaigns/{id}/invites/{inviteId}/approve`, status → `approved`).

After approval, the modal stays open showing a green "Approved at {timestamp} by {user}" banner; the Approve button is replaced with "Revoke approval" (PATCHes back to `draft`).

### §11.7 — `src/app/admin/operations/intel/[campaignId]/SendInterstitial.tsx`

Client component. Modal that appears when "Send Campaign" is clicked. Three states:

1. **Confirmation form** — lists every approved invite (name, email, role label) and shows the count: "**You are about to send 10 emails to 10 recipients.**" Asks the user to type the campaign title into an input to confirm (defense against accidental clicks). "Cancel" / "Send {count} emails" buttons.
2. **In-progress** — shows a progress list (recipient name + spinner / ✓ / ✗ for each).
3. **Completed** — shows the final results (success/failure per recipient). On any failure, the failed invites stay in `approved` state (NOT `sent`) so they can be retried.

The submit calls `POST /api/admin/operations/intel/campaigns/{id}/send` with body `{ confirmed_recipient_count: N }`. The endpoint refuses if the count diverges from the actual approved-count at request time.

---

## §12 — API routes

### §12.1 — `src/app/api/survey/[token]/route.ts`

```ts
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
```

### §12.2 — `src/app/api/survey/[token]/draft/route.ts`

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { getInviteByToken, saveDraft, SurveyCampaignError } from '@/lib/survey/campaigns';
import { isValidTokenShape } from '@/lib/survey/tokens';

const Body = z.object({
  answers: z.array(
    z.object({
      question_id: z.string().uuid(),
      answer_text: z.string().nullable().optional(),
      answer_json: z.unknown().optional(),
    }),
  ),
});

interface Ctx {
  params: Promise<{ token: string }>;
}

export async function PUT(req: Request, ctx: Ctx) {
  const { token } = await ctx.params;
  if (!isValidTokenShape(token)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const invite = await getInviteByToken(token);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    await saveDraft(invite.id, parsed.data.answers, { ip, userAgent });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

### §12.3 — `src/app/api/survey/[token]/submit/route.ts`

```ts
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
```

### §12.4 — `src/app/api/admin/operations/intel/campaigns/route.ts`

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/auth';
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
```

### §12.5 — `src/app/api/admin/operations/intel/campaigns/[id]/route.ts`

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getCampaignWithInvites } from '@/lib/survey/campaigns';

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
```

### §12.6 — `src/app/api/admin/operations/intel/campaigns/[id]/invites/route.ts`

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/auth';
import { addInvite, SurveyCampaignError } from '@/lib/survey/campaigns';

const QuestionSchema = z.object({
  position: z.number().int().nonnegative(),
  kind: z.enum(['short_text', 'long_text', 'single_select', 'multi_select']),
  prompt: z.string().min(1),
  description: z.string().nullable().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .nullable()
    .optional(),
  is_required: z.boolean().optional(),
});

const Body = z.object({
  recipient_name: z.string().min(1),
  recipient_email: z.string().email(),
  role_label: z.string().min(1),
  questions: z.array(QuestionSchema).min(1),
});

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    const created = await addInvite(id, parsed.data, {
      userId: session.user.id,
      ip,
      userAgent,
    });
    return NextResponse.json({ invite: created }, { status: 201 });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

### §12.7 — `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/route.ts`

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/auth';
import {
  getInviteWithQuestions,
  SurveyCampaignError,
  updateInviteQuestions,
} from '@/lib/survey/campaigns';

const Body = z.object({
  questions: z
    .array(
      z.object({
        position: z.number().int().nonnegative(),
        kind: z.enum(['short_text', 'long_text', 'single_select', 'multi_select']),
        prompt: z.string().min(1),
        description: z.string().nullable().optional(),
        options: z
          .array(z.object({ label: z.string(), value: z.string() }))
          .nullable()
          .optional(),
        is_required: z.boolean().optional(),
      }),
    )
    .min(1),
});

interface Ctx {
  params: Promise<{ id: string; inviteId: string }>;
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const invite = await getInviteWithQuestions(inviteId);
  if (!invite) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  return NextResponse.json({ invite });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { inviteId } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_input' }, { status: 422 });
  }
  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    await updateInviteQuestions(inviteId, parsed.data.questions, {
      userId: session.user.id,
      ip,
      userAgent,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

### §12.8 — `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/approve/route.ts`

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/auth';
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
```

### §12.9 — `src/app/api/admin/operations/intel/campaigns/[id]/invites/[inviteId]/preview/route.ts`

Renders the EXACT email HTML for the invite. Returns the HTML body, subject, sender display, reply-to, recipient.

```ts
import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { renderInviteHtml } from '@/lib/survey/notifications';
import { getInviteWithQuestions } from '@/lib/survey/campaigns';

interface Ctx {
  params: Promise<{ id: string; inviteId: string }>;
}

function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
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
```

### §12.10 — `src/app/api/admin/operations/intel/campaigns/[id]/send/route.ts`

Critical route. Refuses to send unless every targeted invite is `approved` AND `confirmed_recipient_count` matches.

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { z } from 'zod';
import { auth } from '@/auth';
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
  return process.env.PUBLIC_BASE_URL?.replace(/\/+$/, '') ?? 'https://dr3-vision.svdp.us';
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
```

### §12.11 — `src/app/api/admin/operations/intel/campaigns/[id]/close/route.ts`

Close + auto-export. On `?export_only=true` it produces the ClaudeSync push without state change; otherwise transitions the campaign to `closed`.

```ts
import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { auth } from '@/auth';
import { closeCampaign, SurveyCampaignError } from '@/lib/survey/campaigns';
import { buildExport } from '@/lib/survey/export';
import { log } from '@/lib/observability/logger';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user?.is_super_admin || !session.user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await ctx.params;
  const url = new URL(req.url);
  const exportOnly = url.searchParams.get('export_only') === 'true';

  const hdrs = await headers();
  const ip = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const userAgent = hdrs.get('user-agent');

  try {
    if (!exportOnly) {
      await closeCampaign(id, { userId: session.user.id, ip, userAgent });
    }
    const files = await buildExport(id);
    for (const f of files) {
      log.info({ path: f.path, bytes: f.body.length }, '[survey] export ready');
    }
    // The actual ClaudeSync push is wired in a follow-up via a queued job that
    // calls into the ClaudeSync write tool path the operator already uses.
    // For now we surface the files in the response so the operator can review.
    return NextResponse.json({
      ok: true,
      files: files.map((f) => ({ path: f.path, bytes: f.body.length })),
    });
  } catch (e) {
    if (e instanceof SurveyCampaignError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

(End of chunk 3. Seed packets, tests, runbook, CHANGELOG, closing follow in chunk 4.)
