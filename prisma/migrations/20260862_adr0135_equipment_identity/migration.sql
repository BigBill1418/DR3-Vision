-- ADR-0135 — pick the asset, don't type it: real identifier columns, fleet-wide
-- assets, and a database backstop against case/whitespace-only duplicates.
--
-- CLEAN-REPLAY SAFE (ADR-0035): every statement is guarded, replays green on an
-- empty PG16 and again on a database that already has it. TEXT columns per the
-- house rule. The dir name sorts after the chain tip
-- (`20260861_adr0130_discovery_probe_failed`).
--
-- ── 1. Fleet-wide assets (Bill, 2026-09-23: "trailers move between yards") ──
-- `site_id IS NULL` now means "this asset has no home yard — it belongs to the
-- fleet". 281577 / 282876 / 284460 were each seeded at one yard and re-created at
-- the other because the registry had no way to say that. Every site-scoped
-- consumer (`WHERE site_id = $1` — the Terex ledger, throughput, the equipment
-- dashboard) keeps its meaning: a fleet-wide trailer is simply not one of a
-- site's MACHINES. The FK to `sites` stays; NULL satisfies it.
ALTER TABLE "equipment" ALTER COLUMN "site_id" DROP NOT NULL;

-- ── 2. Identity in real columns (ADR-0135 D) ─────────────────────────────────
-- Before this, identity lived in the free-text name (`1DW1A5321PS807745`,
-- `SN 31587 Forklift`, `Trailer Number #7677`). All NULLABLE: existing rows are
-- legacy names; new rows from the structured form fill them, and the name is
-- GENERATED from them as `<unit> — <make> <type>` (the seed convention).
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "unit_number" TEXT;
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "make"        TEXT;
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "asset_type"  TEXT;
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "vin_serial"  TEXT;

CREATE INDEX IF NOT EXISTS "equipment_unit_number_idx" ON "equipment" ("unit_number");

-- Backfill the unit number the seed already wrote into the NAME, for seed-format
-- rows only (`<unit> — <rest>`, where the unit carries a digit). Deterministic:
-- the part before the spaced em dash. Free-text names are left NULL — guessing a
-- unit out of `Fix and repair trailer: 53489, 5340, 35, …` is exactly the error
-- this ADR exists to stop.
UPDATE "equipment"
   SET "unit_number" = substring("display_name" from '^([A-Za-z0-9#-]*[0-9][A-Za-z0-9#-]*) — ')
 WHERE "unit_number" IS NULL
   AND "display_name" ~ '^[A-Za-z0-9#-]*[0-9][A-Za-z0-9#-]* — ';

-- ── 3. The case/whitespace backstop (ADR-0135 G) ─────────────────────────────
-- One live name per spelling, FLEET-WIDE, ignoring case and whitespace runs.
-- `terex` next to `Terex` (2026-08-20) is now refused by the database even if
-- every application check were bypassed. Merged-away losers are excluded — they
-- keep their old names by design (ADR-0075) and are not live assets. Inactive
-- rows are INCLUDED, matching the ADR-0063 index: a returning asset is
-- reactivated, not re-created.
--
-- ADR-0075 D3 refused this index because production held a violating pair; the
-- ADR-0135 §5 cleanup cleared the last one. Verified against production
-- 2026-09-23 immediately before writing this: ZERO violating groups, fleet-wide.
-- The pre-check below makes a violation fail with a readable message instead of
-- a bare unique-violation — this runs in the deploy's init container.
DO $$
DECLARE
  offenders TEXT;
BEGIN
  SELECT string_agg(k, ' | ') INTO offenders FROM (
    SELECT lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g')) AS k
      FROM "equipment"
     WHERE "merged_into_id" IS NULL
     GROUP BY 1
    HAVING count(*) > 1
  ) d;
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-0135: equipment has live names differing only by case/whitespace: %. Merge them (/admin/equipment) before this migration can apply.', offenders;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "equipment_live_name_ci_key"
  ON "equipment" ((lower(regexp_replace(btrim("display_name"), '\s+', ' ', 'g'))))
  WHERE "merged_into_id" IS NULL;

-- A VIN / serial identifies exactly one live asset.
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_live_vin_serial_key"
  ON "equipment" ((upper(regexp_replace("vin_serial", '[^A-Za-z0-9]', '', 'g'))))
  WHERE "merged_into_id" IS NULL AND "vin_serial" IS NOT NULL;

-- ── 4. "These two look alike but are different assets" (ADR-0135 F) ──────────
-- The duplicates queue proposes pairs the matcher flags; a human disposes. When
-- the verdict is "different" (unit 3 at Eugene is both a Fruehauf and a Wabash),
-- it is recorded here so the pair stops being proposed. The create gate's
-- override writes here too: the person who said "this really is a different
-- asset" has made exactly this judgement about every row the gate showed them.
--
-- Ordered pair (a < b) + unique, so one verdict per pair regardless of which side
-- was clicked. Bare-FK convention with the constraints in DDL. NOT repointed by a
-- merge, deliberately: a verdict is about the two rows a person compared; once
-- one of them is merged away it is not a live asset and the queue ignores it,
-- and whether the SURVIVOR is distinct from the other row is a new question.
CREATE TABLE IF NOT EXISTS "equipment_distinct_pairs" (
  "id"             TEXT         NOT NULL,
  "equipment_a_id" TEXT         NOT NULL,
  "equipment_b_id" TEXT         NOT NULL,
  "reason"         TEXT         NOT NULL,
  "decided_by"     TEXT,
  "decided_label"  TEXT,
  "decided_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "equipment_distinct_pairs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "equipment_distinct_pairs_ordered" CHECK ("equipment_a_id" < "equipment_b_id"),
  CONSTRAINT "equipment_distinct_pairs_reason_nonempty" CHECK (length(btrim("reason")) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_distinct_pairs_equipment_a_id_equipment_b_id_key"
  ON "equipment_distinct_pairs" ("equipment_a_id", "equipment_b_id");
CREATE INDEX IF NOT EXISTS "equipment_distinct_pairs_equipment_b_id_idx"
  ON "equipment_distinct_pairs" ("equipment_b_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_distinct_pairs_a_fkey') THEN
    ALTER TABLE "equipment_distinct_pairs" ADD CONSTRAINT "equipment_distinct_pairs_a_fkey"
      FOREIGN KEY ("equipment_a_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'equipment_distinct_pairs_b_fkey') THEN
    ALTER TABLE "equipment_distinct_pairs" ADD CONSTRAINT "equipment_distinct_pairs_b_fkey"
      FOREIGN KEY ("equipment_b_id") REFERENCES "equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
