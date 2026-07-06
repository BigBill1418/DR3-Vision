-- ADR-0046 — Vendor-invoice approval via Graph mailbox ingestion.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds five enums and eight tables for the AP approval pipeline. No existing
-- table is touched; no seed rows are inserted here (the decision-recipient roster
-- and the sender-mode config seed at runtime / are seeded EMPTY on purpose — see
-- ADR-0046 D4 + docs/operator/ap-approvals.md).
--
-- These records are ORG-level AP (accounting), deliberately NOT site-scoped: no
-- `site_id`, no FK to `sites`. The only FKs are the two child→parent links
-- (attachments/followups → ap_requests, ON DELETE CASCADE).
--
-- The dir name `20260712_ap_approvals` sorts AFTER the current main chain tip
-- (`20260711_ops_ledger_intake`), preserving ADR-0035 lexical migration ordering.
-- The freshly-added enum values are used only in the CREATE TABLE column
-- definitions below (their own DEFAULTs), never referenced in a data statement in
-- this transaction, so the Postgres "unsafe use of new enum value" rule never
-- applies.

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "ApRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'quarantined');

-- CreateEnum
CREATE TYPE "ApAttachmentKind" AS ENUM ('file', 'nested_message', 'reference_link');

-- CreateEnum
CREATE TYPE "ApPollRunStatus" AS ENUM ('ok', 'auth_failed', 'error');

-- CreateEnum
CREATE TYPE "ApSenderMode" AS ENUM ('tenant_wide', 'explicit_list');

-- CreateEnum
CREATE TYPE "ApTransportMode" AS ENUM ('mock', 'graph');

-- ─────────────────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────────────────
-- CreateTable
CREATE TABLE "ap_requests" (
    "id" TEXT NOT NULL,
    "status" "ApRequestStatus" NOT NULL DEFAULT 'pending',
    "internet_message_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL,
    "sender_address" TEXT NOT NULL,
    "sender_validated" BOOLEAN NOT NULL,
    "subject" TEXT,
    "body_html_sanitized" TEXT,
    "body_text" TEXT,
    "vendor" TEXT,
    "amount_cents" INTEGER,
    "decided_by" TEXT,
    "decided_at" TIMESTAMP(3),
    "decision_note" TEXT,
    "decision_mail_sent_at" TIMESTAMP(3),
    "quarantine_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_attachments" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "kind" "ApAttachmentKind" NOT NULL,
    "filename" TEXT,
    "storage_key" TEXT,
    "content_type" TEXT,
    "link_url" TEXT,
    "nested_subject" TEXT,
    "byte_size" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ap_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_followups" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "internet_message_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "sender_address" TEXT NOT NULL,
    "body_text" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ap_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_sender_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "mode" "ApSenderMode" NOT NULL DEFAULT 'tenant_wide',
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_sender_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_sender_entries" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_sender_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_decision_recipients" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_decision_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_delta_tokens" (
    "id" TEXT NOT NULL,
    "mailbox" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "delta_token" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_delta_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ap_poll_runs" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "ApPollRunStatus" NOT NULL,
    "transport_mode" "ApTransportMode" NOT NULL,
    "mailbox" TEXT,
    "folder" TEXT,
    "messages_listed" INTEGER NOT NULL DEFAULT 0,
    "requests_created" INTEGER NOT NULL DEFAULT 0,
    "followups_created" INTEGER NOT NULL DEFAULT 0,
    "quarantined" INTEGER NOT NULL DEFAULT 0,
    "moved" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ap_poll_runs_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────
-- CreateIndex
CREATE UNIQUE INDEX "ap_requests_internet_message_id_key" ON "ap_requests"("internet_message_id");

-- CreateIndex
CREATE INDEX "ap_requests_status_received_at_idx" ON "ap_requests"("status", "received_at");

-- CreateIndex
CREATE INDEX "ap_requests_conversation_id_idx" ON "ap_requests"("conversation_id");

-- CreateIndex
CREATE INDEX "ap_attachments_request_id_idx" ON "ap_attachments"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ap_followups_internet_message_id_key" ON "ap_followups"("internet_message_id");

-- CreateIndex
CREATE INDEX "ap_followups_request_id_idx" ON "ap_followups"("request_id");

-- CreateIndex
CREATE UNIQUE INDEX "ap_sender_entries_address_key" ON "ap_sender_entries"("address");

-- CreateIndex
CREATE INDEX "ap_sender_entries_active_idx" ON "ap_sender_entries"("active");

-- CreateIndex
CREATE UNIQUE INDEX "ap_decision_recipients_email_key" ON "ap_decision_recipients"("email");

-- CreateIndex
CREATE INDEX "ap_decision_recipients_active_idx" ON "ap_decision_recipients"("active");

-- CreateIndex
CREATE UNIQUE INDEX "ap_delta_tokens_mailbox_folder_key" ON "ap_delta_tokens"("mailbox", "folder");

-- CreateIndex
CREATE INDEX "ap_poll_runs_status_started_at_idx" ON "ap_poll_runs"("status", "started_at");

-- ─────────────────────────────────────────────────────────────────────────
-- Foreign keys
-- ─────────────────────────────────────────────────────────────────────────
-- AddForeignKey
ALTER TABLE "ap_attachments" ADD CONSTRAINT "ap_attachments_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ap_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ap_followups" ADD CONSTRAINT "ap_followups_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ap_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
