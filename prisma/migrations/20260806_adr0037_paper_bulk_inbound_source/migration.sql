-- ADR-0037 Phase 3 (§3.2 option b) — paper-bootstrap bulk daily inbound.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16).
--
-- Until the operator iPads are in service there is no per-load inbound capture at
-- Woodland/Eugene. A manager working from the paper daily log enters ONE synthesized
-- inbound row per site per day carrying the day's total units + the program /
-- non-program split. That preserves the D6 inflow arithmetic
-- (End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled) without demanding
-- operator-level per-load detail, and tags the provenance so the row is never mistaken
-- for a verified dock capture. When the iPads come online the aggregate rows stop being
-- written and per-load rows take over — no schema change needed.
--
-- PG16 permits ALTER TYPE ... ADD VALUE inside the migration transaction as long as the
-- new value is not USED in the same transaction. The partial unique index below refers to
-- the value in its predicate, which WOULD read the new label in-transaction, so the index
-- is created in a SEPARATE statement batch guarded by COMMIT (Prisma runs a migration file
-- as one implicit transaction; an explicit COMMIT closes it before the index DDL).
ALTER TYPE "LoadSourceType" ADD VALUE IF NOT EXISTS 'paper_bulk';

COMMIT;

-- One paper-bulk row per site per calendar day. `arrived_at` is written at UTC midnight
-- of the business day by the service, so the pair is the day key. Per-load (iPad) rows are
-- untouched by this constraint — the predicate scopes it to the paper_bulk provenance only.
CREATE UNIQUE INDEX IF NOT EXISTS "inbound_loads_paper_bulk_site_day_key"
  ON "inbound_loads" ("site_id", "arrived_at")
  WHERE "load_source_type" = 'paper_bulk';

-- Lookup shape for the manager list surface (site + provenance, newest day first).
CREATE INDEX IF NOT EXISTS "inbound_loads_site_id_load_source_type_arrived_at_idx"
  ON "inbound_loads" ("site_id", "load_source_type", "arrived_at");
