-- ADR-0046 Amendment 9 (§2.2/§2.3/§2.4/§2.5) — the AP equipment ESCAPE HATCH.
--
-- WHY: before this, an approver looking at an invoice for an asset the equipment
-- registry does not carry had exactly two options, and both are lies — pick a
-- wrong-but-plausible asset, or tick "Not equipment-related". Either way the
-- invoice is filed against the wrong thing and nothing records that the fleet
-- registry is incomplete. This migration adds the honest third answer: a REQUIRED
-- free-text description that unblocks the approval AND files a tracked request for
-- the site managers to add the asset properly.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty
-- PG16 in CI). The one non-additive-looking statement is the CHECK constraint on
-- `ap_equipment_links`, which was validated against PRODUCTION before shipping:
-- all 17 existing rows satisfy it (2 equipment_id, 15 is_not_equipment_related,
-- 0 "neither", 0 "both"), and the whole file was replayed on prod inside
-- BEGIN; … ROLLBACK; — see the Amendment 9 verification note in ADR-0046.
--
-- `id` / FK columns are TEXT (`gen_random_uuid()::text`) per the repo's
-- hand-written-migration rule. A `uuid`-typed id passes CI (which does not run
-- migrations) and only fails on deploy, taking the app down.

-- ── §2.3 — request lifecycle enum ───────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "ApEquipmentRequestStatus" AS ENUM ('open', 'resolved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── §2.3 — the request table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ap_equipment_requests" (
  "id"                    TEXT PRIMARY KEY,
  "ap_request_id"         TEXT NOT NULL,
  -- NOT NULL: the hatch is reachable only from a STRUCTURED real-site Approve,
  -- where the site tag is already required (operator directive 2026-07-15).
  "site_id"               TEXT NOT NULL,
  -- NOT NULL is the whole point. The description is what makes this a tracked
  -- request rather than a silent third flavour of "not equipment".
  "description"           TEXT NOT NULL,
  "requested_by"          TEXT NOT NULL,
  "requested_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"                "ApEquipmentRequestStatus" NOT NULL DEFAULT 'open',
  "resolved_equipment_id" TEXT,
  "resolved_by"           TEXT,
  "resolved_at"           TIMESTAMP(3),
  "resolution_note"       TEXT
);

-- Worklist reads: open requests, org-wide and per-site (hard rule #2 — a
-- single-site manager sees only their own site's queue).
CREATE INDEX IF NOT EXISTS "ap_equipment_requests_status_idx"
  ON "ap_equipment_requests" ("status");
CREATE INDEX IF NOT EXISTS "ap_equipment_requests_site_id_status_idx"
  ON "ap_equipment_requests" ("site_id", "status");
CREATE INDEX IF NOT EXISTS "ap_equipment_requests_ap_request_id_idx"
  ON "ap_equipment_requests" ("ap_request_id");

-- The invoice this came from. CASCADE mirrors `ap_equipment_links.request_id`:
-- if the AP request row ever goes, its decision artifacts go with it.
DO $$ BEGIN
  ALTER TABLE "ap_equipment_requests"
    ADD CONSTRAINT "ap_equipment_requests_ap_request_id_fkey"
    FOREIGN KEY ("ap_request_id") REFERENCES "ap_requests"("id")
    ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ap_equipment_requests"
    ADD CONSTRAINT "ap_equipment_requests_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ap_equipment_requests"
    ADD CONSTRAINT "ap_equipment_requests_requested_by_fkey"
    FOREIGN KEY ("requested_by") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- RESTRICT, not SET NULL: `equipment` is never hard-deleted (deactivation is the
-- only removal, ADR-0063), and the resolution pointer is the evidence that this
-- request produced that asset.
DO $$ BEGIN
  ALTER TABLE "ap_equipment_requests"
    ADD CONSTRAINT "ap_equipment_requests_resolved_equipment_id_fkey"
    FOREIGN KEY ("resolved_equipment_id") REFERENCES "equipment"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ap_equipment_requests"
    ADD CONSTRAINT "ap_equipment_requests_resolved_by_fkey"
    FOREIGN KEY ("resolved_by") REFERENCES "users"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A resolved request must name the asset it produced; a rejected one must say
-- why. Storage-layer guarantee for what the data layer also enforces — this is
-- the half that cannot be bypassed by a bug or a hand-written UPDATE.
ALTER TABLE "ap_equipment_requests"
  DROP CONSTRAINT IF EXISTS "ap_equipment_requests_terminal_state_evidence";
ALTER TABLE "ap_equipment_requests"
  ADD CONSTRAINT "ap_equipment_requests_terminal_state_evidence"
  CHECK (
    ("status" = 'open'     AND "resolved_equipment_id" IS NULL AND "resolved_at" IS NULL)
    OR ("status" = 'resolved' AND "resolved_equipment_id" IS NOT NULL AND "resolved_at" IS NOT NULL)
    OR ("status" = 'rejected' AND "resolved_equipment_id" IS NULL AND "resolved_at" IS NOT NULL
        AND "resolution_note" IS NOT NULL AND btrim("resolution_note") <> '')
  );

-- ── §2.3 — the third disposition on the link table ──────────────────────────
ALTER TABLE "ap_equipment_links"
  ADD COLUMN IF NOT EXISTS "equipment_request_id" TEXT;

CREATE INDEX IF NOT EXISTS "ap_equipment_links_equipment_request_id_idx"
  ON "ap_equipment_links" ("equipment_request_id");

-- RESTRICT: a request row is never deleted, and deleting one out from under a
-- link would leave that link with all three dispositions empty — which the CHECK
-- below refuses anyway. Fail at the FK rather than corrupt then fail.
DO $$ BEGIN
  ALTER TABLE "ap_equipment_links"
    ADD CONSTRAINT "ap_equipment_links_equipment_request_id_fkey"
    FOREIGN KEY ("equipment_request_id") REFERENCES "ap_equipment_requests"("id")
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- EXACTLY ONE disposition per link row. Before Amendment 9 this invariant was
-- app-enforced only ("mutually exclusive with real equipment picks
-- (app-enforced)" — schema.prisma). A third option is exactly the change that
-- turns a two-way app check into a three-way one somebody forgets to update, so
-- the invariant moves into the database where it cannot be forgotten.
--
-- Note `is_not_equipment_related` is BOOLEAN NOT NULL DEFAULT false, so its
-- "set" test is `= true`, not `IS NOT NULL`.
--
-- Verified against production before shipping: all 17 pre-existing rows satisfy
-- this (2 with equipment_id, 15 with is_not_equipment_related, 0 violating).
ALTER TABLE "ap_equipment_links"
  DROP CONSTRAINT IF EXISTS "ap_equipment_links_exactly_one_disposition";
ALTER TABLE "ap_equipment_links"
  ADD CONSTRAINT "ap_equipment_links_exactly_one_disposition"
  CHECK (
    (CASE WHEN "equipment_id" IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN "is_not_equipment_related" THEN 1 ELSE 0 END)
    + (CASE WHEN "equipment_request_id" IS NOT NULL THEN 1 ELSE 0 END)
    = 1
  );

-- ── §2.5 — the site-manager grant ───────────────────────────────────────────
-- A narrow scoped flag in the `can_view_ap_history` / `can_view_billing_verify`
-- shape: read fresh from Postgres on every request, never in the JWT, grants
-- exactly the equipment-request worklist and NO admin power.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "can_resolve_equipment_requests" BOOLEAN NOT NULL DEFAULT false;

-- Grant the named SITE MANAGERS. Email-keyed, deliberately — Bill, Janette and
-- Morena each have TWO live rows (their manager/admin account with an @svdp.us
-- address, and an email-less operator PIN account created 2026-07-28 for the iPad
-- rollout). A `name`-keyed seed selects the operator account, which can neither
-- reach the worklist nor be emailed. Same trap, same fix, as the ADR-0066 seed.
--
-- No-op on a clean CI replay (empty `users`); idempotent on re-run.
UPDATE "users" u
   SET "can_resolve_equipment_requests" = true
  FROM (VALUES
    ('morena.gomez@svdp.us'),
    ('rick.albritton@svdp.us'),
    ('janette.tomas@svdp.us')
  ) AS v(email)
 WHERE lower(u."email") = v.email
   AND u."deleted_at" IS NULL
   AND u."role" = 'manager'
   AND u."can_resolve_equipment_requests" = false;

-- ── §2.4 — the notification surface (ADR-0047), born pilot ──────────────────
-- A NEW staff-facing output with a NEW recipient roster, so it gets its OWN
-- rollout row rather than riding `ap_notify`: Bill must be able to ramp the
-- equipment-request email to the site managers without also ramping the AP queue's
-- new-invoice broadcast, and vice versa. Born `pilot` (admins-only, with the
-- would-have-sent header) per CLAUDE.md hard rule #12.
--
-- Zero rows on a fresh CI replay (`sites` is seeded later by prisma/seed.mjs);
-- ON CONFLICT DO NOTHING so a replay never reverts a `live` flip.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'notification', 'ap_equipment_request', s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
