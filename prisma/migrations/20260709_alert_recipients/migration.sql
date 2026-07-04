-- ADR-0043 (P3) — rate alerts + missing-record detection.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds four `AuditCheckCode` enum values (R1/R2/M1/M2 register on the same
-- audit engine as C1–C7) and two config/ledger tables:
--   - `alert_recipients` — the daily-digest recipient roster (D3), admin-editable.
--   - `alert_digest_logs` — the (site, digest_date) idempotency ledger (D3/D5),
--     mirroring `bonus_daily_report_log` so a same-day re-fire is a no-op.
--
-- The new enum values are NOT referenced anywhere in this migration (no config
-- rows are inserted here — the seed defaults live in code, `audit/config.ts`,
-- and any DB override is written at runtime), so the Postgres rule against using
-- a freshly-added enum value in the same transaction never applies. Neither new
-- table has an enum column.
--
-- The dir name `20260709_alert_recipients` sorts AFTER the current main chain tip
-- (`20260708_cor_certificates`) — preserving ADR-0035 lexical migration ordering.
-- FK columns carry a proper Prisma relation (back-relations on `Site`), so the
-- constraints below match Prisma's generated `*_site_id_fkey` form.

-- ─────────────────────────────────────────────────────────────────────────
-- Enum extension — R1/R2/M1/M2 check codes
-- ─────────────────────────────────────────────────────────────────────────
ALTER TYPE "AuditCheckCode" ADD VALUE 'r1_recycling_rate';
ALTER TYPE "AuditCheckCode" ADD VALUE 'r2_recovery_rate';
ALTER TYPE "AuditCheckCode" ADD VALUE 'm1_missing_close';
ALTER TYPE "AuditCheckCode" ADD VALUE 'm2_missing_snapshot';

-- ─────────────────────────────────────────────────────────────────────────
-- alert_recipients — digest recipient roster (D3)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "alert_recipients" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_recipients_site_id_email_key" ON "alert_recipients"("site_id", "email");
CREATE INDEX "alert_recipients_site_id_active_idx" ON "alert_recipients"("site_id", "active");

ALTER TABLE "alert_recipients"
    ADD CONSTRAINT "alert_recipients_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- alert_digest_logs — (site, digest_date) idempotency ledger (D3/D5)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "alert_digest_logs" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "digest_date" DATE NOT NULL,
    "finding_count" INTEGER NOT NULL,
    "recipient_count" INTEGER NOT NULL,
    "delivered_count" INTEGER NOT NULL,
    "graph_message_id" TEXT,
    "last_status" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_digest_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_digest_logs_site_id_digest_date_key" ON "alert_digest_logs"("site_id", "digest_date");
CREATE INDEX "alert_digest_logs_site_id_digest_date_idx" ON "alert_digest_logs"("site_id", "digest_date");

ALTER TABLE "alert_digest_logs"
    ADD CONSTRAINT "alert_digest_logs_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
