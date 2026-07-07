-- ADR-0048 — June operational backfill + Terex history import.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Two new tables + one nullable `import_id` column on each of the seven
-- operational tables that can be promoted from staging. No data movement — the
-- promotion itself runs at the application layer (src/lib/audit/workbook-promotion.ts),
-- idempotently and audited, once Bill supplies the workbook files.
--
-- The dir name `20260714_june_backfill` sorts AFTER the current main chain tip
-- (`20260712_ap_approvals`) and after the parallel ADR-0047 `20260713_` — ADR-0035
-- lexical migration ordering preserved.
--
-- FK columns to sibling-owned models (`workbook_promotions.import_id` →
-- `workbook_imports`, actor columns, `equipment_history_imports.site_id`) carry
-- DB-level FOREIGN KEY constraints here rather than Prisma relations, so the
-- ADR-0048 schema block stays self-contained (no back-relation field on any
-- shared model). Mirrors `equipment_events` / `alert_recipients`.

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Provenance columns on the seven promotable operational tables.
--    Bare nullable TEXT — a promoted row is traceable to its promotion, and the
--    idempotency/conflict checks are cheap. NULL for every hand-entered row.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "site_inventory_snapshots" ADD COLUMN "import_id" TEXT;
ALTER TABLE "inbound_loads"            ADD COLUMN "import_id" TEXT;
ALTER TABLE "consumer_dropoffs"        ADD COLUMN "import_id" TEXT;
ALTER TABLE "outbound_materials"       ADD COLUMN "import_id" TEXT;
ALTER TABLE "landfilled_units"         ADD COLUMN "import_id" TEXT;
ALTER TABLE "processed_units_daily"    ADD COLUMN "import_id" TEXT;
ALTER TABLE "equipment_events"         ADD COLUMN "import_id" TEXT;

-- Sparse partial indexes: only promoted rows carry an import_id, so a partial
-- index over the promoted subset stays tiny while making "rows for this import"
-- (re-run detection, forensics) an index hit.
CREATE INDEX "site_inventory_snapshots_import_id_idx" ON "site_inventory_snapshots"("import_id") WHERE "import_id" IS NOT NULL;
CREATE INDEX "inbound_loads_import_id_idx"            ON "inbound_loads"("import_id")            WHERE "import_id" IS NOT NULL;
CREATE INDEX "consumer_dropoffs_import_id_idx"        ON "consumer_dropoffs"("import_id")        WHERE "import_id" IS NOT NULL;
CREATE INDEX "outbound_materials_import_id_idx"       ON "outbound_materials"("import_id")       WHERE "import_id" IS NOT NULL;
CREATE INDEX "landfilled_units_import_id_idx"         ON "landfilled_units"("import_id")         WHERE "import_id" IS NOT NULL;
CREATE INDEX "processed_units_daily_import_id_idx"    ON "processed_units_daily"("import_id")    WHERE "import_id" IS NOT NULL;
CREATE INDEX "equipment_events_import_id_idx"         ON "equipment_events"("import_id")         WHERE "import_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. workbook_promotions — the promotion ledger (D1/D2).
--    `import_id` UNIQUE == the re-run no-op guard (one promotion per import).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "workbook_promotions" (
    "id"                     TEXT NOT NULL,
    "import_id"              TEXT NOT NULL,
    "scope"                  JSONB NOT NULL,
    "sha256"                 TEXT NOT NULL,
    "promoted_by"            TEXT NOT NULL,
    "promoted_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "counts"                 JSONB NOT NULL,
    "computed_close_program" DECIMAL(10,1),
    "computed_close_total"   DECIMAL(10,1),
    "notes"                  TEXT,
    "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_promotions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workbook_promotions_import_id_key" ON "workbook_promotions"("import_id");

ALTER TABLE "workbook_promotions"
    ADD CONSTRAINT "workbook_promotions_import_id_fkey"
    FOREIGN KEY ("import_id") REFERENCES "workbook_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "workbook_promotions"
    ADD CONSTRAINT "workbook_promotions_promoted_by_fkey"
    FOREIGN KEY ("promoted_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. equipment_history_imports — Terex upload batch ledger (D3).
--    `source_sha256` UNIQUE == the re-run no-op guard (one batch per file).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "equipment_history_imports" (
    "id"                TEXT NOT NULL,
    "site_id"           TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "source_sha256"     TEXT NOT NULL,
    "storage_key"       TEXT,
    "imported_by"       TEXT NOT NULL,
    "imported_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "events_created"    INTEGER NOT NULL DEFAULT 0,
    "events_skipped"    INTEGER NOT NULL DEFAULT 0,
    "rows_parsed"       INTEGER NOT NULL DEFAULT 0,
    "header_mapping"    JSONB,
    "notes"             TEXT,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_history_imports_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "equipment_history_imports_source_sha256_key" ON "equipment_history_imports"("source_sha256");
CREATE INDEX "equipment_history_imports_site_id_imported_at_idx" ON "equipment_history_imports"("site_id", "imported_at");

ALTER TABLE "equipment_history_imports"
    ADD CONSTRAINT "equipment_history_imports_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_history_imports"
    ADD CONSTRAINT "equipment_history_imports_imported_by_fkey"
    FOREIGN KEY ("imported_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
