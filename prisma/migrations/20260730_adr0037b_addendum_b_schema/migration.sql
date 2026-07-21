-- ADR-0037 amendment + ADR-0056 (rollup §2/§4/§5.2/§5.3/§14, Rick/Bill 2026-07-19/20)
-- — Addendum-B schema surface: SVDP internal-store site type, provenance agencies,
-- the status-bucketed unit ledger, and the event-billing + TONU tables.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in CI).
-- DDL ONLY — no rows are seeded here. The companion `20260730b_addendum_b_seeds`
-- migration performs the source renames / store rows / aliases / provenance seed /
-- Kelsey AP-date UPDATE. They are split deliberately: PG16 permits `ALTER TYPE …
-- ADD VALUE` inside a migration transaction ONLY when the new value is not USED in
-- the same transaction, and the store-row INSERT below (in the seeds migration) uses
-- `svdp_internal_store`. Splitting the ADD VALUE (here) from its first use (there)
-- keeps both migrations clean under `prisma migrate deploy` (same rule the
-- `20260703b_loads_inventory_foundations` migration documents for LoadSourceType).
--
-- The dir name sorts AFTER the current chain tip
-- (`20260729_adr0037_loads_inventory_rollout_surface`), preserving ADR-0035 lexical
-- migration ordering.
--
-- Bare scalar FKs (no Prisma back-relations) keep every new block self-contained,
-- mirroring the `collection_events` / `state_program_rules` pattern. `landfilled_reason`
-- REUSES the existing `LandfilledReason` enum (handoff "wet" == `water_logged`), and the
-- event labor/driver/per-diem constants REUSE the existing StateProgramRuleKind values —
-- no duplicate enums are introduced.

-- ── Enum extensions (NOT used in DML in this migration; see split rationale above) ──
ALTER TYPE "SourceSiteType" ADD VALUE IF NOT EXISTS 'svdp_internal_store';
ALTER TYPE "StateProgramRuleKind" ADD VALUE IF NOT EXISTS 'irs_mileage_rate';

-- ── New enums ──
CREATE TYPE "UnitStatus" AS ENUM ('on_floor', 'saved', 'processed', 'sold', 'landfilled');
CREATE TYPE "EventLegType" AS ENUM ('drop', 'pickup', 'same_day');

-- ── ADR-0037 amendment §2 — provenance agencies (origin of delivered mattresses) ──
CREATE TABLE "provenance_agencies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provenance_agencies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provenance_agencies_name_key" ON "provenance_agencies"("name");

-- ── ADR-0037 amendment §5.2 — status-bucketed unit ledger (Rick's model) ──
CREATE TABLE "unit_status_movements" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "movement_date" DATE NOT NULL,
    "units" INTEGER NOT NULL,
    "from_status" "UnitStatus",
    "to_status" "UnitStatus" NOT NULL,
    "status_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "landfilled_reason" "LandfilledReason",
    "store_destination_id" TEXT,
    "retrac_id" TEXT,
    "slip_number" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "import_id" TEXT,
    "locked_at" TIMESTAMP(3),
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "unit_status_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "unit_status_movements_site_id_movement_date_idx"
    ON "unit_status_movements"("site_id", "movement_date");
CREATE INDEX "unit_status_movements_site_id_to_status_idx"
    ON "unit_status_movements"("site_id", "to_status");
CREATE INDEX "unit_status_movements_store_destination_id_idx"
    ON "unit_status_movements"("store_destination_id");

ALTER TABLE "unit_status_movements"
    ADD CONSTRAINT "unit_status_movements_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "unit_status_movements"
    ADD CONSTRAINT "unit_status_movements_store_destination_id_fkey"
    FOREIGN KEY ("store_destination_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── ADR-0056 §5.3 — event freight legs (per-leg Event-Mile-Rate tier pricing) ──
CREATE TABLE "event_legs" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "leg_type" "EventLegType" NOT NULL,
    "tier_lookup_miles" INTEGER,
    "rate_cents" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_legs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "event_legs_event_id_idx" ON "event_legs"("event_id");

ALTER TABLE "event_legs"
    ADD CONSTRAINT "event_legs_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "collection_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ADR-0056 §5.3 item 6 — per-vehicle IRS mileage ──
CREATE TABLE "event_vehicles" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "vehicle_label" TEXT,
    "miles_driven" INTEGER,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_vehicles_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "event_vehicles_event_id_idx" ON "event_vehicles"("event_id");

ALTER TABLE "event_vehicles"
    ADD CONSTRAINT "event_vehicles_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "collection_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ADR-0056 §5.3 — TONU (Trailer Order Not Used) billing ──
CREATE TABLE "tonu_billing" (
    "id" TEXT NOT NULL,
    "event_id" TEXT,
    "site_id" TEXT NOT NULL,
    "dispatched_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "diverted" BOOLEAN NOT NULL DEFAULT false,
    "haul_rate_cents" INTEGER,
    "billed_cents" INTEGER,
    "note" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tonu_billing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tonu_billing_event_id_idx" ON "tonu_billing"("event_id");
CREATE INDEX "tonu_billing_site_id_idx" ON "tonu_billing"("site_id");

ALTER TABLE "tonu_billing"
    ADD CONSTRAINT "tonu_billing_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "collection_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tonu_billing"
    ADD CONSTRAINT "tonu_billing_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── ADR-0037 amendment §2 — inbound_loads provenance-agency FK (bare scalar) ──
ALTER TABLE "inbound_loads" ADD COLUMN "provenance_agency_id" TEXT;

CREATE INDEX "inbound_loads_provenance_agency_id_idx"
    ON "inbound_loads"("provenance_agency_id");

ALTER TABLE "inbound_loads"
    ADD CONSTRAINT "inbound_loads_provenance_agency_id_fkey"
    FOREIGN KEY ("provenance_agency_id") REFERENCES "provenance_agencies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── ADR-0056 §5.3 — collection_events event-billing component columns ──
ALTER TABLE "collection_events" ADD COLUMN "driver_onsite_hours" DECIMAL(5,2);
ALTER TABLE "collection_events" ADD COLUMN "per_diem_days" INTEGER;
ALTER TABLE "collection_events" ADD COLUMN "overnight" BOOLEAN NOT NULL DEFAULT false;
