-- EMERGENCY ROLLBACK for 20260862_adr0135_equipment_identity (ADR-0135).
--
-- NOT run by `prisma migrate` — hand-applied only. Drops `equipment_distinct_pairs`
-- (the verdicts are also in audit_log), the two indexes and the
-- four identifier columns, and restores `site_id NOT NULL`.
--
-- PRECONDITION: no fleet-wide rows. Every `site_id IS NULL` row must first be
-- given a yard (`UPDATE equipment SET site_id = '<sites.id>' WHERE id = …`),
-- otherwise SET NOT NULL fails — deliberately; picking a yard is a decision, not
-- something a rollback should guess.
--
-- Apply with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f down.sql
-- then: DELETE FROM "_prisma_migrations" WHERE migration_name = '20260862_adr0135_equipment_identity';

BEGIN;
DROP TABLE IF EXISTS "equipment_distinct_pairs";
DROP INDEX IF EXISTS "equipment_live_vin_serial_key";
DROP INDEX IF EXISTS "equipment_live_name_ci_key";
DROP INDEX IF EXISTS "equipment_unit_number_idx";
ALTER TABLE "equipment" DROP COLUMN IF EXISTS "vin_serial";
ALTER TABLE "equipment" DROP COLUMN IF EXISTS "asset_type";
ALTER TABLE "equipment" DROP COLUMN IF EXISTS "make";
ALTER TABLE "equipment" DROP COLUMN IF EXISTS "unit_number";
ALTER TABLE "equipment" ALTER COLUMN "site_id" SET NOT NULL;
COMMIT;
