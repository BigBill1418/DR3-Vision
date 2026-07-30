-- ADR-0069 — the document-ingestion ABSORPTION BRIDGE.
--
-- WHY: the 2026-07-30 audit found that shared-document ingestion CAPTURES but does
-- not ABSORB. A document terminates at one `file_drops` row with status 'received';
-- no parsed value from any ingested document reaches a queryable table, a report, or
-- a comparison against Vision's own numbers. `parse_summary` cannot close that gap —
-- it stores SHAPE (sheet names, a header guess, row counts, per-header sums) and
-- deliberately retains no cell values, so the only place a revision's content exists
-- is the archived R2 object.
--
-- ── THE ONE-WRITER RULE (the architectural constraint this migration encodes) ──
-- `src/lib/workbook-sync/` (ADR-0049) is the system of record for
-- `processed_units_daily`. Doc-ingest MUST NEVER write that table. This migration
-- therefore creates a SEPARATE, explicitly-reference table. There is no source
-- discriminator that would let both pipelines write one table, and there is no
-- "upsert when workbook-sync hasn't" fallback — either of those is a second writer
-- wearing a disguise, and a second writer is how the June production figures would
-- silently diverge from the paper record.
--
-- What `doc_reference_rows` IS: the spreadsheet's own claim about a day, recorded
-- with full provenance (which document, which revision, which sheet, which row).
-- What it is NOT: an operational figure. Nothing computes payroll, billing, bonus,
-- or inventory from it. Its only consumer is the reconciliation read
-- (`src/lib/doc-ingest/reconciliation.ts`), which compares it against
-- `processed_units_daily` and reports agreement / disagreement / coverage.
--
-- That comparison is the MEASURING DEVICE for the migration Bill described: when a
-- site's deltas are persistently zero, that site's spreadsheet is retirable. Without
-- it, "has Vision taken this over yet?" has no answer that is not a guess.
--
-- ── The absorption ledger on `doc_source_versions` ────────────────────────────
-- Four additive columns record what absorption DID for each revision, including
-- when it refused. The whole failure history of this module is silent zeroes — a
-- null ctag read as "unchanged", a missing baseline read as "no variance", a failed
-- archive read as "applied". "This revision produced no reference rows" must be a
-- readable fact with a reason attached, not an absence.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty PG16
-- in CI). One new table, one new enum, two new enum VALUES on an existing type, four
-- nullable/defaulted columns on an existing table. No existing object is altered in
-- a way that could fail on populated data.
--
-- `id` / FK columns are TEXT, never `uuid` — a `uuid`-typed id passes CI (which does
-- not run migrations) and fails only on deploy, taking the app down. House rule.
--
-- PG note: `ALTER TYPE … ADD VALUE` is legal inside a transaction block from PG12 on
-- so long as the new value is not USED in the same transaction. Nothing below
-- inserts a row using one, so this replays cleanly under `prisma migrate deploy`
-- (which wraps each file in a transaction).

-- ─────────────────────────────────────────────────────────────────────────────
-- Anomaly kinds — absorption must FAIL LOUDLY
-- ─────────────────────────────────────────────────────────────────────────────

-- A confirmed `daily_log_workbook` whose `site_id` is NULL. A NULL site is
-- UNCLASSIFIED, never "both" and never a guess (hard rule #2), so absorption
-- REFUSES rather than picking a site — and says so, because a document that
-- silently never absorbs is indistinguishable from one that absorbed nothing.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'absorption_refused';

-- The extractor ran and produced ZERO usable rows. This is the single most
-- important line in this migration. A zero here is NOT "the document was empty" —
-- far more likely it is the daily-row adapter's layout assumption failing against a
-- real workbook (its column mapping is still the fixture's; see ADR-0049 D12). A
-- silent zero would look exactly like success on every surface.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'absorption_empty';

-- ─────────────────────────────────────────────────────────────────────────────
-- The reference metric vocabulary
--
-- Deliberately CLOSED, unlike `doc_sources.doc_class` (which is unconstrained TEXT
-- because the document-class vocabulary is not settled). The invariant that makes
-- the reconciliation total is: EVERY value here names a real column of
-- `processed_units_daily`. A metric with no counterpart column could be extracted
-- but never compared, which would be reference data that cannot answer the only
-- question the table exists to answer.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "DocReferenceMetric" AS ENUM (
    'stripped_program',
    'stripped_non_program',
    'saved_units'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_reference_rows — reference data, never operational data
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_reference_rows" (
  "id"                    TEXT PRIMARY KEY,

  -- Provenance to the document AND to the exact revision. Keeping both means a
  -- reference figure can always be traced to the bytes it came from, and an old
  -- revision's rows stay readable as history after a newer one supersedes them.
  "doc_source_id"         TEXT NOT NULL,
  "doc_source_version_id" TEXT NOT NULL,

  -- NOT NULL, and that is the enforcement of hard rule #2 rather than a
  -- convenience. Absorption refuses an unclassified source; this constraint means
  -- a future code path cannot quietly change its mind and write a guessed site.
  "site_id"               TEXT NOT NULL,

  -- The day the spreadsheet is making a claim about. DATE not timestamp: a
  -- production day is a day, and storing an instant invites a timezone bug in a
  -- Pacific-operating org whose servers run UTC.
  "production_date"       DATE NOT NULL,

  "metric"                "DocReferenceMetric" NOT NULL,
  -- Decimal(12,2) covers every metric in the enum with room to spare
  -- (`processed_units_daily` stores these as Decimal(7,1)). Widening here is
  -- deliberate: reference data records what the SPREADSHEET said, including a value
  -- that would not fit the operational column — a figure Vision would reject is
  -- exactly the kind of discrepancy this table exists to surface.
  "value"                 DECIMAL(12,2) NOT NULL,

  -- Cell-level provenance, so a disagreement can be chased into the workbook
  -- instead of merely being reported.
  "source_sheet"          TEXT,
  "source_row"            INTEGER,

  "extracted_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One value per (revision, day, metric). Re-absorbing a revision is idempotent:
-- the extractor deletes this revision's rows and rewrites them inside one
-- transaction, and this constraint is what makes a concurrent second pass a
-- unique violation rather than a duplicate figure.
CREATE UNIQUE INDEX IF NOT EXISTS "doc_reference_rows_version_date_metric_key"
  ON "doc_reference_rows" ("doc_source_version_id", "production_date", "metric");

-- The reconciliation read's access path: a site over a date range.
CREATE INDEX IF NOT EXISTS "doc_reference_rows_site_date_idx"
  ON "doc_reference_rows" ("site_id", "production_date");

CREATE INDEX IF NOT EXISTS "doc_reference_rows_source_idx"
  ON "doc_reference_rows" ("doc_source_id");

-- ON DELETE CASCADE from the version: reference rows are DERIVED from a revision
-- and have no meaning without it. RESTRICT on the site: a site with reference data
-- is not deletable, which is correct — the data is about that site.
DO $$ BEGIN
  ALTER TABLE "doc_reference_rows"
    ADD CONSTRAINT "doc_reference_rows_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "doc_reference_rows"
    ADD CONSTRAINT "doc_reference_rows_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "doc_reference_rows"
    ADD CONSTRAINT "doc_reference_rows_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The absorption ledger on `doc_source_versions`
--
-- Every column here is nullable, so every existing row is already correct:
-- absorption has never run, and NULL says exactly that.
-- ─────────────────────────────────────────────────────────────────────────────

-- Set when a TERMINAL absorption attempt completed for this revision — absorbed,
-- empty, or unreadable. It is the "do not re-download this revision every 15
-- minutes" latch. It is deliberately NOT set on a REFUSAL, because a refusal is
-- caused by missing operator input (an unconfirmed site) and must re-attempt for
-- free the moment that input arrives.
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "absorbed_at" TIMESTAMP(3);

-- 'absorbed' | 'refused_unclassified_site' | 'empty' | 'unreadable' |
-- 'not_absorbable'. Unconstrained TEXT for the same reason `doc_class` is: the
-- outcome vocabulary will grow as more document kinds become absorbable, and an
-- enum would force a migration each time.
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "absorption_status" TEXT;

-- How many reference rows this revision produced. DEFAULT 0 is truthful for every
-- existing row, and the column is what makes "produced nothing" a number on a
-- screen rather than an absence nobody notices.
ALTER TABLE "doc_source_versions"
  ADD COLUMN IF NOT EXISTS "absorption_rows" INTEGER NOT NULL DEFAULT 0;

-- The human reason absorption did not produce rows. Never credentials, never a
-- stack trace — the operator-actionable sentence.
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "absorption_error" TEXT;

-- The absorption pass's work queue: applied revisions that have not reached a
-- terminal absorption outcome. PARTIAL, so it stays small forever regardless of how
-- many revisions accumulate — Prisma cannot express this, hence migration-only.
CREATE INDEX IF NOT EXISTS "doc_source_versions_absorb_queue_idx"
  ON "doc_source_versions" ("applied_at")
  WHERE "applied_at" IS NOT NULL AND "absorbed_at" IS NULL;
