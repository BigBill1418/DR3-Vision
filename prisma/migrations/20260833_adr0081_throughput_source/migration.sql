-- ADR-0081 — where a throughput day CAME FROM, and who is allowed to overwrite whom.
--
-- Bill's directive, verbatim: "use the excel sheet to pull in the historical data
-- - then STARTING TODAY you will just take in the data that JT enters here but
-- ALL OF THAT DATA needs to be aggregated and displayed IN THIS PAGE."
--
-- Two facts have to survive that sentence, and one column each is the whole
-- design:
--
--   `source`            — is this day the machine's own sheet history, or a
--                         person's entry? The page draws them differently
--                         (ADR-0081 D4) and the import is only ever allowed to
--                         touch its own.
--   `import_version_id` — WHICH revision of the workbook produced it. Without
--                         this, a re-import cannot tell "already done" from
--                         "the file changed", and the only options left are
--                         additive duplication or blowing away the table.
--
-- ── WHY A COLUMN AND NOT A SIBLING TABLE (ADR-0081 D2) ─────────────────────
-- A `equipment_daily_throughput_import` table was considered first and rejected
-- on the strength of ADR-0079's own uniqueness guarantee. The invariant that
-- matters here is ONE LIVE FIGURE PER MACHINE PER DAY, and it is enforced by
--
--   CREATE UNIQUE INDEX equipment_daily_throughput_machine_day_key
--     ON (equipment_id, throughput_date) WHERE voided_at IS NULL
--
-- A sibling table puts the imported day OUTSIDE that index. The two sources
-- could then both hold 2026-07-15, nothing in the database would object, and
-- "JT's entry wins" would degrade from a constraint into a convention that every
-- future read path has to remember — the identical failure shape ADR-0079 D2
-- rejected for `equipment_events`. Keeping the rows in ONE table means the
-- conflict is a real conflict, adjudicated by the database, once.
--
-- ── THE ADJUDICATION IS IN THE DATABASE, NOT IN THE IMPORTER ───────────────
-- The importer upserts with
--
--   ON CONFLICT (equipment_id, throughput_date) WHERE voided_at IS NULL
--   DO UPDATE SET ... WHERE equipment_daily_throughput.source = 'workbook_import'
--
-- so a MANAGER row is never overwritten by an import (the DO UPDATE simply does
-- not fire), while a manager entering a day DOES overwrite an imported one
-- through the ordinary ADR-0079 write path. That asymmetry is exactly "starting
-- today JT takes over": history is a floor to build on, not a ceiling.
--
-- Putting the guard in the SQL rather than in a pre-read matters. A
-- read-then-write in the importer is a TOCTOU: a manager saving 2026-07-15 in
-- the half-second between the SELECT and the UPDATE would have their entry
-- silently replaced by the sheet. `ON CONFLICT ... WHERE` is evaluated against
-- the row the index actually found, inside the same statement, holding the same
-- lock. `import.jt-wins-on-conflict` deletes the `WHERE` clause and proves the
-- red names the manager's real number.
--
-- ── WHY `import_version_id` CARRIES NO FOREIGN KEY ─────────────────────────
-- `doc_source_versions` is `ON DELETE CASCADE` from `doc_sources`. A real FK
-- here would therefore force one of three bad outcomes: RESTRICT makes a
-- doc-source removal impossible for reasons a reader would never guess; CASCADE
-- lets removing a document DELETE PRODUCTION THROUGHPUT; SET NULL silently
-- strips the provenance off rows that still claim `source = 'workbook_import'`,
-- breaking the CHECK below. A bare id matches the convention this table family
-- already uses for exactly this reason (`applied_by`, `discarded_by`,
-- `voided_by` are all bare). Provenance is a claim about history, and history
-- does not get re-pointed when a row elsewhere is deleted.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant). Two nullable-or-defaulted
-- columns, two CHECKs and one index. Every existing row becomes `'manager'`,
-- which is what all 0–N of them are: the only write path that existed before
-- this migration was ADR-0079's manager entry. Nothing is backfilled here — the
-- import is a separate, audited, reconciled operation.
--
-- Every statement is idempotent, so a re-run or a CI replay is a no-op.

ALTER TABLE "equipment_daily_throughput"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manager';

ALTER TABLE "equipment_daily_throughput"
  ADD COLUMN IF NOT EXISTS "import_version_id" TEXT;

-- `ADD CONSTRAINT` has no IF NOT EXISTS in PG16, so existence is checked
-- explicitly (same shape as 20260827_adr0075_equipment_merge).
DO $$
BEGIN
  -- A free-text `source` would let a typo ('workbook-import', 'Workbook_Import')
  -- become a third source that the JT-wins guard silently does not protect and
  -- the display silently does not draw. Two values, spelled once, in the DB.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipment_daily_throughput_source_known'
  ) THEN
    ALTER TABLE "equipment_daily_throughput"
      ADD CONSTRAINT "equipment_daily_throughput_source_known"
      CHECK ("source" IN ('manager', 'workbook_import'));
  END IF;

  -- Provenance is not optional for an imported row, and is meaningless on a
  -- manager's. Stating it as a constraint rather than a convention is what makes
  -- the version-scoped idempotency (ADR-0081 R4) safe: the delete-then-reinsert
  -- targets `import_version_id`, so a `workbook_import` row that had lost its
  -- version would be invisible to supersession and would survive forever as a
  -- duplicate nobody could reach.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'equipment_daily_throughput_import_provenance'
  ) THEN
    ALTER TABLE "equipment_daily_throughput"
      ADD CONSTRAINT "equipment_daily_throughput_import_provenance"
      CHECK (
        ("source" = 'workbook_import' AND "import_version_id" IS NOT NULL)
        OR ("source" = 'manager' AND "import_version_id" IS NULL)
      );
  END IF;
END $$;

-- The supersession scan (ADR-0081 R4): "every workbook_import row for this
-- machine". Partial on the source so the index stays small — manager rows are
-- the ones that accumulate forever and they are never scanned this way.
CREATE INDEX IF NOT EXISTS "equipment_daily_throughput_import_idx"
  ON "equipment_daily_throughput" ("equipment_id", "import_version_id")
  WHERE "source" = 'workbook_import';
