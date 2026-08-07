-- ADR-0080 — discovery reachability + commodity audit-coverage absorption.
--
-- ── Why this migration exists (Phase 1) ────────────────────────────────────
-- Discovery was the one layer of the document pipeline with no staleness guard.
-- `GET /me/drive/sharedWithMe` returned ONE item on each of the 902 sweeps
-- between 2026-07-29 and 2026-08-07, and no surface compared that answer against
-- anything, so "Vision can see one document" and "one document exists" were
-- indistinguishable. Measured against the live tenant on 2026-08-07: Vision could
-- READ 11 documents inside its own document universe and was WATCHING 3.
--
-- The two tables below record that comparison. They are a REPORT, not a queue:
-- nothing in the code promotes a reachable item into `doc_sources`. The probe
-- runs on `POST /search/query`, which returns everything the signed-in identity
-- can READ rather than everything shared WITH it — and this identity holds
-- `Sites.Read.All`, so the unscoped answer is 11,442 items including Night
-- Shelter case-management files and HR W-9 lists. Auto-adopting that set would be
-- a data-protection incident, not a feature. Registration stays Bill's click.
--
-- ── Why this migration exists (Phase 2) ────────────────────────────────────
-- `doc_commodity_audit_rows` absorbs the "Woodland Data Auditing Tracker".
-- Read against the live bytes on 2026-08-07, that workbook carries NO tonnage and
-- NO money: it is an audit-COVERAGE matrix recording whether each commodity
-- stream's month has been audited against vendor invoices, by whom, and when.
-- So nothing here compares against `processed_units_daily` and nothing here
-- writes it — `src/lib/workbook-sync/` remains its one writer (ADR-0049).
--
-- Postgres limitation: ALTER TYPE ... ADD VALUE cannot run inside the same
-- transaction as a statement that USES the new value. Nothing here does, and
-- Prisma's runner executes each statement separately, so this is safe.

-- AlterEnum: the guard discovery never had.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE 'discovery_gap';

-- CreateTable: one run of the reachable-vs-watched comparison.
CREATE TABLE IF NOT EXISTS "doc_ingest_reachability_scans" (
  "id"         TEXT PRIMARY KEY,
  "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- The EXACT KQL issued, stored rather than re-derived. A historical count read
  -- under a scope that has since been widened or narrowed is not evidence of
  -- anything, so the bound travels with the number it produced.
  "scope_query" TEXT NOT NULL,

  "reachable_count" INTEGER NOT NULL,
  "watched_count"   INTEGER NOT NULL,
  "gap_count"       INTEGER NOT NULL,

  -- Graph still had results when the cap was reached, so "gap_count" is a LOWER
  -- BOUND. An under-stated gap presented as complete is the exact failure this
  -- table exists to end.
  "truncated" BOOLEAN NOT NULL DEFAULT false,

  -- Non-null when the probe could not run. A failed scan is NOT a gap of zero:
  -- "we could not look" and "there is nothing to see" must never render alike.
  "error" TEXT
);

CREATE INDEX IF NOT EXISTS "doc_ingest_reachability_scans_scanned_at_idx"
  ON "doc_ingest_reachability_scans" ("scanned_at");

-- CreateTable: a document Vision could READ but was not WATCHING, at one scan.
CREATE TABLE IF NOT EXISTS "doc_ingest_reachable_items" (
  "id"      TEXT PRIMARY KEY,
  "scan_id" TEXT NOT NULL,

  -- The D8 identity pair — the same key `doc_sources` uses, so the comparison is
  -- made on identity and never on a display name (two people sharing one
  -- workbook are not two documents; a rename is not a new one).
  "drive_id" TEXT NOT NULL,
  "item_id"  TEXT NOT NULL,

  "name"       TEXT NOT NULL,
  "web_url"    TEXT,
  "owner_hint" TEXT,

  "last_modified_at" TIMESTAMP(3),
  "size_bytes"       INTEGER,

  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_ingest_reachable_items_scan_id_fkey"
    FOREIGN KEY ("scan_id") REFERENCES "doc_ingest_reachability_scans"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_ingest_reachable_items_scan_drive_item_key"
  ON "doc_ingest_reachable_items" ("scan_id", "drive_id", "item_id");
CREATE INDEX IF NOT EXISTS "doc_ingest_reachable_items_scan_id_idx"
  ON "doc_ingest_reachable_items" ("scan_id");

-- CreateTable: one (commodity stream x month) audit-coverage cell.
CREATE TABLE IF NOT EXISTS "doc_commodity_audit_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,

  -- NULL is UNCLASSIFIED, never a guess. Absorption refuses a NULL-site source
  -- before it reaches this table, so a NULL here would mean a bug, not "both".
  "site_id" TEXT,

  "sheet_name" TEXT NOT NULL,
  -- The sheet's own banner year. NULL when unreadable — never inferred from the
  -- ingest date, which would silently file 2025 rows under 2026.
  "sheet_year" INTEGER,

  "stream_group" TEXT NOT NULL,
  "stream_label" TEXT NOT NULL,

  -- VERBATIM as the sheet wrote it ("Sept", "March"). The real file is
  -- inconsistent and normalising would quietly merge two distinct columns.
  "month_label"  TEXT NOT NULL,
  -- 1-12, or NULL when the label was not recognised. Never guessed.
  "month_number" INTEGER,

  -- NULL = NOT RECORDED (the cell was empty). Never coerced to false: an
  -- un-filled checkbox and a deliberate "not audited" are different claims, and
  -- collapsing them is the same defect class as a NULL cost summing to $0.00.
  "audited"        BOOLEAN,
  "initials"       TEXT,
  "audit_date"     TIMESTAMP(3),
  -- ALWAYS what the cell said. The live file carries the literal "working" in
  -- three Date cells; rendering that as a date would invent an audit that has
  -- explicitly not happened.
  "audit_date_raw" TEXT,

  "second_audit"          BOOLEAN,
  "second_initials"       TEXT,
  "second_audit_date"     TIMESTAMP(3),
  "second_audit_date_raw" TEXT,

  "row_index" INTEGER NOT NULL,
  "status"    "DocAbsorptionStatus" NOT NULL DEFAULT 'staged',

  "confirmed_at"   TIMESTAMP(3),
  "confirmed_by"   TEXT,
  "discarded_at"   TIMESTAMP(3),
  "discarded_by"   TEXT,
  "discard_reason" TEXT,

  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_commodity_audit_rows_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_commodity_audit_rows_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_commodity_audit_rows_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL
);

-- VERSION-SCOPED from the first row (the ADR-0077 lesson). The key is
-- (version, sheet, stream, month), so two confirmed revisions of one workbook
-- coexist, each a COMPLETE copy. Any read that aggregates must pin the winning
-- revision first — summing every confirmed row across revisions is precisely how
-- the TEREX ledger reported $231,203.82 for a $77,067.94 document.
CREATE UNIQUE INDEX IF NOT EXISTS "doc_commodity_audit_rows_version_sheet_stream_month_key"
  ON "doc_commodity_audit_rows" ("doc_source_version_id", "sheet_name", "stream_label", "month_label");
CREATE INDEX IF NOT EXISTS "doc_commodity_audit_rows_source_status_idx"
  ON "doc_commodity_audit_rows" ("doc_source_id", "status");
CREATE INDEX IF NOT EXISTS "doc_commodity_audit_rows_site_year_idx"
  ON "doc_commodity_audit_rows" ("site_id", "sheet_year");
