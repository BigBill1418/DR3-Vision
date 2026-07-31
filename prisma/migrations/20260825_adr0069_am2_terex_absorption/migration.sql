-- ADR-0069 Amendment 2 — absorbed TEREX maintenance rows.
--
-- MONEY-TOUCHING, therefore STAGED: rows land `staged` and a human confirms the
-- batch before it counts. `Estimated cost`, `Actual Repair Cost` and `Amount
-- Credited` are real dollars.
--
-- SINGLE-WRITER RULE: reference data, written only by the absorption bridge.
-- Nothing operational reads it. The workbook's 28 monthly operating tabs are
-- deliberately NOT absorbed — they carry per-day processed units, which
-- `processed_units_daily` owns (sole writer: workbook-sync, ADR-0049).
--
-- TEXT ids throughout, per the house rule.

CREATE TYPE "DocAbsorptionStatus" AS ENUM ('staged', 'confirmed', 'discarded');

CREATE TABLE IF NOT EXISTS "doc_terex_maintenance_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,
  "site_id"               TEXT,

  "sheet_name" TEXT NOT NULL,
  "row_index"  INTEGER NOT NULL,

  -- Set ONLY when the cell held a real date in a plausible range. The live file
  -- contains "09/16 or 17" (the operator did not know which day), "Jan",
  -- "1/14/202601", and one 1900-01-14 Excel epoch artefact whose real date is
  -- written inside the issue text.
  "event_date"     DATE,
  "event_date_raw" TEXT,
  "time_raw"       TEXT,

  "issue"               TEXT,
  "measures_taken"      TEXT,
  "estimated_time_cost" TEXT,
  "notes"               TEXT,

  -- Blank means NOT RECORDED. Never 0 — a repair with no recorded cost is not a
  -- free repair, and zeroing it would understate maintenance spend.
  "estimated_cost"     DECIMAL(12,2),
  "actual_repair_cost" DECIMAL(12,2),
  "amount_credited"    DECIMAL(12,2),

  -- The live workbook's `Maintenance Log 2025` is a strict SUBSET of
  -- `Maintenance Log2026`; both total $77,067.94. Absorbing both without
  -- de-duplication reports $154,135.88 — exactly double.
  "dedup_key" TEXT NOT NULL,

  "status"         "DocAbsorptionStatus" NOT NULL DEFAULT 'staged',
  "confirmed_at"   TIMESTAMP(3),
  "confirmed_by"   TEXT,
  "discarded_at"   TIMESTAMP(3),
  "discarded_by"   TEXT,
  "discard_reason" TEXT,

  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_terex_rows_source_fk"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_terex_rows_version_fk"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_terex_rows_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL,

  -- A terminal state must say who put it there. Money data whose confirmation
  -- cannot answer "who accepted this?" is not an audit trail.
  CONSTRAINT "doc_terex_confirmed_is_attributed"
    CHECK ("status" <> 'confirmed' OR ("confirmed_at" IS NOT NULL AND "confirmed_by" IS NOT NULL)),
  CONSTRAINT "doc_terex_discarded_is_attributed"
    CHECK ("status" <> 'discarded' OR ("discarded_at" IS NOT NULL AND "discarded_by" IS NOT NULL)),
  -- A negative repair cost is a data error, not a refund; credits have their own
  -- column.
  CONSTRAINT "doc_terex_costs_non_negative" CHECK (
    ("estimated_cost"     IS NULL OR "estimated_cost"     >= 0) AND
    ("actual_repair_cost" IS NULL OR "actual_repair_cost" >= 0) AND
    ("amount_credited"    IS NULL OR "amount_credited"    >= 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_terex_rows_version_sheet_row_key"
  ON "doc_terex_maintenance_rows" ("doc_source_version_id", "sheet_name", "row_index");
CREATE INDEX IF NOT EXISTS "doc_terex_rows_source_status_idx"
  ON "doc_terex_maintenance_rows" ("doc_source_id", "status");
CREATE INDEX IF NOT EXISTS "doc_terex_rows_site_event_idx"
  ON "doc_terex_maintenance_rows" ("site_id", "event_date");
