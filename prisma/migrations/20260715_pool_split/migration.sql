-- ADR-0037 §3 amendment (D6 pool split, planning rollup 2026-07-08 §1.4).
-- Physical inventory counts record the program and non-program pools separately
-- (MRC is billed on program units only).

ALTER TABLE "site_inventory_snapshots" ADD COLUMN "program_units" DECIMAL(7,1);
ALTER TABLE "site_inventory_snapshots" ADD COLUMN "non_program_units" DECIMAL(7,1);
ALTER TABLE "site_inventory_snapshots" ADD COLUMN "pool_attribution" TEXT NOT NULL DEFAULT 'measured';

-- Backfill existing rows (§1.4): attribute ALL counts to the program pool and flag
-- them 'legacy'. Clean measured data starts once counters enter both fields. On an
-- empty database (clean-replay) this UPDATE matches zero rows and is a no-op.
UPDATE "site_inventory_snapshots" SET
  "pool_attribution" = 'legacy',
  "program_units" = COALESCE("units_indoor", 0) + COALESCE("units_outdoor", 0) + COALESCE("units_total", 0) + "units_in_processing",
  "non_program_units" = 0;
