-- ADR-0037 — Loads & inventory foundations (P1 groundwork), Addendum B shape.
--
-- Five new tables + two extended, PLUS a source-alias table and source flags, all
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: this migration replays on an
-- empty PG16 in CI). Every rate and program rule is DATA (`state_program_rules`),
-- never code; every table carries a business date + `source` provenance so the
-- ADR-0039 retro-audit can run over ANY historical window (D8). Money is integer
-- CENTS; weights integer lbs; fractional unit counts use DECIMAL(x,1).
--
-- This is the Addendum-B reconciliation of ADR-0037 (operator-directed, 2026-07-03;
-- docs/QUESTIONS.md Q-4). vs the accepted-ADR shape: `renovator_shipments` is DROPPED
-- (folded into `outbound_materials.sub_category = renovation`), the `outbound_materials`
-- commodity taxonomy is the daily-log 9, `outbound_materials` gains `sub_category` +
-- whole-unit/pool columns, `consumer_dropoffs` gains a `kind`, `sources` gain
-- program/trans-charge/mileage flags with a `source_aliases` table, `LoadSourceType`
-- gains `event`, and `processed_units_daily` is restructured to the daily-close model.
-- This migration has NEVER deployed — it is regenerated in place as one coherent
-- migration, not a corrective second one.
--
-- ids stay TEXT per this repo's convention. The dir name sorts AFTER
-- `20260703_survey_invite_reminder_tracking` (`b` > `_`), preserving ADR-0035
-- lexical migration ordering, so `LoadSourceType` (from the init migration) exists
-- before the ALTER TYPE below.

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "RecordSource" AS ENUM ('manual', 'mymrc', 'import');

CREATE TYPE "StateProgramRuleKind" AS ENUM ('processing_rate', 'satellite_collection_rate', 'collector_incentive', 'fuel_surcharge', 'driver_hourly', 'general_labor_hourly', 'per_diem_nightly', 'unit_weight_estimate');

CREATE TYPE "OutboundCommodity" AS ENUM ('trash', 'toppers', 'foam', 'metal', 'wood', 'cardboard', 'plastic', 'shoddy', 'cotton');

CREATE TYPE "OutboundSubCategory" AS ENUM ('renovation', 'baled', 'shredded');

CREATE TYPE "ConsumerDropoffKind" AS ENUM ('incentive', 'unpaid', 'illegal');

CREATE TYPE "LandfilledReason" AS ENUM ('bed_bug', 'soiled', 'water_logged', 'other');

CREATE TYPE "InventorySnapshotKind" AS ENUM ('physical', 'computed');

-- Extend the existing LoadSourceType enum (created in the init migration) with the
-- daily-log `event` source type. PG16 permits ADD VALUE inside the migration
-- transaction as long as the value is not USED in the same transaction (it isn't).
ALTER TYPE "LoadSourceType" ADD VALUE IF NOT EXISTS 'event';

-- ─────────────────────────────────────────────────────────────────────────
-- D2 — inbound_loads additive extensions (workbook Inbound tabs + Q8 gate)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "inbound_loads"
  ADD COLUMN "retrac_id" TEXT,
  ADD COLUMN "slip_number" TEXT,
  ADD COLUMN "transport_charged" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "freight_cents" INTEGER,
  ADD COLUMN "fuel_surcharge_cents" INTEGER,
  ADD COLUMN "program_unit_count" INTEGER,
  ADD COLUMN "non_program_unit_count" INTEGER;

CREATE INDEX "inbound_loads_retrac_id_idx" ON "inbound_loads"("retrac_id");
CREATE INDEX "inbound_loads_site_id_transport_charged_idx" ON "inbound_loads"("site_id", "transport_charged");

-- ─────────────────────────────────────────────────────────────────────────
-- B7 — sources additive extensions (site-driven program-ness + trans-charge)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "sources"
  ADD COLUMN "is_non_program" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "is_trans_charge" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "canonical_mileage" INTEGER;

-- B7 — source_aliases (spelling-drift resolution for historical joins)
CREATE TABLE "source_aliases" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_aliases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_aliases_alias_key" ON "source_aliases"("alias");
CREATE INDEX "source_aliases_source_id_idx" ON "source_aliases"("source_id");

ALTER TABLE "source_aliases" ADD CONSTRAINT "source_aliases_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D6 — site_inventory_snapshots additive extensions (physical/computed anchor)
-- Existing rows default to `physical` (they were hand-taken counts).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "site_inventory_snapshots"
  ADD COLUMN "snapshot_kind" "InventorySnapshotKind" NOT NULL DEFAULT 'physical',
  ADD COLUMN "reconciled_delta" INTEGER,
  ADD COLUMN "source" "RecordSource" NOT NULL DEFAULT 'manual';

CREATE INDEX "site_inventory_snapshots_site_id_snapshot_kind_snapshot_at_idx" ON "site_inventory_snapshots"("site_id", "snapshot_kind", "snapshot_at");

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — state_program_rules (effective-dated, site-scoped rate/rule table)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "state_program_rules" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "rule_kind" "StateProgramRuleKind" NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "rate_cents" INTEGER,
    "params" JSONB,
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "state_program_rules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "state_program_rules_site_id_rule_kind_effective_from_idx" ON "state_program_rules"("site_id", "rule_kind", "effective_from");

ALTER TABLE "state_program_rules" ADD CONSTRAINT "state_program_rules_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D3 — consumer_dropoffs (public drop-offs; CA CIP; person_name is PII)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "consumer_dropoffs" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "dropoff_date" DATE NOT NULL,
    "kind" "ConsumerDropoffKind" NOT NULL,
    "person_name" TEXT NOT NULL,
    "slip_number" TEXT,
    "units" INTEGER NOT NULL,
    "incentive_cents" INTEGER,
    "check_number" TEXT,
    "paid_at" TIMESTAMP(3),
    "retrac_id" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumer_dropoffs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consumer_dropoffs_site_id_dropoff_date_idx" ON "consumer_dropoffs"("site_id", "dropoff_date");
CREATE INDEX "consumer_dropoffs_site_id_person_name_dropoff_date_idx" ON "consumer_dropoffs"("site_id", "person_name", "dropoff_date");
CREATE INDEX "consumer_dropoffs_retrac_id_idx" ON "consumer_dropoffs"("retrac_id");

ALTER TABLE "consumer_dropoffs" ADD CONSTRAINT "consumer_dropoffs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D4 (Addendum B1) — outbound_materials (commodity × sub-category; renovation
-- folded in as a whole-unit sub-category, replacing renovator_shipments)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "outbound_materials" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "ship_date" DATE NOT NULL,
    "commodity" "OutboundCommodity" NOT NULL,
    "sub_category" "OutboundSubCategory" NOT NULL,
    "weight_lbs" INTEGER NOT NULL,
    "whole_units" INTEGER,
    "program_units" INTEGER,
    "non_program_units" INTEGER,
    "ticket_number" TEXT,
    "retrac_id" TEXT,
    "bale_count" INTEGER,
    "allocation_pct" DECIMAL(5,2),
    "buyer" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_materials_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "outbound_materials_site_id_ship_date_idx" ON "outbound_materials"("site_id", "ship_date");
CREATE INDEX "outbound_materials_site_id_commodity_ship_date_idx" ON "outbound_materials"("site_id", "commodity", "ship_date");
CREATE INDEX "outbound_materials_site_id_sub_category_ship_date_idx" ON "outbound_materials"("site_id", "sub_category", "ship_date");
CREATE INDEX "outbound_materials_retrac_id_idx" ON "outbound_materials"("retrac_id");

ALTER TABLE "outbound_materials" ADD CONSTRAINT "outbound_materials_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D4 — landfilled_units (whole-unit disposal)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "landfilled_units" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "disposal_date" DATE NOT NULL,
    "units" INTEGER NOT NULL,
    "program_units" INTEGER NOT NULL DEFAULT 0,
    "non_program_units" INTEGER NOT NULL DEFAULT 0,
    "slip_number" TEXT,
    "reason" "LandfilledReason" NOT NULL,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "landfilled_units_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "landfilled_units_site_id_disposal_date_idx" ON "landfilled_units"("site_id", "disposal_date");

ALTER TABLE "landfilled_units" ADD CONSTRAINT "landfilled_units_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D5 (Addendum B4) — processed_units_daily (the daily close; one row/site/day)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "processed_units_daily" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "production_date" DATE NOT NULL,
    "stripped_program" DECIMAL(7,1) NOT NULL,
    "stripped_non_program" DECIMAL(7,1) NOT NULL DEFAULT 0,
    "saved_units" DECIMAL(7,1),
    "material_ticket_number" TEXT,
    "employees_count" INTEGER,
    "processors_count" INTEGER,
    "pocketcoil_estimate" INTEGER,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "entered_by" TEXT,
    "closed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "processed_units_daily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "processed_units_daily_site_id_production_date_key" ON "processed_units_daily"("site_id", "production_date");
CREATE INDEX "processed_units_daily_site_id_production_date_idx" ON "processed_units_daily"("site_id", "production_date");

ALTER TABLE "processed_units_daily" ADD CONSTRAINT "processed_units_daily_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
