-- ADR-0049 Amendment 4 (B1) — prior-month grace window.
--
-- Additive only. Every column is nullable or defaulted, so this migration is
-- safe to apply to a running app whose code has not yet been swapped.
--
-- WHY A SECOND WATERMARK RATHER THAN REUSING last_file_*:
-- During the grace window TWO files are in flight for one source — August's and
-- July's. `last_file_ctag` answers "is the file I last parsed unchanged?", and a
-- single slot cannot answer that for two files: the two polls would alternate,
-- each seeing the other's cTag, and each would conclude the file had changed and
-- re-download it every single poll. Worse, a grace read would advance the
-- current-month watermark, so a real August change arriving between two grace
-- polls would be read as "unchanged" and skipped — a change silently dropped.
-- Two files, two watermarks.
ALTER TABLE "workbook_sources"
  ADD COLUMN IF NOT EXISTS "grace_file_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "grace_file_name" TEXT,
  ADD COLUMN IF NOT EXISTS "grace_file_ctag" TEXT;

-- Run-ledger provenance. Without `grace_window` a July-dated run sitting among
-- August runs is indistinguishable from the A2 stale-month defect the amendment
-- before this one was written to catch.
ALTER TABLE "workbook_sync_runs"
  ADD COLUMN IF NOT EXISTS "grace_window" BOOLEAN NOT NULL DEFAULT false;

-- Days the workbook wanted to change that were left alone because an APPROVED
-- invoice already covers them. Counted, never silently dropped: a non-zero value
-- here means the spreadsheet and a sent invoice now disagree and a human has to
-- decide which is right (the supersede chain exists for exactly this).
ALTER TABLE "workbook_sync_runs"
  ADD COLUMN IF NOT EXISTS "rows_skipped_billed" INTEGER NOT NULL DEFAULT 0;
