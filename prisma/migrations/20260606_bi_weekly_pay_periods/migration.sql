-- ADR-0019.1 + ADR-0019.2: Bi-weekly pay-period cadence + Eugene enablement
--
-- Pre-data safe: zero production bonus rows exist as of 2026-06-06
-- (M365 mail-send still dark per T-122, no PDFs ever shipped).
--
-- Strategy: rename table + columns in-place via ALTER, then add new columns,
-- then add new constraints/indices. Renaming preserves table OIDs and FK
-- relationships. Prisma's migrate engine produces equivalent DDL via the
-- schema diff; this file is the explicit, reviewable form.

BEGIN;

-- ─── 1. Rename the enum ──────────────────────────────────────────────
-- The 'skipped' value is new (for the Period 12 bootstrap path per
-- ADR-0019.1 "Bootstrapping question").
ALTER TYPE "BonusMonthState" RENAME TO "BonusPayPeriodState";
ALTER TYPE "BonusPayPeriodState" ADD VALUE IF NOT EXISTS 'skipped';

-- ─── 2. Rename the bonus_months table to bonus_pay_periods ──────────
ALTER TABLE "bonus_months" RENAME TO "bonus_pay_periods";

-- Rename indices that embed the old table name. Postgres auto-names
-- some, but Prisma's defaults are predictable.
ALTER INDEX IF EXISTS "bonus_months_pkey" RENAME TO "bonus_pay_periods_pkey";
ALTER INDEX IF EXISTS "bonus_months_site_id_month_start_key" RENAME TO "bonus_pay_periods_site_id_period_start_key";
ALTER INDEX IF EXISTS "bonus_months_site_id_state_idx" RENAME TO "bonus_pay_periods_site_id_state_idx";
ALTER INDEX IF EXISTS "bonus_months_amended_from_month_id_key" RENAME TO "bonus_pay_periods_amended_from_period_id_key";

-- ─── 3. Rename columns (boundaries) ──────────────────────────────────
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "month_start" TO "period_start";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "month_end"   TO "period_end";

-- ─── 4. Rename signature columns (janette → facility, morena → ops) ──
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_signed_by_user_id" TO "facility_signed_by_user_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_signed_at"         TO "facility_signed_at";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_signed_ip"         TO "facility_signed_ip";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_signed_user_agent" TO "facility_signed_user_agent";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_override_actor_id" TO "facility_override_actor_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "janette_override_reason"   TO "facility_override_reason";

ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_signed_by_user_id"  TO "ops_signed_by_user_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_signed_at"          TO "ops_signed_at";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_signed_ip"          TO "ops_signed_ip";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_signed_user_agent"  TO "ops_signed_user_agent";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_override_actor_id"  TO "ops_override_actor_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "morena_override_reason"    TO "ops_override_reason";

-- ─── 5. Rename amendment FK column ───────────────────────────────────
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "amended_from_month_id" TO "amended_from_period_id";

-- ─── 6. Add new columns ──────────────────────────────────────────────
-- Period identity. NULL-allowed for the in-place rename pass; seeded
-- and made NOT NULL by the application-level seed step in T-201.
ALTER TABLE "bonus_pay_periods" ADD COLUMN "period_number" INT;
ALTER TABLE "bonus_pay_periods" ADD COLUMN "period_year"   INT;
ALTER TABLE "bonus_pay_periods" ADD COLUMN "pay_date"      DATE;

-- Auto-override timestamps (ADR-0019.1 §4). NULL = human signed;
-- non-NULL = system auto-signed at Tue 08:30 PT.
ALTER TABLE "bonus_pay_periods" ADD COLUMN "facility_auto_override_at" TIMESTAMP(3);
ALTER TABLE "bonus_pay_periods" ADD COLUMN "ops_auto_override_at"      TIMESTAMP(3);

-- ─── 7. Add new unique constraint on canonical period identity ───────
-- Deferred until period_number / period_year are populated by the
-- T-201 seed pass (the seed CSV in prisma/seed/bonus_pay_periods_2026.csv).
-- The application-level seed step issues this DDL after backfilling.
-- For a fresh DB this constraint is created inline:
--
--   CREATE UNIQUE INDEX "bonus_pay_periods_site_id_period_year_period_number_key"
--   ON "bonus_pay_periods"("site_id", "period_year", "period_number");
--
-- (commented out here; T-201 issues it post-seed)

-- ─── 8. Add pay_date index for upcoming-deadline queries ─────────────
CREATE INDEX "bonus_pay_periods_pay_date_idx" ON "bonus_pay_periods"("pay_date");

-- ─── 9. Rename FK column on bonus_daily_entries ──────────────────────
ALTER TABLE "bonus_daily_entries" RENAME COLUMN "bonus_month_id" TO "bonus_pay_period_id";
ALTER INDEX IF EXISTS "bonus_daily_entries_bonus_month_id_idx" RENAME TO "bonus_daily_entries_bonus_pay_period_id_idx";

-- Rename the FK constraint itself if it was auto-named with the old column.
-- Postgres FK constraint names from Prisma follow the pattern:
--   <table>_<column>_fkey
-- So we have a constraint named bonus_daily_entries_bonus_month_id_fkey
-- that should be bonus_daily_entries_bonus_pay_period_id_fkey.
ALTER TABLE "bonus_daily_entries"
  RENAME CONSTRAINT "bonus_daily_entries_bonus_month_id_fkey"
  TO "bonus_daily_entries_bonus_pay_period_id_fkey";

-- ─── 10. Create bonus_signature_chains (new table per ADR-0019.2) ────
CREATE TABLE "bonus_signature_chains" (
  "id"                            TEXT NOT NULL,
  "site_id"                       TEXT NOT NULL,
  "facility_signer_user_id"       TEXT NOT NULL,
  "facility_override_actor_ids"   TEXT NOT NULL,
  "ops_signer_user_id"            TEXT NOT NULL,
  "ops_override_actor_ids"        TEXT NOT NULL,
  "auto_override_actor_user_id"   TEXT NOT NULL,
  "created_at"                    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                    TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bonus_signature_chains_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bonus_signature_chains_site_id_key" UNIQUE ("site_id"),
  CONSTRAINT "bonus_signature_chains_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bonus_signature_chains_facility_signer_user_id_fkey"
    FOREIGN KEY ("facility_signer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bonus_signature_chains_ops_signer_user_id_fkey"
    FOREIGN KEY ("ops_signer_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "bonus_signature_chains_auto_override_actor_user_id_fkey"
    FOREIGN KEY ("auto_override_actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

COMMIT;

-- ─── Post-migration application step (T-201) ─────────────────────────
-- After this migration applies, the application-level seed pass in
-- T-201 runs:
--   1. UPSERT 26 rows × 2 sites into bonus_pay_periods from
--      prisma/seed/bonus_pay_periods_2026.csv (sets period_number,
--      period_year, period_start, period_end, pay_date)
--   2. UPSERT 2 rows into bonus_signature_chains from
--      prisma/seed/bonus_signature_chains.csv
--   3. ALTER COLUMN period_number SET NOT NULL
--      ALTER COLUMN period_year   SET NOT NULL
--      ALTER COLUMN pay_date      SET NOT NULL
--   4. CREATE UNIQUE INDEX bonus_pay_periods_site_id_period_year_period_number_key
--
-- These post-seed steps live in the application seed runner because
-- they depend on data that's seeded, not just schema. Prisma migrate's
-- own seed hook (prisma/seed.mjs) is the runner.
