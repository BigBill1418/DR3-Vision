-- ADR-0069 Amendment 1 — absorbed trailer-list rows.
--
-- The first document kind whose parsed values become typed, queryable Vision
-- data: real columns, not a shape blob.
--
-- SINGLE-WRITER RULE: written ONLY by the doc-ingest absorption bridge. This is
-- reference data. It never overwrites an operational table, and no operational
-- read depends on it — `processed_units_daily` (workbook-sync),
-- `site_inventory_snapshots` and the loads tables keep their existing sole
-- writers untouched.
--
-- TEXT ids throughout, per the house rule.

CREATE TABLE IF NOT EXISTS "doc_trailer_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,
  -- NULL is UNCLASSIFIED, never a guess. Absorption refuses a NULL-site source
  -- before it reaches this table, so a NULL here would mean a bug, not "both".
  "site_id"               TEXT,

  "sheet_name" TEXT NOT NULL,
  "row_index"  INTEGER NOT NULL,

  "entry_date"   DATE,
  "trailer_no"   TEXT NOT NULL,
  "material_raw" TEXT,

  -- NULL means the sheet recorded no weight. It must never be 0 for a blank or a
  -- "-": 19 of the live file's 96 rows have no weight, and zeroing them would
  -- invent nineteen trailers weighing nothing and drag every average down.
  "weight_lbs" DECIMAL(10,1),
  "weight_raw" TEXT,

  "driver"             TEXT,
  -- The SHEET's own formula result. Never recomputed here.
  "days_in_yard_sheet" INTEGER,

  "exit_date" DATE,
  "exit_raw"  TEXT,
  "notes"     TEXT,

  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_trailer_rows_source_fk"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_trailer_rows_version_fk"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_trailer_rows_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL,

  -- A trailer row with no trailer number is not a trailer row. The extractor
  -- skips those (28 spacer rows in the live file); this makes it impossible for a
  -- future writer to disagree.
  CONSTRAINT "doc_trailer_no_not_blank" CHECK (btrim("trailer_no") <> ''),
  -- A negative weight is a data error, not a light trailer.
  CONSTRAINT "doc_trailer_weight_non_negative" CHECK ("weight_lbs" IS NULL OR "weight_lbs" >= 0)
);

-- One row per (version, sheet, sheet-row). Re-absorbing the SAME version
-- replaces rather than duplicates; a NEW version appends a new generation and
-- the previous one stays readable.
CREATE UNIQUE INDEX IF NOT EXISTS "doc_trailer_rows_version_sheet_row_key"
  ON "doc_trailer_rows" ("doc_source_version_id", "sheet_name", "row_index");
CREATE INDEX IF NOT EXISTS "doc_trailer_rows_source_absorbed_idx"
  ON "doc_trailer_rows" ("doc_source_id", "absorbed_at");
CREATE INDEX IF NOT EXISTS "doc_trailer_rows_site_entry_idx"
  ON "doc_trailer_rows" ("site_id", "entry_date");
