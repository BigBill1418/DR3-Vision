-- ADR-0037 addendum (2026-07-22) — remove outdoor storage from Vision entirely.
--
-- Directive (Bill, 2026-07-22): "we will also remove the units outdoor we are
-- never allowed to store units outside. this can't be in the system."
--
-- DR3 never stores units outside. The concept is removed from the schema so it
-- cannot be entered, displayed, summed, or warned on.
--
-- Pre-migration audit on PROD (2026-07-22) returned 0 rows with a non-zero
-- units_outdoor (1 snapshot row total, units_outdoor NULL), so no fold was
-- required there. The fold below is retained so the migration is correct on any
-- database that DOES carry non-zero outdoor counts (it is a no-op otherwise):
-- outdoor units are folded into indoor so no unit is silently destroyed, and an
-- append-only audit row is written per folded snapshot.

-- 1. Fold any non-zero outdoor count into indoor (units are never dropped).
INSERT INTO "audit_log" ("id", "actor_label", "action", "table_name", "row_id", "before", "after", "created_at")
SELECT
  gen_random_uuid()::text,
  'adr-0037-outdoor-removal',
  'update'::"AuditAction",
  'site_inventory_snapshots',
  s."id",
  jsonb_build_object('units_indoor', s."units_indoor", 'units_outdoor', s."units_outdoor"),
  jsonb_build_object('units_indoor', COALESCE(s."units_indoor", 0) + s."units_outdoor", 'units_outdoor', 0),
  NOW()
FROM "site_inventory_snapshots" s
WHERE s."units_outdoor" IS NOT NULL AND s."units_outdoor" > 0;

UPDATE "site_inventory_snapshots"
SET "units_indoor" = COALESCE("units_indoor", 0) + "units_outdoor",
    "units_outdoor" = 0
WHERE "units_outdoor" IS NOT NULL AND "units_outdoor" > 0;

-- 2. Drop the outdoor column. `total` is derived (indoor + units_total +
--    in_processing) in src/lib/inventory/running-balance.ts — there is no stored
--    total column on this table, so no stored-total fix-up is required.
ALTER TABLE "site_inventory_snapshots" DROP COLUMN "units_outdoor";

-- 3. Drop the outdoor storage cap. The CA 5,000-unit outdoor allowance in the
--    MRC contract is not exercised; the compliance storage metric now grades
--    against the indoor cap (CA) / total on-site cap (OR) only.
ALTER TABLE "sites" DROP COLUMN "max_units_outdoor";
