-- ADR-0045 (P5) — ops task ledger + meeting notes, Updates/board digest, contact intake.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds four enums and five tables:
--   - ops_notes       — meeting/ops notes (D1); site_id NULL = org-wide.
--   - ops_tasks       — task follow-ups (D1); born manual / from a note / from intake.
--   - update_digests  — generated Updates + board-pack DRAFTS (D2). No send column.
--   - contact_intakes — website contact-form submissions (D3). PII columns.
--   - contact_routes  — topic→email routing rules (D3), seeded here (idempotent).
--
-- The dir name `20260711_ops_ledger_intake` sorts AFTER the current main chain
-- tip (`20260709_alert_recipients`) and after the parallel ADR-0044 migration
-- (`20260710_…`), preserving ADR-0035 lexical migration ordering.
--
-- FK columns to sibling-owned models (`site_id`, and the audit-actor columns) are
-- created as bare DB-level constraints — Prisma carries no relation for them (the
-- ADR-0040/0041/0042 + alert_recipients precedent). The two constraints that DO
-- back a Prisma relation (`ops_tasks.note_id`, `contact_intakes.task_id`) use the
-- Prisma-generated `*_fkey` name + ON DELETE SET NULL semantics so no drift.

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "OpsTaskStatus" AS ENUM ('open', 'done', 'dropped');
CREATE TYPE "OpsTaskSource" AS ENUM ('manual', 'meeting', 'contact_form');
CREATE TYPE "UpdateDigestStatus" AS ENUM ('draft', 'finalized');
CREATE TYPE "UpdateDigestKind" AS ENUM ('weekly', 'board_pack');

-- ─────────────────────────────────────────────────────────────────────────
-- ops_notes — meeting/ops notes (D1)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "ops_notes" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "note_date" DATE NOT NULL,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "author_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_notes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ops_notes_site_id_note_date_idx" ON "ops_notes"("site_id", "note_date");

ALTER TABLE "ops_notes"
    ADD CONSTRAINT "ops_notes_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- ops_tasks — task follow-ups (D1)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "ops_tasks" (
    "id" TEXT NOT NULL,
    "site_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "assignee_user_id" TEXT,
    "due_date" DATE,
    "status" "OpsTaskStatus" NOT NULL DEFAULT 'open',
    "source" "OpsTaskSource" NOT NULL DEFAULT 'manual',
    "note_id" TEXT,
    "created_by" TEXT,
    "completed_at" TIMESTAMP(3),
    "completed_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ops_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ops_tasks_site_id_status_due_date_idx" ON "ops_tasks"("site_id", "status", "due_date");
CREATE INDEX "ops_tasks_note_id_idx" ON "ops_tasks"("note_id");

ALTER TABLE "ops_tasks"
    ADD CONSTRAINT "ops_tasks_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma-backed relation (ops_tasks.note → ops_notes): optional relation →
-- SET NULL on delete, matching Prisma's generated constraint.
ALTER TABLE "ops_tasks"
    ADD CONSTRAINT "ops_tasks_note_id_fkey"
    FOREIGN KEY ("note_id") REFERENCES "ops_notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- update_digests — Updates + board-pack DRAFTS (D2)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "update_digests" (
    "id" TEXT NOT NULL,
    "kind" "UpdateDigestKind" NOT NULL DEFAULT 'weekly',
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "body_md" TEXT NOT NULL,
    "status" "UpdateDigestStatus" NOT NULL DEFAULT 'draft',
    "generated_by" TEXT,
    "finalized_by" TEXT,
    "finalized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "update_digests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "update_digests_kind_period_start_key" ON "update_digests"("kind", "period_start");
CREATE INDEX "update_digests_status_period_start_idx" ON "update_digests"("status", "period_start");

-- ─────────────────────────────────────────────────────────────────────────
-- contact_intakes — website contact-form submissions (D3)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "contact_intakes" (
    "id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "topic" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "message" TEXT NOT NULL,
    "routed_to_email" TEXT NOT NULL,
    "route_id" TEXT,
    "task_id" TEXT,
    "source_form" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_intakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_intakes_task_id_key" ON "contact_intakes"("task_id");
CREATE INDEX "contact_intakes_received_at_idx" ON "contact_intakes"("received_at");

-- Prisma-backed relation (contact_intakes.task → ops_tasks): optional → SET NULL.
ALTER TABLE "contact_intakes"
    ADD CONSTRAINT "contact_intakes_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "ops_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- contact_routes — topic→email routing rules (D3) + idempotent seed
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "contact_routes" (
    "id" TEXT NOT NULL,
    "topic_match" TEXT NOT NULL,
    "route_to_email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_routes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "contact_routes_topic_match_key" ON "contact_routes"("topic_match");
CREATE INDEX "contact_routes_active_idx" ON "contact_routes"("active");

-- Seed the two LOCKED routes (ADR-0045 D3): tours → Rick, everything else →
-- Morena (pending the dispatch-inbox register decision). Idempotent via ON
-- CONFLICT on the unique topic_match, so a replay / re-run is a no-op. Emails
-- verified against prisma/seed users (rick.albritton@ / morena.gomez@). `tour*`
-- has the lower priority so it matches before the `*` catch-all.
INSERT INTO "contact_routes" ("id", "topic_match", "route_to_email", "active", "priority", "created_by", "created_at", "updated_at")
VALUES
    (gen_random_uuid(), 'tour*', 'rick.albritton@svdp.us', true, 10, 'system:adr-0045-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid(), '*', 'morena.gomez@svdp.us', true, 1000, 'system:adr-0045-seed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("topic_match") DO NOTHING;
