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
