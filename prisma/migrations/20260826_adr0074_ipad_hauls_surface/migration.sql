-- ADR-0074 — the iPad's open, searchable, newest-first portal-haul read surface.
--
-- TWO additive statements, no destructive DDL:
--
--   1. Register the `ipad_hauls` UI rollout surface, one row per site, BORN PILOT.
--   2. Add the covering index the list's ORDER BY needs.
--
-- ── 1. `ipad_hauls`, born pilot ──────────────────────────────────────────────
-- ADR-0047 decision #3: a NEW staff-visible surface is born `pilot` (admin-only,
-- with the operator seeing the already-translated "not turned on yet" block) and
-- is ramped only by Bill from /admin/rollout. This surface is genuinely new
-- exposure — 7,280 previously-invisible mirror rows reaching the floor iPad — so
-- unlike ADR-0065's retrofit-over-live-surfaces deviation, the default applies
-- unmodified here. There is nothing working today that seeding `pilot` takes away.
--
-- The consequence is deliberate and recorded in docs/OPEN-ITEMS.md O-6: until Bill
-- flips it, an operator who reaches /operator/<site>/hauls sees an honest
-- "not turned on yet" screen with its back and Log Out intact — never a 404 and
-- never a dead end.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Idempotent via ON CONFLICT on the (surface_code, site_id) unique, so a
-- replay or re-run NEVER reverts a flip an admin has made. On a fresh CI replay
-- the `sites` table is empty at this point (sites are seeded later by
-- prisma/seed.mjs), so the SELECT yields zero rows — additive and safe.
-- prisma/seed.mjs carries the same code with the same state for
-- first-deploy/dev parity (both paths are idempotent).
--
-- `id` is TEXT (gen_random_uuid()::text), matching `rollout_surfaces.id` and the
-- repo's hand-written-migration rule — a `uuid`-typed id here would pass CI (which
-- does not run migrations) and only fail on deploy.
--
-- The dir name sorts AFTER the current chain tip
-- (`20260825_adr0069_am2_terex_absorption`), preserving ADR-0035 lexical ordering.

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
  ('ipad_hauls', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;

-- ── 2. The list's covering index ─────────────────────────────────────────────
-- Every query this surface issues is
--   WHERE site_id = $1 ... ORDER BY docking_appointment_date DESC NULLS LAST
-- over a table that is 7,285 rows today and grows with every portal haul, forever.
-- `mymrc_hauls_mirror_site_id_idx` alone leaves the sort unindexed; this composite
-- serves both halves. Additive and idempotent (`IF NOT EXISTS`), no lock beyond the
-- brief build on a small table, and it changes no existing behavior — the ingest
-- writer's cost is one more index entry per upsert.
--
-- NULLS LAST is NOT expressed in the index: Postgres's default for DESC is
-- NULLS FIRST, so the planner may not use this for the exact ordering of the
-- undated tail. That is accepted — the index earns its keep on the site filter
-- plus the dated majority, and the undated set is reached through its own
-- `docking_appointment_date IS NULL` predicate, which this index also serves.

CREATE INDEX IF NOT EXISTS "mymrc_hauls_mirror_site_docking_idx"
  ON "mymrc_hauls_mirror" ("site_id", "docking_appointment_date" DESC);
