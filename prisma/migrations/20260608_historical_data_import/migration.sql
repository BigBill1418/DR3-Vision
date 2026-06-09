-- DR3-Vision Sprint 3 — Historical Data Import (ADR-0023)
-- Migration: 20260608_historical_data_import
--
-- Schema changes to support importing the historical bonus spreadsheet
-- (Jan 2025 → June 2026). Pure DDL — no data movement. Data lands via the
-- seed CSVs under prisma/seed/historical/.
--
-- Design locks honored: Q1 dual-total, Q4 historical_imported state,
-- Q6 Decimal(5,1) mattress_count, Q8 new transitions, Q17 provenance,
-- Q18 decimal UI going forward, Q21 hybrid schema-migration + seed-CSV.

-- ─────────────────────────────────────────────────────────────────────
-- 1. New terminal state on the bonus pay-period state machine (Q4).
-- ─────────────────────────────────────────────────────────────────────
-- IMPORTANT: ALTER TYPE ... ADD VALUE cannot run inside a transaction in
-- some Postgres versions. Prisma migrate handles this by running the
-- ALTER TYPE outside of any wrapping transaction.
ALTER TYPE "BonusPayPeriodState" ADD VALUE IF NOT EXISTS 'historical_imported';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Dual-total storage on bonus_pay_periods (Q1).
-- legacy_total_payout_cents = sum of as-paid spreadsheet Total cells
-- total_payout_cents (existing) = sum of corrected-formula calculator outputs
-- imported_with_legacy_formula = true means legacy column is the canonical
--   value for this period (PDF and payroll default to it)
-- import_session_id = back-reference to bonus_imports for forensics
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "bonus_pay_periods"
  ADD COLUMN IF NOT EXISTS "legacy_total_payout_cents"    INTEGER,
  ADD COLUMN IF NOT EXISTS "imported_with_legacy_formula" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "import_session_id"            TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Decimal mattress_count (Q6 anomaly + Q18 going-forward UI).
-- The historical Eugene spreadsheet has 23.5 / 30.5 half-shift values;
-- the schema needs to preserve them. Production UI accepts up to one
-- decimal place going forward at both sites (Q18).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "bonus_daily_entries"
  ALTER COLUMN "mattress_count" TYPE DECIMAL(5,1)
  USING "mattress_count"::DECIMAL(5,1);

-- ─────────────────────────────────────────────────────────────────────
-- 4. Provenance fields on bonus_daily_entries (Q17 max forensic granularity).
-- legacy_total_cents       — as-paid dollar amount from spreadsheet Total cell
-- import_session_id        — back-reference to bonus_imports
-- import_provenance        — full per-row provenance JSON (sheet name, row
--                            index, column letter, raw values, formula version,
--                            original_site_code preserves Stockton-fold history)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "bonus_daily_entries"
  ADD COLUMN IF NOT EXISTS "legacy_total_cents"  INTEGER,
  ADD COLUMN IF NOT EXISTS "import_session_id"   TEXT,
  ADD COLUMN IF NOT EXISTS "import_provenance"   JSONB;

-- Indexes for forensic lookups by import session (sparse — only ~5k rows
-- in a >100k-row table eventually, so partial indexes are efficient).
CREATE INDEX IF NOT EXISTS "bonus_daily_entries_import_session_id_idx"
  ON "bonus_daily_entries"("import_session_id")
  WHERE "import_session_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "bonus_pay_periods_import_session_id_idx"
  ON "bonus_pay_periods"("import_session_id")
  WHERE "import_session_id" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 5. New table: bonus_imports — import session tracking (Q5 SHA-256 +
--    Q19 source-file archive metadata).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bonus_imports" (
  "id"                        TEXT        PRIMARY KEY,
  "source_filename"           TEXT        NOT NULL,
  "source_sha256"             TEXT        NOT NULL UNIQUE,
  "source_archive_path"       TEXT,       -- repo-relative path; R2 key once Q19 archive ticket lands
  "imported_by_user_id"       TEXT        NOT NULL,
  "imported_at"               TIMESTAMP   NOT NULL DEFAULT NOW(),
  "total_entries"             INTEGER     NOT NULL,
  "total_mattress_count"      DECIMAL(10,1) NOT NULL,
  "total_legacy_dollars"      DECIMAL(12,2) NOT NULL,
  "stockton_origin_entries"   INTEGER     NOT NULL DEFAULT 0,
  "stockton_origin_dollars"   DECIMAL(12,2) NOT NULL DEFAULT 0,
  "anomaly_count"             INTEGER     NOT NULL DEFAULT 0,
  "auto_sum_count"            INTEGER     NOT NULL DEFAULT 0,
  "reconciliation_json"       JSONB,      -- full reconciliation report (anomalies, sheets, totals)
  "notes"                     TEXT,
  CONSTRAINT "bonus_imports_imported_by_fk"
    FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "bonus_imports_imported_at_idx"
  ON "bonus_imports"("imported_at");

-- ─────────────────────────────────────────────────────────────────────
-- 6. bonus_employee_aliases — variant name → canonical mappings (Q2).
-- Recorded at import time. Used for analytics / forensic name resolution
-- (e.g. exporting a historical entry that originally said "MK Mossey" to
-- show as "Mohammad Khan").
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "bonus_employee_aliases" (
  "id"                        TEXT        PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  "variant_name"              TEXT        NOT NULL,
  "canonical_employee_id"     TEXT        NOT NULL,
  "import_session_id"         TEXT,
  "created_at"                TIMESTAMP   NOT NULL DEFAULT NOW(),
  CONSTRAINT "bonus_employee_aliases_canonical_fk"
    FOREIGN KEY ("canonical_employee_id") REFERENCES "bonus_employees"("id"),
  CONSTRAINT "bonus_employee_aliases_unique"
    UNIQUE ("variant_name", "canonical_employee_id")
);

CREATE INDEX IF NOT EXISTS "bonus_employee_aliases_canonical_id_idx"
  ON "bonus_employee_aliases"("canonical_employee_id");

CREATE INDEX IF NOT EXISTS "bonus_employee_aliases_variant_idx"
  ON "bonus_employee_aliases"("variant_name");

-- ─────────────────────────────────────────────────────────────────────
-- End migration. Data is loaded by `prisma/seed.mjs` via the historical
-- seed CSVs in `prisma/seed/historical/` per ADR-0023.
-- ─────────────────────────────────────────────────────────────────────
