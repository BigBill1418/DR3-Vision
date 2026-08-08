-- ADR-0085 — iPad walk-up drop-off: photo storage, the money/PII lockout, and
-- the born-pilot rollout surface.
--
-- Runs AFTER 20260838_adr0085_dropoff_floor_kinds so the labels it names already
-- exist and are committed. See that file's header for why they are separate.
--
-- ## What the three CHECK constraints are for
--
-- The application already guarantees all of this — `createFloorDropoff` takes no
-- money or name argument at all, so it cannot pass one. These constraints exist
-- because "the current caller cannot do it" is a property of today's code, and a
-- table that has held CIP PII and check amounts for a year will be written by
-- code nobody has authored yet. A constraint is the guarantee that survives the
-- next author.
--
-- 1. `floor_no_money_or_pii` — a floor row's money and identity columns are all
--    NULL. Bill, 2026-08-07: no money, no PII, not even the $3 Incentive payout,
--    which is tracked elsewhere. This is the constraint that makes the flow
--    STRUCTURALLY incapable of the thing, not merely disinclined.
-- 2. `floor_requires_photo` — "no drop-off without a photo" as a storage fact.
--    The client blocks submit, the zod schema requires the key, and this refuses
--    the row. Strip either of the first two and the write still fails.
-- 3. `non_floor_requires_person` — the OTHER direction. Relaxing person_name to
--    NULL is a loosening of a year-old invariant, and a loosening that is not
--    scoped is just a hole. Manager-entered incentive/unpaid/illegal rows still
--    require a name exactly as they did when the column was NOT NULL; only the
--    two floor kinds are exempt.

-- ── person_name: NOT NULL → nullable, scoped by constraint (3) above ─────────
ALTER TABLE "consumer_dropoffs" ALTER COLUMN "person_name" DROP NOT NULL;

-- ── the drop-off photo, mirroring load_photos including uploaded_by ──────────
-- Columns rather than a side table: the photo is REQUIRED and there is exactly
-- one, so a 1:1 table would add a join and a nullable FK to model a relationship
-- that has neither cardinality. Columns are also what makes constraint (2)
-- expressible at all — a NOT EXISTS against a side table is not a CHECK.
ALTER TABLE "consumer_dropoffs" ADD COLUMN "photo_storage_key"  TEXT;
ALTER TABLE "consumer_dropoffs" ADD COLUMN "photo_content_type" TEXT;
ALTER TABLE "consumer_dropoffs" ADD COLUMN "photo_byte_size"    INTEGER;
-- The operator whose SESSION submitted the drop-off. ADR-0078 Am.1's lesson:
-- load_photos enforced who may upload and then kept no record of who did, so
-- all 85 pre-flip rows carry uploaded_by IS NULL and there is no honest way to
-- backfill them. This column starts truthful on row one.
ALTER TABLE "consumer_dropoffs" ADD COLUMN "photo_uploaded_by"  TEXT;
ALTER TABLE "consumer_dropoffs" ADD COLUMN "photo_captured_at"  TIMESTAMP(3);

ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_floor_no_money_or_pii" CHECK (
    "kind"::text NOT IN ('floor_public', 'floor_incentive')
    OR (
      "incentive_cents"        IS NULL
      AND "incentive_amount_cents" IS NULL
      AND "person_name"        IS NULL
      AND "consumer_name"      IS NULL
      AND "check_number"       IS NULL
      AND "paid_at"            IS NULL
    )
  );

ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_floor_requires_photo" CHECK (
    "kind"::text NOT IN ('floor_public', 'floor_incentive')
    OR "photo_storage_key" IS NOT NULL
  );

ALTER TABLE "consumer_dropoffs"
  ADD CONSTRAINT "consumer_dropoffs_non_floor_requires_person" CHECK (
    "kind"::text IN ('floor_public', 'floor_incentive')
    OR "person_name" IS NOT NULL
  );

-- ── ADR-0047 rollout surface, born PILOT ────────────────────────────────────
-- Shape copied verbatim from 20260829_adr0077_terex_ledger_surface: a text id
-- (a uuid-typed one passes CI, which does not run migrations, and fails only on
-- deploy), and ON CONFLICT DO NOTHING so a replay never reverts a flip an admin
-- has already made. On a fresh CI replay `sites` is empty at this point (seeded
-- later by prisma/seed.mjs), so the SELECT yields zero rows — additive and safe.
-- Both sites are registered even though only the pilot one will be flipped:
-- seeding one would make the other's state a swallowed exception rather than a
-- stated decision.
INSERT INTO "rollout_surfaces" ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  'ui'::"RolloutSurfaceKind",
  v.surface_code,
  s."id",
  v.rollout_state::"RolloutState",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "sites" s
CROSS JOIN (VALUES
  ('ipad_dropoff', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
