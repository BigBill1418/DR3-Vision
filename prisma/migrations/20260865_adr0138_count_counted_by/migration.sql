-- ADR-0138 (2026-09-24) — who COUNTED a physical count, distinct from who keyed it.
--
-- The daily report's "Counter" row read the insert audit actor: the account that
-- submitted the count. Eugene's only count was counted by Chris R, confirmed by
-- Patrick D and keyed by an admin, so the report named the admin. `counted_by` /
-- `confirmed_by` record the people on the floor as the entry form captured them
-- (free text). Nullable: rows before this migration, and entry paths that do not
-- ask, stay NULL and the report labels the audit actor "entered by" instead.
-- The same pair on `inventory_count_holds` carries them through a Tier-2 hold.
--
-- CLEAN-REPLAY SAFE (ADR-0035): every statement is guarded.
-- ROLLBACK: ALTER TABLE "site_inventory_snapshots" DROP COLUMN IF EXISTS "counted_by";
--           ALTER TABLE "site_inventory_snapshots" DROP COLUMN IF EXISTS "confirmed_by";
--           ALTER TABLE "inventory_count_holds" DROP COLUMN IF EXISTS "counted_by";
--           ALTER TABLE "inventory_count_holds" DROP COLUMN IF EXISTS "confirmed_by";

ALTER TABLE "site_inventory_snapshots" ADD COLUMN IF NOT EXISTS "counted_by" TEXT;
ALTER TABLE "site_inventory_snapshots" ADD COLUMN IF NOT EXISTS "confirmed_by" TEXT;
ALTER TABLE "inventory_count_holds" ADD COLUMN IF NOT EXISTS "counted_by" TEXT;
ALTER TABLE "inventory_count_holds" ADD COLUMN IF NOT EXISTS "confirmed_by" TEXT;
