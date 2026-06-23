-- ADR-0034 — Operational intelligence survey system.
-- NOTE: ids/FKs are TEXT (NOT uuid) to match this repo's convention — users.id
-- and all existing ids are TEXT, and Prisma `String @id @default(uuid())`
-- generates the id app-side (no DB gen_random_uuid default). The original spec
-- used uuid, which failed on deploy with FK type-incompatibility (uuid vs text).

CREATE TABLE "survey_campaigns" (
  "id"                  TEXT NOT NULL,
  "title"               TEXT NOT NULL,
  "slug"                TEXT NOT NULL,
  "intro_text"          TEXT NOT NULL,
  "subject_template"    TEXT NOT NULL DEFAULT 'DR3 Operations — your input requested for our new data system',
  "from_address"        TEXT NOT NULL DEFAULT 'dr3-vision@svdp.us',
  "from_display_name"   TEXT NOT NULL DEFAULT 'Bill Barnard via DR3-Vision',
  "reply_to"            TEXT NOT NULL DEFAULT 'bill.barnard@svdp.us',
  "status"              TEXT NOT NULL DEFAULT 'draft',
  "created_by_user_id"  TEXT NOT NULL,
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
  "id"                  TEXT NOT NULL,
  "campaign_id"         TEXT NOT NULL,
  "recipient_name"      TEXT NOT NULL,
  "recipient_email"     TEXT NOT NULL,
  "role_label"          TEXT NOT NULL,
  "token"               TEXT NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'draft',
  "approved_by_user_id" TEXT,
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
  "id"           TEXT NOT NULL,
  "invite_id"    TEXT NOT NULL,
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
  "id"           TEXT NOT NULL,
  "invite_id"    TEXT NOT NULL,
  "question_id"  TEXT NOT NULL,
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
