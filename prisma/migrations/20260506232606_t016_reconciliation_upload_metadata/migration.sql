-- Sprint-1 T-016: extend the reconciliation tables to support
--
--   * upload metadata (filename, content_sha256) so re-uploads of
--     the same CSV are idempotent (the (site_id, content_sha256)
--     unique index is the lock that enforces this)
--   * the categorized status taxonomy from docs/MYMRC-INTEGRATION.md
--     §"CSV reconciliation upload" -> match_clean / weight_mismatch /
--     count_mismatch / missing_in_dr3 / missing_in_mymrc
--   * per-row resolution decision (dr3_correct / mymrc_correct /
--     flag_followup) plus its audit trail (resolved_at / resolved_by_id)
--   * by-category counts on the parent for cheap dashboard reads
--   * a snapshot of the weight tolerance percent that was applied at
--     parse time, so a future tolerance change does not retroactively
--     reclassify historical rows
--
-- Production has zero rows in either reconciliation table at the time
-- this migration ships; the NOT NULL columns without defaults are safe
-- here. Re-runs are idempotent at the Prisma migration tracker layer.
--
-- Postgres limitation: ALTER TYPE ... ADD VALUE cannot run inside the
-- same transaction as a CREATE TYPE statement. Prisma's migration
-- runner executes each statement in this file separately, so we DO
-- get separate transactions even though the file reads as one.

-- CreateEnum
CREATE TYPE "ReconciliationResolution" AS ENUM ('unresolved', 'dr3_correct', 'mymrc_correct', 'flag_followup');

-- AlterEnum: T-016 categorized statuses. The legacy values
-- (unmatched_in_dr3, unmatched_in_mymrc, resolved) stay for back-compat
-- with the v0.1 compliance read; the T-016 engine never writes them.
ALTER TYPE "ReconciliationStatus" ADD VALUE 'match_clean';
ALTER TYPE "ReconciliationStatus" ADD VALUE 'missing_in_dr3';
ALTER TYPE "ReconciliationStatus" ADD VALUE 'missing_in_mymrc';

-- AlterTable: per-item DR3-side snapshot, raw CSV source name, resolution.
ALTER TABLE "mymrc_reconciliation_items"
  ADD COLUMN "dr3_unit_count" INTEGER,
  ADD COLUMN "dr3_weight_lbs" INTEGER,
  ADD COLUMN "external_source_name" TEXT,
  ADD COLUMN "resolution" "ReconciliationResolution" NOT NULL DEFAULT 'unresolved';

-- AlterTable: upload metadata + by-category counts + applied tolerance.
ALTER TABLE "mymrc_reconciliations"
  ADD COLUMN "content_sha256" TEXT NOT NULL,
  ADD COLUMN "filename" TEXT NOT NULL,
  ADD COLUMN "weight_tolerance_pct" DECIMAL(5,2) NOT NULL,
  ADD COLUMN "match_clean_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "weight_mismatch_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "count_mismatch_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "missing_in_dr3_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "missing_in_mymrc_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex: per-status filter on the items table for the table view.
CREATE INDEX "mymrc_reconciliation_items_reconciliation_id_status_idx"
  ON "mymrc_reconciliation_items"("reconciliation_id", "status");

-- CreateIndex: idempotency lock — same file at same site collapses to
-- the existing upload session.
CREATE UNIQUE INDEX "mymrc_reconciliations_site_id_content_sha256_key"
  ON "mymrc_reconciliations"("site_id", "content_sha256");
