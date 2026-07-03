-- ADR-0038 — MyMRC ingestion rebuild: raw mirror tables + run ledger.
--
-- Additive only (ADR-0035 gate): four new tables + one enum, no changes to any
-- existing table. Named `20260704_mymrc_mirrors` to sort AFTER ADR-0037's
-- `20260703b_loads_inventory_foundations` per the ADR-0035 lexical ordering rule.
--
-- Mirrors are audit-evidence tables (ADR-0039 3-way audit leg), NOT operational
-- tables. `id` = Salesforce record id (portal external id, upsert key). `site_id`
-- is a scalar FK to sites(id) — constraint declared here in SQL; there is no
-- Prisma relation field, to keep the schema block self-contained. All lifecycle
-- columns (first/last_seen_at, disappeared_at, detail_fetched_at) support the
-- ADR-0038 D3 idempotent list→detail two-pass flow.

-- CreateEnum
CREATE TYPE "MymrcSyncStatus" AS ENUM ('ok', 'auth_failed', 'contract_drift', 'error');

-- CreateTable
CREATE TABLE "mymrc_hauls_mirror" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "external_haul_id" TEXT,
    "status" TEXT,
    "rate_id" TEXT,
    "docking_appointment_at" TIMESTAMP(3),
    "door" TEXT,
    "units" INTEGER,
    "weight_lbs" DECIMAL(12,2),
    "retrac_id" TEXT,
    "payload" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disappeared_at" TIMESTAMP(3),
    "detail_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mymrc_hauls_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mymrc_processed_mirror" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "external_materials_id" TEXT,
    "bol_id" TEXT,
    "entry_date" TIMESTAMP(3),
    "processed_date" TIMESTAMP(3),
    "units" INTEGER,
    "weight_lbs" DECIMAL(12,2),
    "retrac_id" TEXT,
    "payload" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disappeared_at" TIMESTAMP(3),
    "detail_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mymrc_processed_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mymrc_outbound_mirror" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "external_materials_id" TEXT,
    "bol_id" TEXT,
    "entry_date" TIMESTAMP(3),
    "shipment_date" TIMESTAMP(3),
    "vendor" TEXT,
    "weight_lbs" DECIMAL(12,2),
    "retrac_id" TEXT,
    "payload" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disappeared_at" TIMESTAMP(3),
    "detail_fetched_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mymrc_outbound_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mymrc_sync_runs" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "MymrcSyncStatus" NOT NULL,
    "rows_listed" INTEGER NOT NULL DEFAULT 0,
    "rows_upserted" INTEGER NOT NULL DEFAULT 0,
    "details_fetched" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mymrc_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mymrc_hauls_mirror_external_haul_id_key" ON "mymrc_hauls_mirror"("external_haul_id");
CREATE INDEX "mymrc_hauls_mirror_site_id_idx" ON "mymrc_hauls_mirror"("site_id");
CREATE INDEX "mymrc_hauls_mirror_disappeared_at_idx" ON "mymrc_hauls_mirror"("disappeared_at");
CREATE INDEX "mymrc_hauls_mirror_detail_fetched_at_idx" ON "mymrc_hauls_mirror"("detail_fetched_at");

CREATE UNIQUE INDEX "mymrc_processed_mirror_external_materials_id_key" ON "mymrc_processed_mirror"("external_materials_id");
CREATE INDEX "mymrc_processed_mirror_site_id_idx" ON "mymrc_processed_mirror"("site_id");
CREATE INDEX "mymrc_processed_mirror_disappeared_at_idx" ON "mymrc_processed_mirror"("disappeared_at");
CREATE INDEX "mymrc_processed_mirror_detail_fetched_at_idx" ON "mymrc_processed_mirror"("detail_fetched_at");

CREATE UNIQUE INDEX "mymrc_outbound_mirror_external_materials_id_key" ON "mymrc_outbound_mirror"("external_materials_id");
CREATE INDEX "mymrc_outbound_mirror_site_id_idx" ON "mymrc_outbound_mirror"("site_id");
CREATE INDEX "mymrc_outbound_mirror_disappeared_at_idx" ON "mymrc_outbound_mirror"("disappeared_at");
CREATE INDEX "mymrc_outbound_mirror_detail_fetched_at_idx" ON "mymrc_outbound_mirror"("detail_fetched_at");

CREATE INDEX "mymrc_sync_runs_site_id_feed_started_at_idx" ON "mymrc_sync_runs"("site_id", "feed", "started_at");
CREATE INDEX "mymrc_sync_runs_feed_status_started_at_idx" ON "mymrc_sync_runs"("feed", "status", "started_at");

-- AddForeignKey (scalar site_id → sites; no Prisma relation field by design)
ALTER TABLE "mymrc_hauls_mirror" ADD CONSTRAINT "mymrc_hauls_mirror_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mymrc_processed_mirror" ADD CONSTRAINT "mymrc_processed_mirror_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mymrc_outbound_mirror" ADD CONSTRAINT "mymrc_outbound_mirror_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mymrc_sync_runs" ADD CONSTRAINT "mymrc_sync_runs_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
