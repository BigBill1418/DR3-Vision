-- ADR-0104 §D2 — absorbed OUTBOUND LOAD rows + their commodity split.
--
-- ── The measurement that made this table ───────────────────────────────────
-- `mymrc_outbound_mirror` holds 4,673 outbound loads spanning 2023-01-02 to
-- 2026-08-14. Every one carries an `external_materials_id`; 4,669 carry a BOL
-- and a shipment date; 4,670 carry a site. `weight_lbs` is NULL on 4,673 of
-- 4,673. Not sparse — zero. The system knows every load left, when, on what BOL
-- and to whose account, and does not know what any of them weighed.
--
-- "Woodland Outbound Auditing 2026.xlsx" carries exactly that figure for 831
-- Woodland loads (Jan–Jun 2026), joinable on `external_materials_id`, which is
-- UNIQUE-indexed on the mirror. This is not a new outbound data source; it is
-- the weight column of a table the system already owns.
--
-- ── REFERENCE, not operational ─────────────────────────────────────────────
-- Nothing here writes `outbound_materials`, `outbound_material_payments`,
-- `outbound_vendors`, `recycling_rates`, `landfilled_units` or `invoices`. All
-- six hold 0 rows and the workbook contains neither a vendor master nor a rate
-- master, so ADR-0055's `recycled_lbs + landfilled_lbs == weight_lbs` invariant
-- could only be satisfied by inventing rates. ADR-0080's rule is that
-- fabricating a record is worse than an empty one. That leg is AK-4b.
-- `processed_units_daily` is untouched: workbook-sync (ADR-0049) is its writer.

-- CreateTable: one shipped load per (version x Materials ID).
CREATE TABLE IF NOT EXISTS "doc_outbound_load_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,

  -- NULL is UNCLASSIFIED, never a guess (hard rule #2). Absorption refuses a
  -- NULL-site source before a row reaches this table, so a NULL here is a bug.
  "site_id" TEXT,

  -- Provenance back to the cell. NOT identity — see the unique index.
  "sheet_name" TEXT NOT NULL,
  "row_index"  INTEGER NOT NULL,

  -- The join key: `Materials: Materials ID`, e.g. "M-160053".
  "external_materials_id" TEXT NOT NULL,
  "bol_id"                TEXT,
  -- The sheet's `Account Name`. ABSENT on both April sheets (headed "Column1"
  -- there), so it is NEVER the source of site. Stored only to assert against.
  "account_name_raw"      TEXT,
  "materials_status"      TEXT,
  "materials_record_type" TEXT,

  "shipment_date"     DATE,
  -- ALWAYS what the cell said. The SAME shipment is an Excel Date on one sheet,
  -- the serial 46055 on its duplicate, and the text "1/2/2026" on a third.
  "shipment_date_raw" TEXT,

  -- From `Total Outbound Weight` — the POSITIVE figure, which reconciles to the
  -- sum of the 13 commodity columns exactly (0 drift on 831 of 831 rows).
  "total_weight_lbs"       DECIMAL(12,2),
  -- From `Total Outbound Materials Weight`, which is its NEGATION. Stored ONLY
  -- so the guardrail can assert the sign relationship and fail loudly if the
  -- workbook's convention changes. NEVER read as a weight — an extractor that
  -- picked this right-most, most official-sounding column would ingest every
  -- weight in the operation with the wrong sign, and because it is internally
  -- consistent nothing downstream would look wrong until a total met reality.
  "total_weight_check_lbs" DECIMAL(12,2),

  -- NULL when the sheet recorded nothing. Never 0 for a blank.
  "program_units"     INTEGER,
  "non_program_units" INTEGER,

  "status" "DocAbsorptionStatus" NOT NULL DEFAULT 'staged',

  "confirmed_at"   TIMESTAMP(3),
  "confirmed_by"   TEXT,
  "discarded_at"   TIMESTAMP(3),
  "discarded_by"   TEXT,
  "discard_reason" TEXT,

  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_outbound_load_rows_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_outbound_load_rows_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_outbound_load_rows_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL
);

-- THE DEDUP MECHANISM, in the schema. The key is (version, Materials ID) and
-- NOT (version, sheet, row_index): the workbook has four sheet pairs that are
-- EXACT duplicates of one another plus one filtered subset sheet, so 556 of
-- 1,387 candidate rows are the same load a second time. Keying on the load
-- makes the collision impossible rather than merely unlikely.
--
-- It is also VERSION-SCOPED from the first row (ADR-0080 §D8): N confirmed
-- revisions coexist, each a COMPLETE copy, so every read pins one revision
-- before it aggregates. Summing across revisions is how the TEREX ledger
-- reported $231,203.82 for a $77,067.94 document (ADR-0077).
CREATE UNIQUE INDEX IF NOT EXISTS "doc_outbound_load_rows_version_matid_key"
  ON "doc_outbound_load_rows" ("doc_source_version_id", "external_materials_id");
CREATE INDEX IF NOT EXISTS "doc_outbound_load_rows_source_status_idx"
  ON "doc_outbound_load_rows" ("doc_source_id", "status");
CREATE INDEX IF NOT EXISTS "doc_outbound_load_rows_site_ship_idx"
  ON "doc_outbound_load_rows" ("site_id", "shipment_date");
-- The join to `mymrc_outbound_mirror.external_materials_id`.
CREATE INDEX IF NOT EXISTS "doc_outbound_load_rows_matid_idx"
  ON "doc_outbound_load_rows" ("external_materials_id");

-- CreateTable: one (load x commodity) weight.
--
-- A 26-column-wide parent would encode the commodity vocabulary in the SCHEMA,
-- where adding a commodity becomes a migration. The vocabulary is data.
CREATE TABLE IF NOT EXISTS "doc_outbound_commodity_rows" (
  "id"                    TEXT PRIMARY KEY,
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,
  "site_id"               TEXT,

  "external_materials_id" TEXT NOT NULL,
  -- VERBATIM column stem: "Foam", "Shoddy/Felt", "Whole Mattresses and
  -- Foundations". Not normalised.
  "commodity"             TEXT NOT NULL,
  -- A recorded 0 is KEPT as 0. The export writes 0 for a commodity this load
  -- did not carry, and turning that into "not recorded" would be the inverse of
  -- the blank-is-not-zero rule.
  "weight_lbs"            DECIMAL(12,2),
  -- Live vocabulary measured 2026-08-16 is FIVE values: Recycling, Landfill,
  -- Biomass, Renovation, and the case variant "landfill". Stored verbatim,
  -- NEVER mapped — mapping "Landfill" onto `landfilled_units` semantics is the
  -- operational write ADR-0104 §D1 forbids.
  "disposition"           TEXT,

  "sheet_name" TEXT NOT NULL,
  "row_index"  INTEGER NOT NULL,

  -- Mirrors the parent's, flipped by the same decide call in the same
  -- transaction. A child that could outlive its parent's decision would let a
  -- discarded batch's weights stay readable.
  "status"      "DocAbsorptionStatus" NOT NULL DEFAULT 'staged',
  "absorbed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "doc_outbound_commodity_rows_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_outbound_commodity_rows_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "doc_outbound_commodity_rows_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_outbound_commodity_rows_version_matid_commodity_key"
  ON "doc_outbound_commodity_rows" ("doc_source_version_id", "external_materials_id", "commodity");
CREATE INDEX IF NOT EXISTS "doc_outbound_commodity_rows_source_status_idx"
  ON "doc_outbound_commodity_rows" ("doc_source_id", "status");
CREATE INDEX IF NOT EXISTS "doc_outbound_commodity_rows_site_commodity_idx"
  ON "doc_outbound_commodity_rows" ("site_id", "commodity");
