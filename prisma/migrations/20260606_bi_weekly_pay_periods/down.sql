-- EMERGENCY ROLLBACK for 20260606_bi_weekly_pay_periods (ADR-0019.1 + ADR-0019.2)
--
-- NOT run by `prisma migrate` — this is a hand-applied rollback script for
-- emergency use only. Reverses the renames and drops the new columns/tables
-- introduced by migration.sql. Safe ONLY because the migration is pre-data
-- (zero production bonus rows as of 2026-06-06 per T-122; M365 send dark).
--
-- CAVEAT: PostgreSQL cannot DROP a single value from an enum type. The
-- 'skipped' value added to BonusPayPeriodState therefore cannot be removed by
-- a simple ALTER. Reversing the enum rename leaves the (now-unused) 'skipped'
-- value in place under the restored name "BonusMonthState". This is harmless
-- (the old schema simply never references it). If a pristine enum is required,
-- recreate the type: CREATE TYPE ... ; ALTER COLUMN ... TYPE ... USING ...; DROP TYPE.
-- That full recreate is intentionally NOT done here to keep the rollback
-- low-risk; the stray value is inert.
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f down.sql

BEGIN;

-- ─── 10. Drop bonus_signature_chains ─────────────────────────────────
DROP TABLE IF EXISTS "bonus_signature_chains";

-- ─── 9. Revert FK column on bonus_daily_entries ──────────────────────
ALTER TABLE "bonus_daily_entries"
  RENAME CONSTRAINT "bonus_daily_entries_bonus_pay_period_id_fkey"
  TO "bonus_daily_entries_bonus_month_id_fkey";
ALTER INDEX IF EXISTS "bonus_daily_entries_bonus_pay_period_id_idx" RENAME TO "bonus_daily_entries_bonus_month_id_idx";
ALTER TABLE "bonus_daily_entries" RENAME COLUMN "bonus_pay_period_id" TO "bonus_month_id";

-- ─── 8. Drop pay_date index ──────────────────────────────────────────
DROP INDEX IF EXISTS "bonus_pay_periods_pay_date_idx";

-- ─── 7. Drop the canonical period-identity unique index ──────────────
-- (created post-seed by T-201; dropped here for completeness/idempotency)
DROP INDEX IF EXISTS "bonus_pay_periods_site_id_period_year_period_number_key";

-- ─── 6. Drop new columns ─────────────────────────────────────────────
ALTER TABLE "bonus_pay_periods" DROP COLUMN IF EXISTS "ops_auto_override_at";
ALTER TABLE "bonus_pay_periods" DROP COLUMN IF EXISTS "facility_auto_override_at";
ALTER TABLE "bonus_pay_periods" DROP COLUMN IF EXISTS "pay_date";
ALTER TABLE "bonus_pay_periods" DROP COLUMN IF EXISTS "period_year";
ALTER TABLE "bonus_pay_periods" DROP COLUMN IF EXISTS "period_number";

-- ─── 5. Revert amendment FK column ───────────────────────────────────
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "amended_from_period_id" TO "amended_from_month_id";

-- ─── 4. Revert signature columns (facility → janette, ops → morena) ──
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_override_reason"    TO "morena_override_reason";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_override_actor_id"  TO "morena_override_actor_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_signed_user_agent"  TO "morena_signed_user_agent";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_signed_ip"          TO "morena_signed_ip";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_signed_at"          TO "morena_signed_at";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "ops_signed_by_user_id"  TO "morena_signed_by_user_id";

ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_override_reason"   TO "janette_override_reason";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_override_actor_id" TO "janette_override_actor_id";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_signed_user_agent" TO "janette_signed_user_agent";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_signed_ip"         TO "janette_signed_ip";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_signed_at"         TO "janette_signed_at";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "facility_signed_by_user_id" TO "janette_signed_by_user_id";

-- ─── 3. Revert boundary columns ──────────────────────────────────────
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "period_end"   TO "month_end";
ALTER TABLE "bonus_pay_periods" RENAME COLUMN "period_start" TO "month_start";

-- ─── 2. Revert table + index names ───────────────────────────────────
ALTER INDEX IF EXISTS "bonus_pay_periods_amended_from_period_id_key" RENAME TO "bonus_months_amended_from_month_id_key";
ALTER INDEX IF EXISTS "bonus_pay_periods_site_id_state_idx" RENAME TO "bonus_months_site_id_state_idx";
ALTER INDEX IF EXISTS "bonus_pay_periods_site_id_period_start_key" RENAME TO "bonus_months_site_id_month_start_key";
ALTER INDEX IF EXISTS "bonus_pay_periods_pkey" RENAME TO "bonus_months_pkey";
ALTER TABLE "bonus_pay_periods" RENAME TO "bonus_months";

-- ─── 1. Revert enum name (the 'skipped' value remains inert — see header) ──
ALTER TYPE "BonusPayPeriodState" RENAME TO "BonusMonthState";

COMMIT;
