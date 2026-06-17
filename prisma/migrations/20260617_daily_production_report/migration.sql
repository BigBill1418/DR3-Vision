-- ADR-0030 — Daily production report: per-site config, recipients, send log,
-- and super-admin flag for the admin tile.

-- ─────────────────────────────────────────────────────────────────────
-- Super-admin flag on users
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────
-- Per-site config
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_config" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id"               UUID NOT NULL,
  "enabled"               BOOLEAN NOT NULL DEFAULT false,
  -- Pacific wall-clock time, HH:MM. Stored as TIME for SQL ergonomics.
  "send_time_pt"          TIME NOT NULL DEFAULT '18:00:00',
  "subject_template"      TEXT NOT NULL DEFAULT 'DR3 Daily Production Report — {site} — {date}',
  "skip_if_zero"          BOOLEAN NOT NULL DEFAULT true,
  "skip_weekends"         BOOLEAN NOT NULL DEFAULT false,
  "skip_holidays"         BOOLEAN NOT NULL DEFAULT false,
  "include_bonus_dollars" BOOLEAN NOT NULL DEFAULT true,
  "include_comparisons"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bonus_daily_report_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bonus_daily_report_config_site_uq" UNIQUE ("site_id"),
  CONSTRAINT "bonus_daily_report_config_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────
-- Per-config recipients (child table, one row per email address)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_recipients" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "config_id"        UUID NOT NULL,
  "email"            TEXT NOT NULL,
  "added_by_user_id" UUID,
  "added_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bonus_daily_report_recipients_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_daily_report_recipients_config_fk"
    FOREIGN KEY ("config_id") REFERENCES "bonus_daily_report_config"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "bonus_daily_report_recipients_user_fk"
    FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  -- One address per config; uniqueness enforced lowercase via the app layer.
  CONSTRAINT "bonus_daily_report_recipients_config_email_uq"
    UNIQUE ("config_id", "email")
);

CREATE INDEX "bonus_daily_report_recipients_config_idx"
  ON "bonus_daily_report_recipients"("config_id");

-- ─────────────────────────────────────────────────────────────────────
-- Idempotency + delivery log
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_log" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id"          UUID NOT NULL,
  "report_date"      DATE NOT NULL,
  "sent_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recipient_count"  INTEGER NOT NULL,
  "total_today"      INTEGER NOT NULL,
  "total_bonus_cents" INTEGER NOT NULL,
  "mtd_total"        INTEGER NOT NULL,
  "delivered_count"  INTEGER NOT NULL,
  "graph_message_id" TEXT,
  "last_status"      INTEGER,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bonus_daily_report_log_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_daily_report_log_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_daily_report_log_site_date_uq"
    UNIQUE ("site_id", "report_date")
);

CREATE INDEX "bonus_daily_report_log_sent_at_idx"
  ON "bonus_daily_report_log"("sent_at" DESC);
