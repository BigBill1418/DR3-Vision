-- ADR-0030 — Daily production report: per-site config, recipients, send log,
-- and super-admin flag for the admin tile.
--
-- Convention: ids and FK columns are TEXT (Prisma `String @id @default(uuid())`
-- generates the id app-side — there is NO DB-side gen_random_uuid() default in
-- this schema). FK columns must be TEXT to match sites.id / users.id, which are
-- TEXT, not UUID. Constraint/index names follow Prisma's generated form so a
-- future `prisma migrate dev` sees no drift.

-- ─────────────────────────────────────────────────────────────────────
-- Super-admin flag on users
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────
-- Per-site config
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_config" (
    "id"                    TEXT NOT NULL,
    "site_id"               TEXT NOT NULL,
    "enabled"               BOOLEAN NOT NULL DEFAULT false,
    -- Pacific wall-clock time, HH:MM:SS. DST handled by the daemon/runner.
    "send_time_pt"          TIME NOT NULL DEFAULT '18:00:00',
    "subject_template"      TEXT NOT NULL DEFAULT 'DR3 Daily Production Report — {site} — {date}',
    "skip_if_zero"          BOOLEAN NOT NULL DEFAULT true,
    "skip_weekends"         BOOLEAN NOT NULL DEFAULT false,
    "skip_holidays"         BOOLEAN NOT NULL DEFAULT false,
    "include_bonus_dollars" BOOLEAN NOT NULL DEFAULT true,
    "include_comparisons"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bonus_daily_report_config_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────
-- Per-config recipients (child table, one row per email address)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_recipients" (
    "id"               TEXT NOT NULL,
    "config_id"        TEXT NOT NULL,
    "email"            TEXT NOT NULL,
    "added_by_user_id" TEXT,
    "added_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_daily_report_recipients_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────
-- Idempotency + delivery log
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_log" (
    "id"                TEXT NOT NULL,
    "site_id"           TEXT NOT NULL,
    "report_date"       DATE NOT NULL,
    "sent_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recipient_count"   INTEGER NOT NULL,
    "total_today"       INTEGER NOT NULL,
    "total_bonus_cents" INTEGER NOT NULL,
    "mtd_total"         INTEGER NOT NULL,
    "delivered_count"   INTEGER NOT NULL,
    "graph_message_id"  TEXT,
    "last_status"       INTEGER,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_daily_report_log_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "bonus_daily_report_config_site_id_key"
  ON "bonus_daily_report_config"("site_id");

CREATE INDEX "bonus_daily_report_recipients_config_id_idx"
  ON "bonus_daily_report_recipients"("config_id");

CREATE UNIQUE INDEX "bonus_daily_report_recipients_config_id_email_key"
  ON "bonus_daily_report_recipients"("config_id", "email");

CREATE UNIQUE INDEX "bonus_daily_report_log_site_id_report_date_key"
  ON "bonus_daily_report_log"("site_id", "report_date");

CREATE INDEX "bonus_daily_report_log_sent_at_idx"
  ON "bonus_daily_report_log"("sent_at" DESC);

-- ─────────────────────────────────────────────────────────────────────
-- Foreign keys
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "bonus_daily_report_config"
  ADD CONSTRAINT "bonus_daily_report_config_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bonus_daily_report_recipients"
  ADD CONSTRAINT "bonus_daily_report_recipients_config_id_fkey"
  FOREIGN KEY ("config_id") REFERENCES "bonus_daily_report_config"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bonus_daily_report_recipients"
  ADD CONSTRAINT "bonus_daily_report_recipients_added_by_user_id_fkey"
  FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "bonus_daily_report_log"
  ADD CONSTRAINT "bonus_daily_report_log_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
