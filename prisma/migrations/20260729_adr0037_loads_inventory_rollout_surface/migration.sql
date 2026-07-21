-- ADR-0037 D7 → data-driven activation (ADR-0047) — register the `loads_inventory`
-- UI rollout surface so the loads/inventory + floor-operator flow becomes an
-- admin-flippable gate (from /admin/rollout) instead of a hardcoded admin-only
-- switch in code.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). No DDL — this only seeds the two per-site registry rows, born `pilot`
-- (= admin-only, the historical behavior). Idempotent via ON CONFLICT on the
-- (surface_code, site_id) unique, so a replay or a re-run NEVER reverts a `live`
-- flip an admin has made. On a fresh CI replay the `sites` table is empty at this
-- point (sites are seeded later by prisma/seed.mjs), so the SELECT yields zero
-- rows — additive and safe. On production the two Eugene/Woodland rows are
-- inserted (born pilot) so the surface appears on /admin/rollout without a manual
-- re-seed. prisma/seed.mjs also lists `loads_inventory` for first-deploy/dev
-- parity (both paths are idempotent and never clobber each other).
--
-- The dir name sorts AFTER the current chain tip (`20260728_ap_not_dr3_location`),
-- preserving ADR-0035 lexical migration ordering.

INSERT INTO "rollout_surfaces" ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'ui', 'loads_inventory', s."id", 'pilot', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
