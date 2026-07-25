-- ADR-0060 — iPad floor inventory-validation surfaces (confirm inbound / on-hand / processed).
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty PG16).
--
-- Adds the `ipad_floor` provenance to `LoadSourceType` (a floor-CONFIRMED per-(site,
-- delivery-day) inbound aggregate, written by an operator on the iPad when they confirm,
-- correct, or enter the day's inbound haul counts) and WIDENS the ADR-0059 generalized
-- partial unique index so at most ONE aggregate inbound row can exist per (site, day)
-- across ALL THREE aggregate source types. That single-row invariant is what keeps a
-- paper_bulk↔mymrc_haul↔ipad_floor double-count physically impossible: `onHand` sums
-- every verified inbound row for a day regardless of source, so a per-day uniqueness that
-- spans all three aggregate kinds is the money-safe guard (paired with absolute-value SET
-- on upsert so re-confirms never increment). Per-load (b2b_haul) dock captures are NOT
-- covered by the predicate and stay untouched — the iPad floor-confirmation path retires
-- the aggregate explicitly and additionally refuses a day that already holds per-load
-- rows (ADR-0060 D5, the aggregate-vs-per-load double-count guard).
--
-- Precedence honored by the write layer: ipad_floor > paper_bulk > mymrc_haul (ADR-0059 D4).
--
-- PG16 permits ALTER TYPE ... ADD VALUE inside the migration transaction as long as the
-- new value is not USED in the same transaction. The widened index predicate below
-- references the new label, which WOULD read it in-transaction, so an explicit COMMIT
-- closes Prisma's implicit migration transaction before the index DDL (identical pattern
-- to 20260810_adr0059_mymrc_haul_inbound_source).
ALTER TYPE "LoadSourceType" ADD VALUE IF NOT EXISTS 'ipad_floor';

COMMIT;

-- Widen the aggregate-inbound single-row-per-day invariant to cover the third aggregate
-- provenance. Drop the two-value index (ADR-0059) and re-create it spanning all three.
-- Idempotent + clean-replay safe: on a fresh DB the 20260810 migration creates the
-- ('paper_bulk','mymrc_haul') index first, then this drops+re-creates the three-value
-- one; DROP IF EXISTS / CREATE IF NOT EXISTS make a re-apply a no-op. The index NAME is
-- unchanged from ADR-0059 (`inbound_loads_aggregate_site_day_key`) so the ADR-0059
-- bridge's `ON CONFLICT (site_id, arrived_at) WHERE load_source_type IN (...)` upsert
-- keeps arbitrating on the same slot.
DROP INDEX IF EXISTS "inbound_loads_aggregate_site_day_key";

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_loads_aggregate_site_day_key"
  ON "inbound_loads" ("site_id", "arrived_at")
  WHERE "load_source_type" IN ('paper_bulk', 'mymrc_haul', 'ipad_floor');
