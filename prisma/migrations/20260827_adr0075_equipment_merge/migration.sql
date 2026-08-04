-- ADR-0075 — a name collision is a fork in the road, not a wall.
--
-- PURELY ADDITIVE. Three nullable columns, one index, one self-referencing FK.
-- No existing column changes type, no constraint tightens, no row is rewritten.
-- Every statement is guarded so a re-run is a no-op (ADR-0035 clean-replay +
-- idempotency invariant: this replays green on an empty PG16 in CI and again on
-- a database that already has it).
--
-- WHAT THIS IS FOR. On 2026-08-04 an approver hit "An asset with that name
-- already exists at this site." in the AP equipment-request resolve panel, and
-- worked around it by retyping the name in lower case. Production now holds
-- THREE rows for one Terex machine at Woodland — "Terex", "Terex Machine",
-- "Terex machine" — each cited by a different approved invoice. `merged_into_id`
-- is how those collapse onto one survivor WITHOUT deleting anything and WITHOUT
-- touching a cent of the approvals that cite them.
--
-- WHAT THIS DELIBERATELY IS NOT (ADR-0075 D3). There is no case-insensitive
-- unique index here and there must not be one. Production holds a violating pair
-- RIGHT NOW; migrations run in the deploy's init container; a `CREATE UNIQUE
-- INDEX` that cannot build would crash-loop the deploy rather than fail a review.
-- Case-folded near-duplicates are detected in the application and offered to the
-- operator as a choice. The existing `(site_id, display_name)` unique STANDS
-- unchanged — this migration does not weaken it either.
--
-- The dir name sorts AFTER the current chain tip
-- (`20260826_adr0074_ipad_hauls_surface`), preserving ADR-0035 lexical ordering.

-- ── 1. The columns ───────────────────────────────────────────────────────────
-- All three NULLABLE with no default: every existing row is, correctly, "not
-- merged". TEXT id per the house rule (a `uuid`-typed column here would pass CI —
-- which does not run migrations — and only fail on deploy). TIMESTAMP(3) matches
-- every other Prisma `DateTime` in this schema.
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "merged_into_id" TEXT;
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "merged_by"      TEXT;
ALTER TABLE "equipment" ADD COLUMN IF NOT EXISTS "merged_at"      TIMESTAMP(3);

-- ── 2. The index ─────────────────────────────────────────────────────────────
-- Every consumer that must hide merged rows filters `merged_into_id IS NULL`
-- (the admin list, the AP approver's picker, the similar-name lookup), and the
-- merge preview walks the other direction to count a survivor's absorbed rows.
CREATE INDEX IF NOT EXISTS "equipment_merged_into_id_idx"
  ON "equipment" ("merged_into_id");

-- ── 3. The self-referencing FK ───────────────────────────────────────────────
-- ON DELETE RESTRICT, matching `ap_equipment_links.equipment_id`: nothing in this
-- registry is ever hard-deleted, and a survivor must not become removable out
-- from under the losers pointing at it.
--
-- `ADD CONSTRAINT` has no IF NOT EXISTS in PG16, so the existence check is
-- explicit rather than swallowed by a bare exception handler — a DO block that
-- catches everything would also hide a genuine failure.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipment_merged_into_id_fkey'
  ) THEN
    ALTER TABLE "equipment"
      ADD CONSTRAINT "equipment_merged_into_id_fkey"
      FOREIGN KEY ("merged_into_id") REFERENCES "equipment"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
