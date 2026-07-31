-- ADR-0072 — tiered anchor-overwrite guardrail + iPad physical count go-live.
--
-- TEXT ids throughout, per the house rule.

CREATE TYPE "InventoryHoldStatus" AS ENUM ('pending', 'approved', 'discarded');

CREATE TABLE IF NOT EXISTS "inventory_anchor_config" (
  "id"                  TEXT PRIMARY KEY,
  "site_id"             TEXT NOT NULL UNIQUE,
  -- Seeded 20: Bill tightened this from a proposed 40 because on Woodland's
  -- 2,483 floor a 40% swing lets ~1,000 units through on a single tap.
  "swing_threshold_pct" DECIMAL(5,2) NOT NULL DEFAULT 20,
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_anchor_config_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE,
  -- 0 would hold every count including a re-count of the identical figure;
  -- >100 can never be reached by a decrease and disables the tier entirely.
  CONSTRAINT "inventory_anchor_threshold_sane"
    CHECK ("swing_threshold_pct" > 0 AND "swing_threshold_pct" <= 100)
);

CREATE TABLE IF NOT EXISTS "inventory_count_holds" (
  "id"                    TEXT PRIMARY KEY,
  "site_id"               TEXT NOT NULL,
  "units_indoor"          INTEGER,
  "units_total"           INTEGER,
  "units_in_processing"   INTEGER NOT NULL DEFAULT 0,
  "program_units"         DECIMAL(7,1),
  "non_program_units"     DECIMAL(7,1),
  "pool_attribution"      TEXT NOT NULL DEFAULT 'measured',
  "prior_snapshot_id"     TEXT,
  "prior_total"           INTEGER NOT NULL,
  "new_total"             INTEGER NOT NULL,
  "swing_pct"             DECIMAL(7,2) NOT NULL,
  "threshold_pct"         DECIMAL(5,2) NOT NULL,
  "status"                "InventoryHoldStatus" NOT NULL DEFAULT 'pending',
  "created_by"            TEXT NOT NULL,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approved_by"           TEXT,
  "approved_at"           TIMESTAMP(3),
  "approval_path"         TEXT,
  "discarded_by"          TEXT,
  "discarded_at"          TIMESTAMP(3),
  "discard_reason"        TEXT,
  "resulting_snapshot_id" TEXT,
  CONSTRAINT "inventory_count_holds_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE CASCADE,

  -- ── The control, in the database ──────────────────────────────────────
  -- The operator who entered a held count can NEVER be the person who
  -- releases it. This is the same posture as the reimbursement dual-approval
  -- CHECK (ADR-0068): the rule that matters most is the one a future code
  -- path cannot forget, so it lives here rather than only in a service.
  CONSTRAINT "inventory_hold_approver_not_operator"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "created_by"),

  -- An approved hold must say who released it and how; a discarded one must say
  -- who. A terminal row that cannot answer "who released this?" is not an audit
  -- trail, and this is the one write in the app that can move the whole floor.
  CONSTRAINT "inventory_hold_approved_is_attributed"
    CHECK ("status" <> 'approved' OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "approval_path" IS NOT NULL)),
  CONSTRAINT "inventory_hold_discarded_is_attributed"
    CHECK ("status" <> 'discarded' OR ("discarded_by" IS NOT NULL AND "discarded_at" IS NOT NULL)),
  CONSTRAINT "inventory_hold_approval_path_valid"
    CHECK ("approval_path" IS NULL OR "approval_path" IN ('pin', 'remote'))
);
CREATE INDEX IF NOT EXISTS "inventory_count_holds_site_status_idx"
  ON "inventory_count_holds" ("site_id", "status", "created_at");

-- Threshold seeded for both sites at Bill's 20%.
INSERT INTO "inventory_anchor_config" ("id", "site_id", "swing_threshold_pct", "created_at", "updated_at")
SELECT gen_random_uuid()::text, s."id", 20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("site_id") DO NOTHING;

-- ── The flip: ipad_count pilot → live at BOTH sites ────────────────────────
-- Bill's directive 2026-07-30. Verified before writing this: `ipad_count` was
-- `pilot` at both sites, `ipad_queue`/`ipad_inbound` already `live`.
--
-- Scoped to `ipad_count` ALONE. `ipad_processed` and `ipad_today_summary` stay
-- pilot and are deliberately untouched — this migration must not become the one
-- that quietly turned on three surfaces because they were adjacent in a table.
UPDATE "rollout_surfaces"
   SET "rollout_state" = 'live', "updated_at" = CURRENT_TIMESTAMP
 WHERE "surface_code" = 'ipad_count'
   AND "site_id" IN (SELECT "id" FROM "sites" WHERE "code" IN ('eugene', 'woodland'));
