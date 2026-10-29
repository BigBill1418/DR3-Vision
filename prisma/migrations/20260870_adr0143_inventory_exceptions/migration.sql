-- ADR-0143 — the program pool is a claim, not a count.
--
-- Three new tables, additive only (ADR-0035): nothing existing is altered, and no
-- existing row is rewritten. Bill approved the design on 2026-10-29 (B5).
--
--   inventory_exceptions       a pool that went below zero, opened in the same
--                              transaction as the write that drove it (D2)
--   inventory_pool_adjustments a four-eyes correction of the pool SPLIT; the
--                              total is preserved by construction (D4)
--   inventory_position_daily   the materialised daily position per pool, with a
--                              deferred constraint trigger that refuses a
--                              negative closing without an exception (D3)
--
-- Idempotent (IF NOT EXISTS / duplicate_object) so a re-run is a no-op and a clean
-- PG16 replay succeeds.
--
-- DOWN (manual, only before any row is written — the tables are append-only once
-- used): DROP TABLE inventory_position_daily, inventory_pool_adjustments,
-- inventory_exceptions; DROP FUNCTION adr0143_*; DROP TYPE "InventoryPool",
-- "InventoryExceptionStatus", "InventoryAdjustmentStatus"; DELETE FROM
-- rollout_surfaces WHERE surface_code = 'inventory_exceptions'.

-- ── 1. Enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "InventoryPool" AS ENUM ('program', 'non_program');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InventoryExceptionStatus" AS ENUM ('open', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "InventoryAdjustmentStatus" AS ENUM ('proposed', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. inventory_exceptions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_exceptions" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "pool" "InventoryPool" NOT NULL,
    "status" "InventoryExceptionStatus" NOT NULL DEFAULT 'open',
    "first_negative_day" DATE NOT NULL,
    "last_negative_day" DATE,
    "opened_by_writer" TEXT NOT NULL,
    "opened_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "shortfall" DECIMAL(10,1) NOT NULL,
    "legs" JSONB NOT NULL,
    "onset_paged_at" TIMESTAMPTZ(3),
    "repaged_at" TIMESTAMPTZ(3),
    "resolution_proposed_by" TEXT,
    "resolution_proposed_note" TEXT,
    "resolution_proposed_at" TIMESTAMPTZ(3),
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "resolution" TEXT,

    CONSTRAINT "inventory_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "inventory_exceptions_site_id_status_idx"
  ON "inventory_exceptions"("site_id", "status");
-- D2 dedup (ADR-0037 gate q4): at most ONE open exception per site + pool. A
-- replayed write, or two writers on one site, cannot open a second.
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_exceptions_one_open_per_pool"
  ON "inventory_exceptions"("site_id", "pool") WHERE "status" = 'open';

DO $$ BEGIN
  ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_shortfall_chk"
    CHECK ("shortfall" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_writer_chk"
    CHECK (length(btrim("opened_by_writer")) > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- A resolved exception names who resolved it, when, how, and the last day it explains.
DO $$ BEGIN
  ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_resolved_chk"
    CHECK ("status" = 'open'
           OR ("resolved_by" IS NOT NULL AND "resolved_at" IS NOT NULL
               AND "resolution" IS NOT NULL AND length(btrim("resolution")) > 0
               AND "last_negative_day" IS NOT NULL
               AND "last_negative_day" >= "first_negative_day"));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Bill B4: a second person approves. A no-adjustment resolution cannot be approved
-- by the person who proposed it.
DO $$ BEGIN
  ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_four_eyes_chk"
    CHECK ("resolution_proposed_by" IS NULL OR "resolved_by" IS NULL
           OR "resolution_proposed_by" <> "resolved_by");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_exceptions" ADD CONSTRAINT "inventory_exceptions_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- An exception is a record of a negative that happened. It is never deleted, and
-- once resolved it is never reopened or edited (CLAUDE.md hard rule 6 in spirit).
CREATE OR REPLACE FUNCTION adr0143_exceptions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_exceptions is append-only (ADR-0143): delete refused for %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'resolved' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'inventory_exceptions %: a resolved exception is final (ADR-0143)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.site_id <> OLD.site_id OR NEW.pool <> OLD.pool
     OR NEW.first_negative_day <> OLD.first_negative_day
     OR NEW.opened_by_writer <> OLD.opened_by_writer OR NEW.opened_at <> OLD.opened_at
     OR NEW.shortfall <> OLD.shortfall OR NEW.legs <> OLD.legs THEN
    RAISE EXCEPTION 'inventory_exceptions %: the opening facts are immutable (ADR-0143)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "inventory_exceptions_guard_trg" ON "inventory_exceptions";
CREATE TRIGGER "inventory_exceptions_guard_trg"
  BEFORE UPDATE OR DELETE ON "inventory_exceptions"
  FOR EACH ROW EXECUTE FUNCTION adr0143_exceptions_guard();

-- ── 3. inventory_pool_adjustments ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_pool_adjustments" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "from_pool" "InventoryPool" NOT NULL,
    "to_pool" "InventoryPool" NOT NULL,
    "units" DECIMAL(10,1) NOT NULL,
    "reason" TEXT NOT NULL,
    "exception_id" TEXT,
    "status" "InventoryAdjustmentStatus" NOT NULL DEFAULT 'proposed',
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "rejected_by" TEXT,
    "rejected_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "inventory_pool_adjustments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "inventory_pool_adjustments_site_id_status_day_idx"
  ON "inventory_pool_adjustments"("site_id", "status", "day");
CREATE INDEX IF NOT EXISTS "inventory_pool_adjustments_exception_id_idx"
  ON "inventory_pool_adjustments"("exception_id");

-- The total is preserved BY CONSTRUCTION: units leave one pool and enter the other.
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_pools_chk"
    CHECK ("from_pool" <> "to_pool");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_units_chk"
    CHECK ("units" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_reason_chk"
    CHECK (length(btrim("reason")) >= 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Four-eyes (Bill B4): the approver is never the proposer.
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_four_eyes_chk"
    CHECK ("approved_by" IS NULL OR "approved_by" <> "proposed_by");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- The status and its decision columns agree.
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_status_chk"
    CHECK (
      ("status" = 'proposed' AND "approved_by" IS NULL AND "approved_at" IS NULL
         AND "rejected_by" IS NULL AND "rejected_at" IS NULL)
      OR ("status" = 'approved' AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL
         AND "rejected_by" IS NULL)
      OR ("status" = 'rejected' AND "rejected_by" IS NOT NULL AND "rejected_at" IS NOT NULL
         AND "approved_by" IS NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_pool_adjustments" ADD CONSTRAINT "inventory_pool_adjustments_exception_id_fkey"
    FOREIGN KEY ("exception_id") REFERENCES "inventory_exceptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Append-only: never deleted; a decided row is final; only the decision columns
-- move, and only out of `proposed`. Corrections append (ADR-0090 pattern).
CREATE OR REPLACE FUNCTION adr0143_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'inventory_pool_adjustments is append-only (ADR-0143): delete refused for %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'proposed' THEN
    RAISE EXCEPTION 'inventory_pool_adjustments %: a decided adjustment is final (ADR-0143)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.site_id <> OLD.site_id OR NEW.day <> OLD.day OR NEW.from_pool <> OLD.from_pool
     OR NEW.to_pool <> OLD.to_pool OR NEW.units <> OLD.units OR NEW.reason <> OLD.reason
     OR NEW.exception_id IS DISTINCT FROM OLD.exception_id
     OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at THEN
    RAISE EXCEPTION 'inventory_pool_adjustments %: only the decision may change (ADR-0143)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "inventory_pool_adjustments_guard_trg" ON "inventory_pool_adjustments";
CREATE TRIGGER "inventory_pool_adjustments_guard_trg"
  BEFORE UPDATE OR DELETE ON "inventory_pool_adjustments"
  FOR EACH ROW EXECUTE FUNCTION adr0143_adjustments_guard();

-- ── 4. inventory_position_daily ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_position_daily" (
    "site_id" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "pool" "InventoryPool" NOT NULL,
    "anchor_snapshot_id" TEXT,
    "opening" DECIMAL(10,1) NOT NULL,
    "inbound" DECIMAL(10,1) NOT NULL,
    "dropoffs" DECIMAL(10,1) NOT NULL,
    "stripped" DECIMAL(10,1) NOT NULL,
    "sold" DECIMAL(10,1) NOT NULL,
    "landfilled" DECIMAL(10,1) NOT NULL,
    "adjustments" DECIMAL(10,1) NOT NULL,
    "closing" DECIMAL(10,1) NOT NULL,
    "exception_id" TEXT,
    "inputs_hash" TEXT NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_position_daily_pkey" PRIMARY KEY ("site_id","day","pool")
);
CREATE INDEX IF NOT EXISTS "inventory_position_daily_exception_id_idx"
  ON "inventory_position_daily"("exception_id");

-- The row's own arithmetic is checked, so a writer cannot store a closing that its
-- legs do not produce.
DO $$ BEGIN
  ALTER TABLE "inventory_position_daily" ADD CONSTRAINT "inventory_position_daily_arith_chk"
    CHECK ("closing" = "opening" + "inbound" + "dropoffs" - "stripped" - "sold"
                       - "landfilled" + "adjustments");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "inventory_position_daily" ADD CONSTRAINT "inventory_position_daily_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "inventory_position_daily" ADD CONSTRAINT "inventory_position_daily_exception_id_fkey"
    FOREIGN KEY ("exception_id") REFERENCES "inventory_exceptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- D3 — THE invariant this ADR makes a database fact: a negative closing exists only
-- as a recorded, owned exception of the same site and pool. DEFERRABLE INITIALLY
-- DEFERRED so the guard may write the positions and the exception in either order
-- inside one transaction; the check re-reads the CURRENT row at commit (a deferred
-- trigger's NEW is the row as of the event, which a later update in the same
-- transaction may already have fixed).
CREATE OR REPLACE FUNCTION adr0143_position_explained() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  cur RECORD;
  ex  RECORD;
BEGIN
  SELECT "closing", "exception_id" INTO cur FROM "inventory_position_daily"
   WHERE "site_id" = NEW.site_id AND "day" = NEW.day AND "pool" = NEW.pool;
  IF NOT FOUND THEN
    RETURN NULL; -- deleted later in the same transaction
  END IF;
  IF cur.closing >= 0 THEN
    RETURN NULL;
  END IF;
  IF cur.exception_id IS NULL THEN
    RAISE EXCEPTION 'inventory_position_daily %/%/%: closing % is negative with no inventory exception (ADR-0143 D3)',
      NEW.site_id, NEW.day, NEW.pool, cur.closing
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT "site_id", "pool" INTO ex FROM "inventory_exceptions" WHERE "id" = cur.exception_id;
  IF NOT FOUND OR ex.site_id <> NEW.site_id OR ex.pool <> NEW.pool THEN
    RAISE EXCEPTION 'inventory_position_daily %/%/%: exception % does not belong to this site and pool (ADR-0143 D3)',
      NEW.site_id, NEW.day, NEW.pool, cur.exception_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "inventory_position_daily_explained_trg" ON "inventory_position_daily";
CREATE CONSTRAINT TRIGGER "inventory_position_daily_explained_trg"
  AFTER INSERT OR UPDATE ON "inventory_position_daily"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION adr0143_position_explained();

-- ── 5. The in-app exception page is a NEW staff-facing surface: born pilot ──
-- (CLAUDE.md hard rule 12 / ADR-0047). Admins only until Bill ramps it from
-- /admin/rollout.
INSERT INTO "rollout_surfaces"
  ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT gen_random_uuid()::text, 'ui', 'inventory_exceptions', s."id", 'pilot',
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "sites" s
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
