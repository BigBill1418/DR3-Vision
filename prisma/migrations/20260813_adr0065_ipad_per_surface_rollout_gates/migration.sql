-- ADR-0065 — per-surface iPad (floor) rollout gates.
--
-- Until now every iPad floor surface shared ONE gate, `loads_inventory`. That
-- code is also the manager desktop's gate (loads-inventory + processed-units-close
-- tabs) and fronts every loads/inventory write via `assertLoadsInventoryActivated`,
-- so flipping it to `pilot` to hide an iPad screen would ALSO drop the managers'
-- tabs. This registers one row per iPad surface so Bill can disable exactly one
-- screen from /admin/rollout with no deploy and no collateral damage.
--
-- SEED STATES — a deliberate, documented deviation from ADR-0047 decision #3
-- ("new surfaces are born pilot"):
--
--     ipad_queue          live    (retrofit over an already-live surface)
--     ipad_inbound        live    (retrofit over an already-live surface)
--     ipad_count          pilot   (Bill's decision — OFF)
--     ipad_processed      pilot   (Bill's decision — OFF)
--     ipad_today_summary  pilot   (Bill's decision — OFF)
--
-- Born-pilot exists to stop NEW exposure reaching staff before Bill ramps it. It
-- is not a mandate to take a WORKING surface down. `loads_inventory` is `live` at
-- both sites today, so the truck queue and the inbound confirm screen are in
-- operators' hands right now. Seeding their retrofitted gates `pilot` would be an
-- unannounced regression of working functionality on the next deploy — the exact
-- opposite of the safety ADR-0047 is protecting. The three surfaces Bill asked to
-- turn OFF are seeded `pilot`, which is both his decision AND the ADR-0047 default.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). No DDL — this only seeds registry rows. Idempotent via ON CONFLICT on the
-- (surface_code, site_id) unique, so a replay or a re-run NEVER reverts a flip an
-- admin has made. On a fresh CI replay the `sites` table is empty at this point
-- (sites are seeded later by prisma/seed.mjs), so the SELECT yields zero rows —
-- additive and safe. prisma/seed.mjs carries the same five codes with the same
-- states for first-deploy/dev parity (both paths are idempotent).
--
-- `id` is TEXT (gen_random_uuid()::text), matching `rollout_surfaces.id` and the
-- repo's hand-written-migration rule — a `uuid`-typed id here would pass CI (which
-- does not run migrations) and only fail on deploy.
--
-- The dir name sorts AFTER the current chain tip
-- (`20260812_adr0060_ipad_floor_inbound_source`), preserving ADR-0035 lexical
-- migration ordering.

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
  ('ipad_queue',         'live'),
  ('ipad_inbound',       'live'),
  ('ipad_count',         'pilot'),
  ('ipad_processed',     'pilot'),
  ('ipad_today_summary', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
