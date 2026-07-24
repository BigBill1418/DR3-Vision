-- ADR-0059 — MyMRC hauls → inventory INBOUND bridge (the second leg).
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty PG16).
--
-- Adds the `mymrc_haul` provenance to `LoadSourceType` (a bridged, PROVISIONAL,
-- per-(site, delivery-day) inbound aggregate synthesized from MyMRC `Delivered`
-- `General` hauls) and GENERALIZES the ADR-0037 paper_bulk partial unique index so at
-- most ONE aggregate inbound row can exist per (site, day) across BOTH aggregate
-- source types. That single-row invariant is what makes a paper_bulk↔mymrc_haul
-- double-count physically impossible: `onHand` sums every verified inbound row for a
-- day regardless of source, so a per-day uniqueness that spans both aggregate kinds is
-- the money-safe guard (paired with absolute-value SET on upsert so re-runs never
-- increment). Per-load (iPad / b2b_haul) dock captures are NOT covered by the predicate
-- and stay untouched — the future iPad path retires the aggregate explicitly.
--
-- PG16 permits ALTER TYPE ... ADD VALUE inside the migration transaction as long as the
-- new value is not USED in the same transaction. The generalized index predicate below
-- references the new label, which WOULD read it in-transaction, so an explicit COMMIT
-- closes Prisma's implicit migration transaction before the index DDL (identical pattern
-- to 20260806_adr0037_paper_bulk_inbound_source).
ALTER TYPE "LoadSourceType" ADD VALUE IF NOT EXISTS 'mymrc_haul';

COMMIT;

-- Generalize the aggregate-inbound single-row-per-day invariant to cover both aggregate
-- provenances. Drop the paper_bulk-only index (ADR-0037) and re-create it spanning
-- ('paper_bulk','mymrc_haul'). Idempotent + clean-replay safe: on a fresh DB the
-- 20260806 migration creates the paper_bulk-only index first, then this drops+re-creates
-- the generalized one; DROP IF EXISTS / CREATE IF NOT EXISTS make a re-apply a no-op.
DROP INDEX IF EXISTS "inbound_loads_paper_bulk_site_day_key";

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_loads_aggregate_site_day_key"
  ON "inbound_loads" ("site_id", "arrived_at")
  WHERE "load_source_type" IN ('paper_bulk', 'mymrc_haul');
