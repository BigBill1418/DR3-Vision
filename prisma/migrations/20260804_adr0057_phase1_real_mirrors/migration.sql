-- ADR-0057 Phase 1 — adapt the MyMRC mirrors to the REAL discovered object
-- catalog (Phase 0 inaugural enumeration, docs/mymrc-discovery-2026-07-22.md) and
-- add the two objects/infrastructure Phase 1 needs.
--
-- The ADR-0038 mirrors were GUESSED (2026-07-03) before Vision ever authenticated
-- to the portal. Phase 0 revealed the true objects: Haul_Request__c (a2K, 52
-- fields), Materials__c (a2L, 27 fields — Processed AND Outbound split by Type__c),
-- Dock_Availability_Schedule__c (a1t, 14 fields, NEW). This migration ADAPTS the 3
-- existing mirror tables (keep, do not drop — ADR-0057), ADDS a dock-availability
-- mirror, and ADDS the resumable-backfill cursor table (ADR-0057 D3).
--
-- PURELY ADDITIVE + SAFE-WIDENING (ADR-0035 clean-replay invariant — replays on an
-- empty PG16 in CI, in order, after 20260704_mymrc_mirrors created the tables):
--   * every new column is NULLABLE (no DEFAULT needed; no backfill hazard),
--   * site_id is WIDENED NOT NULL → NULL (a widening; existing rows — there are
--     none, the mirrors are empty — remain valid; the FK stays and simply skips
--     NULLs). site is now derived on the DETAIL pass from the recycler/account
--     name (getItems returns ids only, so site is unknown at list-upsert time),
--   * the two new tables are fresh CREATEs; their NOT-NULL columns all carry a
--     DEFAULT.
-- No existing data is mutated. The dir name sorts AFTER the prior tip
-- (20260803_adr0057_reconciliation_queue), preserving ADR-0035 lexical ordering.
--
-- Type__c is the Processed/Outbound splitter at INGEST (both live in the same a2L
-- id space; a record can appear in both list views). The `type` column on each
-- Materials mirror records the raw Type__c for traceability.

-- ── Haul_Request__c (a2K) — real billing / expected_loads / site-discriminator columns ──
ALTER TABLE "mymrc_hauls_mirror"
    ALTER COLUMN "site_id" DROP NOT NULL,
    ADD COLUMN "type" TEXT,
    ADD COLUMN "recycler_name" TEXT,
    ADD COLUMN "recycler_account_id" TEXT,
    ADD COLUMN "transporter_name" TEXT,
    ADD COLUMN "collection_site" TEXT,
    ADD COLUMN "collection_source" TEXT,
    ADD COLUMN "commodity" TEXT,
    ADD COLUMN "container_type" TEXT,
    ADD COLUMN "program_unit_count" INTEGER,
    ADD COLUMN "non_program_unit_count" INTEGER,
    ADD COLUMN "unpaid_consumer_dropoff_units" INTEGER,
    ADD COLUMN "docking_appointment_date" TIMESTAMP(3);

CREATE INDEX "mymrc_hauls_mirror_recycler_account_id_idx" ON "mymrc_hauls_mirror"("recycler_account_id");

-- ── Materials__c (a2L) Processed rows ──
ALTER TABLE "mymrc_processed_mirror"
    ALTER COLUMN "site_id" DROP NOT NULL,
    ADD COLUMN "type" TEXT,
    ADD COLUMN "account_name" TEXT,
    ADD COLUMN "account_id" TEXT,
    ADD COLUMN "materials_status" TEXT,
    ADD COLUMN "program_unit_count" INTEGER,
    ADD COLUMN "non_program_unit_count" INTEGER;

CREATE INDEX "mymrc_processed_mirror_account_id_idx" ON "mymrc_processed_mirror"("account_id");

-- ── Materials__c (a2L) Outbound rows ──
ALTER TABLE "mymrc_outbound_mirror"
    ALTER COLUMN "site_id" DROP NOT NULL,
    ADD COLUMN "type" TEXT,
    ADD COLUMN "account_name" TEXT,
    ADD COLUMN "account_id" TEXT,
    ADD COLUMN "materials_status" TEXT,
    ADD COLUMN "program_unit_count" INTEGER,
    ADD COLUMN "non_program_unit_count" INTEGER;

CREATE INDEX "mymrc_outbound_mirror_account_id_idx" ON "mymrc_outbound_mirror"("account_id");

-- ── Dock_Availability_Schedule__c (a1t) — NEW mirror (non-billing scheduling) ──
-- No site_id: the 14-field detail set carries no account/recycler discriminator.
-- Slot times are Salesforce Time values stored as TEXT ("07:00:00.000Z"); Day_of_Week__c
-- / Container_Type__c are RAW ";"-joined multipicklists (read-side splits membership).
CREATE TABLE "mymrc_dock_availability_mirror" (
    "id" TEXT NOT NULL,
    "external_schedule_id" TEXT,
    "status" TEXT,
    "day_of_week" TEXT,
    "container_type" TEXT,
    "dock_door" TEXT,
    "slot_start_time" TEXT,
    "slot_end_time" TEXT,
    "available_appointments" INTEGER,
    "availability_start_date" TIMESTAMP(3),
    "payload" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disappeared_at" TIMESTAMP(3),
    "detail_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mymrc_dock_availability_mirror_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mymrc_dock_availability_mirror_external_schedule_id_key" ON "mymrc_dock_availability_mirror"("external_schedule_id");
CREATE INDEX "mymrc_dock_availability_mirror_disappeared_at_idx" ON "mymrc_dock_availability_mirror"("disappeared_at");
CREATE INDEX "mymrc_dock_availability_mirror_detail_fetched_at_idx" ON "mymrc_dock_availability_mirror"("detail_fetched_at");

-- ── MyMRC backfill cursors (ADR-0057 D3) — resumable windowed backfill ──
-- Per-(object, list-view) offset/page progress so an interrupted historical
-- backfill resumes from last_page_index instead of restarting. Self-contained (no FKs).
CREATE TABLE "mymrc_backfill_cursors" (
    "id" TEXT NOT NULL,
    "object_api_name" TEXT NOT NULL,
    "list_view_api_name" TEXT NOT NULL DEFAULT '',
    "last_page_index" INTEGER NOT NULL DEFAULT 0,
    "last_record_id" TEXT,
    "total_records_estimated" INTEGER,
    "records_completed" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mymrc_backfill_cursors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "mymrc_backfill_cursors_object_api_name_list_view_api_name_key" ON "mymrc_backfill_cursors"("object_api_name", "list_view_api_name");
CREATE INDEX "mymrc_backfill_cursors_object_api_name_idx" ON "mymrc_backfill_cursors"("object_api_name");
