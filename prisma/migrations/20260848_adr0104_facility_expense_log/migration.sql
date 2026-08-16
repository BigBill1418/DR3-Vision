-- ADR-0104 §D4 — absorbed FACILITY EXPENSE rows.
--
-- "Woodland Invoices tracking.xlsx" is a hand-kept desk log of expenses already
-- paid. Measured against the live bytes 2026-08-16: WOODLAND 2026 holds 138
-- rows totalling $430,606.74 and WOODLAND 2025 holds 194 totalling $544,321.62
-- with $104,241.82 of credits.
--
-- ── NOT `invoices` (ADR-0041) ──────────────────────────────────────────────
-- That table carries an immutable-version discipline, a lifecycle state machine
-- and delivery planning. This document has no invoice lifecycle — everything in
-- it is already paid — and writing it there would manufacture payable-looking
-- records that were never payables.
--
-- ── Stockton is refused, per sheet ─────────────────────────────────────────
-- `STOCKTON 2025` and `STOCKTON 2026` are refused with the named reason
-- `site_not_registered`. Stockton is not a row in `sites`, and hard rule #2 says
-- a NULL site never reaches a site-scoped surface. Refusing two sheets does not
-- sink the document — that per-sheet refusal discipline is `commodity-extract`'s
-- and it is reused here.
--
-- ── What the `Invoice Date` column actually holds ──────────────────────────
-- NOT dates. Measured: 0 of 332 absorbed rows carry a real date. The column
-- holds DAY-OF-MONTH numbers (5, 6, 12, 27) and the month lives in banner rows
-- written into the sheet body ("February"). So `invoice_date` stays NULL unless
-- the cell itself held a date, and the banner and the day are stored SEPARATELY
-- rather than composed into a date the sheet never wrote. See ADR-0104 §D4
-- amendment in `docs/plans/2026-08-15-full-document-absorption-build.md` §10.

CREATE TABLE IF NOT EXISTS "doc_facility_expense_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,
  "site_id"               TEXT,

  "sheet_name" TEXT NOT NULL,
  -- The sheet's own banner year, from the sheet NAME ("WOODLAND 2026" -> 2026).
  "sheet_year" INTEGER,
  "row_index"  INTEGER NOT NULL,

  "present_on_daily_log" TEXT,
  -- Header differs by sheet: `desk receipt` on three, `receipt date` on
  -- STOCKTON 2025.
  "receipt_raw"          TEXT,

  -- Set ONLY when the cell itself held a real date — 0 rows on both Woodland
  -- sheets. See the header.
  "invoice_date"        DATE,
  -- ALWAYS what the cell said ("5").
  "invoice_date_raw"    TEXT,
  -- The forward-filled month BANNER above this row, verbatim ("February").
  -- NULL for rows above the first banner (25 of 138 on WOODLAND 2026, 15 of 194
  -- on WOODLAND 2025) — inferring "January" from position would be a guess.
  "invoice_month_label" TEXT,
  -- 1-31 when the Invoice Date cell held a plain day number, else NULL.
  "invoice_day"         INTEGER,

  -- NULL when the cell was blank. NEVER 0 — an expense with no recorded amount
  -- is not a free expense (the ADR-0069 Am.2 rule for `actual_repair_cost`).
  "amount"        DECIMAL(12,2),
  "credit_amount" DECIMAL(12,2),

  -- VERBATIM. 15 and 17 distinct values including case variants of one category
  -- ("Transportation"/"transportation", "Diesel"/"diesel").
  "category_raw"  TEXT,
  -- Trimmed + lower-cased, for grouping. A CONVENIENCE, not a taxonomy —
  -- nobody has agreed a taxonomy.
  "category_norm" TEXT,

  "invoice_number" TEXT,
  "notes"          TEXT,
  "machine_id_raw" TEXT,
  "day_raw"        TEXT,

  -- VERBATIM. Overloaded: real commodities ("wood", "trash", "pocket coils")
  -- and 6 H-haul references, all on WOODLAND 2026.
  "commodity_raw" TEXT,
  -- Set ONLY when `commodity_raw` matches ^H-?[0-9]+.
  "haul_ref"      TEXT,
  -- Present only on WOODLAND 2026 (9 rows).
  "gallons"       DECIMAL(10,2),

  "status" "DocAbsorptionStatus" NOT NULL DEFAULT 'staged',

  "confirmed_at"   TIMESTAMP(3),
  "confirmed_by"   TEXT,
  "discarded_at"   TIMESTAMP(3),
  "discarded_by"   TEXT,
  "discard_reason" TEXT,

  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_facility_expense_rows_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_facility_expense_rows_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_facility_expense_rows_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL
);

-- VERSION-SCOPED from the first row (ADR-0080 §D8). Two confirmed revisions of
-- one workbook coexist, each a COMPLETE copy; any read that aggregates must pin
-- the winning revision first.
CREATE UNIQUE INDEX IF NOT EXISTS "doc_facility_expense_rows_version_sheet_row_key"
  ON "doc_facility_expense_rows" ("doc_source_version_id", "sheet_name", "row_index");
CREATE INDEX IF NOT EXISTS "doc_facility_expense_rows_source_status_idx"
  ON "doc_facility_expense_rows" ("doc_source_id", "status");
CREATE INDEX IF NOT EXISTS "doc_facility_expense_rows_site_date_idx"
  ON "doc_facility_expense_rows" ("site_id", "invoice_date");
