-- ADR-0141 — an invoice the team received directly: in-app submission, and the
-- submitter names the accountant who receives the outcome.
--
-- Additive only (ADR-0035). Every existing ap_requests row becomes
-- intake_channel = 'mailbox' through the column default; nothing is rewritten.
-- Idempotent (IF NOT EXISTS / duplicate_object / ON CONFLICT) so a re-run is a
-- no-op and a clean PG16 replay succeeds.

-- ── 1. Intake channel ───────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ApIntakeChannel" AS ENUM ('mailbox', 'team_submit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. The accounting-staff list (ADR-0141 D3) ──────────────────────────────
CREATE TABLE IF NOT EXISTS "ap_accounting_contacts" (
    "id"           TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "email"        TEXT NOT NULL,
    "active"       BOOLEAN NOT NULL DEFAULT true,
    "created_by"   TEXT,
    "updated_by"   TEXT,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ap_accounting_contacts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ap_accounting_contacts_email_key"
  ON "ap_accounting_contacts" ("email");
CREATE INDEX IF NOT EXISTS "ap_accounting_contacts_active_idx"
  ON "ap_accounting_contacts" ("active");

-- An accountant is an internal SVdP mailbox, stored lower-case, with a name.
DO $$ BEGIN
  ALTER TABLE "ap_accounting_contacts"
    ADD CONSTRAINT "ap_accounting_contacts_email_svdp_chk"
    CHECK ("email" = lower("email") AND "email" ~ '^[^@\s]+@svdp\.us$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ap_accounting_contacts"
    ADD CONSTRAINT "ap_accounting_contacts_name_chk"
    CHECK (length(btrim("display_name")) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. ap_requests: submission facts (ADR-0141 D6) ──────────────────────────
ALTER TABLE "ap_requests"
  ADD COLUMN IF NOT EXISTS "intake_channel" "ApIntakeChannel" NOT NULL DEFAULT 'mailbox';
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_by" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_site_id" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMP(3);
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "outcome_recipient_id" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "outcome_recipient_email" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_vendor" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_invoice_number" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN IF NOT EXISTS "submitted_amount_cents" INTEGER;

DO $$ BEGIN
  ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_submitted_by_fkey"
    FOREIGN KEY ("submitted_by") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_submitted_site_id_fkey"
    FOREIGN KEY ("submitted_site_id") REFERENCES "sites"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_outcome_recipient_id_fkey"
    FOREIGN KEY ("outcome_recipient_id") REFERENCES "ap_accounting_contacts"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A team submission always names its submitter, site and accountant (Bill
-- 2026-10-08: exactly one accountant, required). A mailbox row carries none of
-- them, so the existing intake path cannot be mistaken for a team row.
DO $$ BEGIN
  ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_team_submit_shape_chk"
    CHECK (
      ("intake_channel" = 'team_submit'
        AND "submitted_by" IS NOT NULL
        AND "submitted_site_id" IS NOT NULL
        AND "submitted_at" IS NOT NULL
        AND "outcome_recipient_id" IS NOT NULL
        AND "outcome_recipient_email" IS NOT NULL)
      OR
      ("intake_channel" = 'mailbox'
        AND "submitted_by" IS NULL
        AND "outcome_recipient_id" IS NULL
        AND "outcome_recipient_email" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "ap_requests_submitted_by_idx" ON "ap_requests" ("submitted_by");

-- ── 4. Seed the accounting list (Bill, 2026-10-08 08:56 + 09:05 PDT) ────────
-- A data migration rather than an admin click, following the repo's precedent
-- for named-person seeds (ADR-0066, ADR-0046 Am.9, ADR-0019.7): it lands in the
-- same deploy as the code that reads it, so the submit form is never born with
-- an empty picker. ON CONFLICT DO NOTHING: a re-run, or an admin who has since
-- edited or deactivated a row, is never overwritten. One audit_log row per row
-- actually inserted (CLAUDE.md hard rule #6).
WITH seeded AS (
  INSERT INTO "ap_accounting_contacts" ("id", "display_name", "email", "active", "created_at", "updated_at")
  VALUES
    (gen_random_uuid()::text, 'Gloria Salpino',  'gloria.salpino@svdp.us',  true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'Mary Scott',      'mary.scott@svdp.us',      true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'Yvonne Stephens', 'yvonne.stephens@svdp.us', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT ("email") DO NOTHING
  RETURNING "id", "display_name", "email"
)
INSERT INTO "audit_log" ("id", "actor_label", "action", "table_name", "row_id", "before", "after", "created_at")
SELECT gen_random_uuid()::text,
       'system:migration 20260869 (Bill instruction 2026-10-08: seed the AP accounting list; ADR-0141)',
       'insert'::"AuditAction",
       'ap_accounting_contacts',
       s."id",
       NULL,
       jsonb_build_object('display_name', s."display_name", 'email', s."email", 'active', true),
       CURRENT_TIMESTAMP
FROM seeded s;

-- ── 5. Rollout gates (ADR-0047), born pilot ─────────────────────────────────
-- ui/ap_team_submit: the submit screen + its API. Pilot = admins only.
-- notification/ap_team_outcome: decision + hold mail for team rows. A NEW
-- recipient set (the chosen accountant + the submitter), so it gets its own row
-- rather than riding `ap_notify` (the ADR-0068 precedent). Pilot = admins only,
-- with the would-have-sent header naming the accountant.
-- Zero rows on a clean replay (`sites` is seeded later by prisma/seed.mjs, which
-- registers both codes too). ON CONFLICT DO NOTHING never reverts a live flip.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, v.kind::"RolloutSurfaceKind", v.code, s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
CROSS JOIN (VALUES ('ui', 'ap_team_submit'), ('notification', 'ap_team_outcome')) AS v(kind, code)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
