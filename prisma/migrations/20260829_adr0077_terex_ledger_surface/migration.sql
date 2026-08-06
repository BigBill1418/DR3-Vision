-- ADR-0077 D6 — register the Terex machine ledger UI surface, BORN PILOT.
--
-- ONE additive statement. No DDL at all: this migration only registers a
-- visibility gate.
--
-- ADR-0047 decision #3: a new staff-visible surface is born `pilot` (admin-only)
-- and is ramped only by Bill from /admin/rollout. This one is genuinely new
-- exposure — a management view of one machine's invoice history — so the default
-- applies unmodified. There is nothing working today that seeding `pilot` takes
-- away.
--
-- Pilot is doing a SECOND job here, which is why the surface ships dark rather
-- than waiting for a later PR. The ledger's AP half is fully live (four approved
-- invoices, $2,024.92, all on the canonical `7e35a4aa` after this ADR's merge) and
-- its downtime half is honest ("not recorded" — ADR-0077 D4). Its MAINTENANCE half
-- is empty until the absorption acceptance in docs/OPEN-ITEMS.md O-12, and shows
-- an explicit "awaiting acceptance" state until then. Born-pilot is what keeps
-- that half-populated view off a manager's screen while the code, the gate and the
-- pinned math all land and get exercised. Bill flips it after O-12.
--
-- Registered for BOTH sites even though only Woodland holds a Terex. Every other
-- UI surface is registered per-site, `getRolloutState` looks up
-- (surface_code, site_id) and an unregistered pair resolves to admin-only via
-- `UnregisteredSurfaceError`; seeding only Woodland would make Eugene's state a
-- swallowed exception rather than a stated decision.
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
-- (`20260828_adr0076_daily_report_processor_counts`), preserving ADR-0035
-- lexical ordering.

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
  ('equipment_terex_ledger', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
