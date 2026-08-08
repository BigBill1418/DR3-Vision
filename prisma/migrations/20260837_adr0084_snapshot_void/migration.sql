-- ADR-0084 — same-day operator VOID of a physical inventory count.
--
-- JT: "if we accidentally entered the count twice, we should be able to remove
-- one." Bill: same-day only on the iPad; prior-day is an office job.
--
-- G3 re-scope: the target is `site_inventory_snapshots` (physical counts), NOT
-- `bonus_daily_entries`. Operators cannot reach the bonus grid at all, and a
-- duplicate bonus entry is structurally impossible there
-- (`@@unique(bonus_employee_id, entry_date)` — a second write UPDATES the row it
-- would duplicate). The only iPad path that can genuinely double-enter is the
-- floor count, which is P1's territory and whose ADR-0078 D1 `created_at`
-- tiebreaker already shipped.
--
-- Purely additive. Two nullable columns on one table, one FK, zero drops, zero
-- type changes, zero rewrites of existing values — every existing count stays
-- live (`voided_at IS NULL`) and every anchor selection is unchanged on
-- pre-existing data. Safe to apply to the live database with the app running,
-- and safe to apply twice (every statement is guarded).
--
-- ORDERING INVARIANT (ADR-0035): this directory name must sort lexically AFTER
-- `20260836_adr0083_bonus_saves`. It does. `prisma migrate deploy` applies in
-- directory-name order, not date order, and the dates in this chain are sequence
-- numbers rather than calendar facts.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why soft-void and never DELETE
-- ─────────────────────────────────────────────────────────────────────────
--
-- A `physical` snapshot is the ANCHOR: `onHand()` picks the latest one and every
-- downstream floor, COR and billing number is computed forward from it. Deleting
-- one destroys the only record of a number that a human physically counted and
-- that the system may already have reported. The audit log is append-only
-- (CLAUDE.md hard rule #6) and an audit row that describes a row which no longer
-- exists is a dangling reference, not a record.
--
-- So: `voided_at` non-null means EXCLUDED FROM ANCHOR SELECTION, and the row
-- stays. The recovery surface (/admin/inventory/anchors) deliberately still
-- SHOWS voided counts, struck through — hiding them would reproduce the problem
-- the soft-void exists to avoid.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why a nullable timestamp rather than a boolean
-- ─────────────────────────────────────────────────────────────────────────
--
-- `voided_at IS NULL` is the live predicate AND carries when it happened, so the
-- audit row and the row it describes cannot disagree about the instant. A
-- boolean would need a companion timestamp anyway and admits the state
-- (`voided = true, voided_at = NULL`) that means nothing.
--
-- `voided_by` is a bare scalar FK → users.id with ON DELETE SET NULL and no
-- Prisma relation field, matching the `bonus_reporting_adjustments.created_by`
-- pattern: we never navigate user → voided snapshots, and a deactivated user
-- must not make a count unreadable.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name   = 'site_inventory_snapshots'
           AND column_name  = 'voided_at'
    ) THEN
        ALTER TABLE "site_inventory_snapshots"
            ADD COLUMN "voided_at" TIMESTAMP(3);
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name   = 'site_inventory_snapshots'
           AND column_name  = 'voided_by'
    ) THEN
        ALTER TABLE "site_inventory_snapshots"
            ADD COLUMN "voided_by" TEXT;
    END IF;
END
$$;

-- FK on the actor. SET NULL rather than RESTRICT: deactivating a user must never
-- make a physical count unreadable, and the audit_logs row retains the actor
-- identity independently (it is append-only and is the record of record for WHO).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.table_constraints
         WHERE table_schema    = current_schema()
           AND table_name      = 'site_inventory_snapshots'
           AND constraint_name = 'site_inventory_snapshots_voided_by_fkey'
    ) THEN
        ALTER TABLE "site_inventory_snapshots"
            ADD CONSTRAINT "site_inventory_snapshots_voided_by_fkey"
            FOREIGN KEY ("voided_by") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- Consistency guard: a void is either fully recorded or not recorded. A row with
-- an instant but no actor (or an actor but no instant) is a half-written void,
-- and the whole point of the column pair is that a human owns the decision.
-- `voided_by` may only be NULL once the user row is deleted (ON DELETE SET NULL
-- above), which is why the check is written as "both null or voided_at present"
-- rather than "both null or both present".
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.table_constraints
         WHERE table_schema    = current_schema()
           AND table_name      = 'site_inventory_snapshots'
           AND constraint_name = 'site_inventory_snapshots_void_pair_chk'
    ) THEN
        ALTER TABLE "site_inventory_snapshots"
            ADD CONSTRAINT "site_inventory_snapshots_void_pair_chk"
            CHECK ("voided_at" IS NOT NULL OR "voided_by" IS NULL);
    END IF;
END
$$;

-- No new index. Every anchor selector already filters
-- `(site_id, snapshot_kind, snapshot_at)` through the existing composite index;
-- `voided_at IS NULL` is a residual predicate matching all but a handful of rows,
-- which is the case where a partial index earns nothing. Same reasoning ADR-0078
-- D1 recorded for the `created_at` tiebreaker.
