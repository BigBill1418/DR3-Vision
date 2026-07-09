-- 2026-07-08 planning rollup — build-now subset (schema for ADR-0046 §3 AP
-- expansion, ADR-0045 §3 board-pack digest recipients, and the trailer/yard list).
-- Bare FK columns carry DB-level constraints created here (repo convention,
-- mirrors ADR-0040/0041/0045) so the shared Site/User relation lists stay untouched.

-- ── ADR-0046 §3 (handoff §1.6a/b) — explicit AP approver roster ──────────────
CREATE TABLE "ap_approvers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "active_until" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ap_approvers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ap_approvers_user_id_key" ON "ap_approvers"("user_id");
ALTER TABLE "ap_approvers"
    ADD CONSTRAINT "ap_approvers_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── ADR-0046 §3 (handoff §1.6c/e) — optional site tag + decision-PDF hash ────
ALTER TABLE "ap_requests" ADD COLUMN "site_id" TEXT;
ALTER TABLE "ap_requests" ADD COLUMN "decision_pdf_sha256" TEXT;
ALTER TABLE "ap_requests"
    ADD CONSTRAINT "ap_requests_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ap_requests_site_id_idx" ON "ap_requests"("site_id") WHERE "site_id" IS NOT NULL;

-- ── ADR-0045 §3 (handoff §1.8) — board-pack digest recipient roster ──────────
CREATE TABLE "board_pack_recipients" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "board_pack_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_pack_recipients_email_key" ON "board_pack_recipients"("email");
CREATE INDEX "board_pack_recipients_active_idx" ON "board_pack_recipients"("active");

-- ADR-0045 §3 (handoff §1.8) — board-pack digest send idempotency ledger.
CREATE TABLE "board_pack_send_log" (
    "id" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipients_count" INTEGER NOT NULL DEFAULT 0,
    "mode" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_pack_send_log_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "board_pack_send_log_period_start_key" ON "board_pack_send_log"("period_start");

-- ── handoff §1.8 — trailer/yard positions (Yard view scaffold) ───────────────
CREATE TYPE "YardTrailerStatus" AS ENUM ('on_yard', 'at_account', 'in_service');
CREATE TABLE "yard_trailers" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "location_note" TEXT,
    "status" "YardTrailerStatus" NOT NULL DEFAULT 'on_yard',
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "yard_trailers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "yard_trailers_site_id_idx" ON "yard_trailers"("site_id");
ALTER TABLE "yard_trailers"
    ADD CONSTRAINT "yard_trailers_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
