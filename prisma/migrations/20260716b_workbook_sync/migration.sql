-- ADR-0049 — Woodland workbook → Vision sync bridge.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Adds:
--   - one `RolloutSurfaceKind` enum value (`workbook_sync`) — used only at RUNTIME
--     by the rollout-surface seed step, never referenced in THIS migration, so the
--     Postgres "unsafe use of a freshly-added enum value in the same transaction"
--     rule never applies (same idiom as 20260713_rollout_gate's
--     `bootstrap_suppression` cause);
--   - two enums + two tables for the sync bridge:
--       * `workbook_sources` — one syncing source per site (born is_syncing=false);
--       * `workbook_sync_runs` — the mymrc_sync_runs-shape run ledger.
--
-- FK columns on the new tables are declared as PLAIN SCALARS in schema.prisma
-- (repo convention, mirrors rollout_surfaces / yard_trailers) so the block never
-- edits the shared Site relation list; the referential-integrity constraints are
-- created here at the DB level. `workbook_sources.created_by` / `updated_by` are
-- bare audit-actor columns with NO FK (mirrors `alert_recipients.created_by`).
--
-- The dir name `20260716b_workbook_sync` sorts AFTER the current main chain tip
-- (`20260715b_rollup_ap_boardpack_yard`) and after the sibling AP `20260716_*`,
-- preserving ADR-0035 lexical migration ordering.

-- ─────────────────────────────────────────────────────────────────────────
-- Enum extension — rollout-surface kind (the sync/cutover surface)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TYPE "RolloutSurfaceKind" ADD VALUE 'workbook_sync';

-- ─────────────────────────────────────────────────────────────────────────
-- Sync-bridge enums
-- ─────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "WorkbookSyncTransportMode" AS ENUM ('mock', 'graph');

-- CreateEnum
CREATE TYPE "WorkbookSyncStatus" AS ENUM ('ok', 'forbidden', 'not_found', 'error');

-- ─────────────────────────────────────────────────────────────────────────
-- workbook_sources — one syncing source per site (D9), born disabled
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "workbook_sources" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "drive_upn" TEXT NOT NULL,
    "folder_path" TEXT NOT NULL DEFAULT '',
    "share_url" TEXT,
    "naming_pattern" TEXT NOT NULL DEFAULT '{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm',
    "is_syncing" BOOLEAN NOT NULL DEFAULT false,
    "last_polled_at" TIMESTAMP(3),
    "last_file_id" TEXT,
    "last_file_name" TEXT,
    "last_file_ctag" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workbook_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workbook_sources_site_id_key" ON "workbook_sources"("site_id");

ALTER TABLE "workbook_sources"
    ADD CONSTRAINT "workbook_sources_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- workbook_sync_runs — mymrc_sync_runs-shape ledger (ALWAYS written)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "workbook_sync_runs" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" "WorkbookSyncStatus" NOT NULL,
    "transport_mode" "WorkbookSyncTransportMode" NOT NULL,
    "file_name" TEXT,
    "changes_detected" BOOLEAN NOT NULL DEFAULT false,
    "rows_upserted" INTEGER NOT NULL DEFAULT 0,
    "rows_skipped_midedit" INTEGER NOT NULL DEFAULT 0,
    "rows_overwritten" INTEGER NOT NULL DEFAULT 0,
    "cutover_noop" BOOLEAN NOT NULL DEFAULT false,
    "error_text" TEXT,
    "run_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workbook_sync_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workbook_sync_runs_source_id_started_at_idx" ON "workbook_sync_runs"("source_id", "started_at");
CREATE INDEX "workbook_sync_runs_status_started_at_idx" ON "workbook_sync_runs"("status", "started_at");

ALTER TABLE "workbook_sync_runs"
    ADD CONSTRAINT "workbook_sync_runs_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "workbook_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
