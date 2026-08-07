-- ADR-0078 — iPad reliability foundation: exactly-once floor writes and a
-- deterministic inventory anchor.
--
-- Purely additive. One new table, one new column, one backfill, zero drops,
-- zero type changes, zero rewrites of existing values. Safe to apply to the
-- live database with the app running, and safe to apply twice (every statement
-- is guarded).
--
-- ORDERING INVARIANT (ADR-0035): this directory name must sort lexically AFTER
-- the current chain tip `20260829_adr0077_terex_ledger_surface`. It does.
-- `prisma migrate deploy` applies in directory-name order, not date order, and
-- the dates in this chain are sequence numbers rather than calendar facts.
--
-- ─────────────────────────────────────────────────────────────────────────
-- 1. `idempotency_keys` — the exactly-once receipt table
-- ─────────────────────────────────────────────────────────────────────────
--
-- A floor write now carries a client-minted key. The first request to present
-- a key claims it, performs the business write, and stores its response IN THE
-- SAME TRANSACTION; a later request with the same key gets that stored response
-- back and performs no write. A double-tap, a retry after a timeout, and a
-- replayed offline-queue entry are all the same write, and now they land once.
--
-- The PRIMARY KEY is what does the work. `INSERT ... ON CONFLICT ("key") DO
-- NOTHING` is not merely convenient: Postgres blocks on a conflicting
-- UNCOMMITTED row rather than skipping it, so two simultaneous taps serialise
-- against this constraint instead of racing past each other. Remove the
-- constraint and the defence is gone — which is exactly what the
-- `idempotency.double-submit` test does before trusting it.
--
-- `id` is the key itself (TEXT), not a generated uuid: the client names the
-- write, and a server-generated id could not identify a retry.
CREATE TABLE IF NOT EXISTS "idempotency_keys" (
    "key"           TEXT NOT NULL,
    "scope"         TEXT NOT NULL,
    "actor_user_id" TEXT,
    "site_id"       TEXT,
    "request_hash"  TEXT NOT NULL,
    "status_code"   INTEGER,
    "response_body" JSONB,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- Drives the 7-day TTL sweep. That sweep is the ONLY writer permitted to delete
-- from this table, and it never touches a row younger than its retention floor.
CREATE INDEX IF NOT EXISTS "idempotency_keys_created_at_idx"
    ON "idempotency_keys" ("created_at");

-- No foreign keys on "actor_user_id" / "site_id" — deliberate, see the model
-- comment in schema.prisma. These are swept request receipts, not domain rows;
-- the durable actor record is "audit_log", which does carry the FK.

-- ─────────────────────────────────────────────────────────────────────────
-- 2. `site_inventory_snapshots.created_at` — the anchor tiebreaker
-- ─────────────────────────────────────────────────────────────────────────
--
-- Both anchor selectors ordered by "snapshot_at" DESC with no tiebreaker, and
-- "snapshot_at" is not distinct per count: the floor count route anchors at
-- Pacific midnight of the current day (ADR-0060 D-3), so two counts taken on
-- the SAME DAY are stored with the byte-identical timestamp. SQL makes no
-- promise about which of two equal sort keys is returned first, so which of
-- those two counts became the inventory anchor — the number every downstream
-- balance is computed forward from — was left to the query planner.
--
-- Production has not yet been bitten: exactly two physical snapshots exist
-- (2026-06-30 and 2026-07-22, different days) and the duplicate-instant query
-- returns zero groups. But `ipad_count` is LIVE at both sites, so a second
-- count on any single day reaches this today. This is a latent defect being
-- closed before it fires, not a repair after one.
-- The ADD and the backfill are bound together inside one conditional block, and
-- that structure is the idempotency guard — not a WHERE clause on the UPDATE.
--
-- The obvious shape (ADD COLUMN IF NOT EXISTS, then UPDATE ... WHERE created_at
-- > snapshot_at) is WRONG on a second application, and wrong in the dangerous
-- direction. A count entered after this migration lands has a real insertion
-- instant hours after its Pacific-midnight "snapshot_at", so it matches that
-- WHERE — a re-run would reset it back to "snapshot_at" and destroy the
-- tiebreaker for exactly the same-day pair the column exists to separate.
-- Keying on the column's EXISTENCE instead means the backfill runs once, when
-- there is nothing else it could damage, and is a complete no-op forever after.
--
-- The backfill value is the honest one, not the convenient one. We do not know
-- when these rows were inserted — the column did not exist — and
-- CURRENT_TIMESTAMP would assert they were all created at migration time, which
-- is false and would order them by nothing at all. Seeding from "snapshot_at"
-- makes the tiebreaker a NO-OP for every pre-existing row: wherever
-- "snapshot_at" already determined the order it still does, and the tiebreaker
-- can only decide cases "snapshot_at" left undecided. For the two production
-- rows, which fall on different days, it changes nothing.
--
-- NOT NULL + DEFAULT are set in the ADD itself, so there is no window in which
-- a concurrent insert from an old app container could write a NULL.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name   = 'site_inventory_snapshots'
           AND column_name  = 'created_at'
    ) THEN
        ALTER TABLE "site_inventory_snapshots"
            ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

        UPDATE "site_inventory_snapshots"
           SET "created_at" = "snapshot_at";
    END IF;
END
$$;

-- No new index. The existing "site_inventory_snapshots_site_id_snapshot_kind_snapshot_at_idx"
-- still resolves the range scan; the added tiebreak sorts at most a handful of
-- same-instant rows per site. An index Postgres would not meaningfully use is
-- ceremony, not performance.
