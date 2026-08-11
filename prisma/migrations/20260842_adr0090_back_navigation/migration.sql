-- ADR-0090 Amendment 1 (B) — the floor can go BACK: review every stage, correct
-- the weight, void a miscounted stack, and reopen a finished load.
--
-- JT, 2026-08-10: "You can't click the back button after clicking next... when
-- you click a haul, take a pic, then enter weight, click enter or next, start
-- unload, enter units received — if you want to go back to fix or check what you
-- entered is correct, vision doesn't let you."
--
-- ORDERING INVARIANT (ADR-0035): this directory name must sort lexically AFTER
-- `20260841_adr0090_load_void`. It does. `prisma migrate deploy` applies in
-- directory-name order, not date order.
--
-- Purely additive: two nullable columns on `load_stacks`, one FK, one CHECK.
-- Zero drops, zero type changes, zero rewrites of existing rows. Every existing
-- stack keeps `voided_at IS NULL`, which is exactly what the new sum filters
-- select, so the billed total of every load already in the database is
-- unchanged by construction. Safe to apply to the live database with the app
-- running, and safe to apply twice (every statement is guarded).
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why a soft void, and why the unique index stays FULL
-- ─────────────────────────────────────────────────────────────────────────
--
-- A stack is a BILLED unit — `finishUnload` sums `load_stacks` into
-- `total_units`, which reaches an MRC invoice. A DELETE would destroy the only
-- evidence the operator ever counted it, and would leave the append-only audit
-- row pointing at a row that no longer exists. So the row stays and every sum
-- filters `voided_at IS NULL`.
--
-- `load_stacks_load_id_stack_index_key` is deliberately NOT made partial.
-- `stack_index` is monotonic — the client computes the next index over EVERY
-- stack, voided ones included — so an index is never reused and the positional
-- meaning of the audit trail survives. That has a second, load-bearing effect:
-- a P2002 at an index that holds a VOIDED row can only be a replay of the write
-- that was subsequently voided, never a genuinely new stack. `addStack`
-- therefore refuses to converge on a voided row (409 `stack_index_conflict`),
-- which parks the queued entry for a person instead of reporting a false 201 and
-- deleting a stack of mattresses out of a billed total with no record anywhere.
-- Making the index partial would have re-opened the index for reuse and made
-- that case indistinguishable from an ordinary first write.
--
-- ─────────────────────────────────────────────────────────────────────────
-- No column for the REOPEN, deliberately
-- ─────────────────────────────────────────────────────────────────────────
--
-- `finished -> in_progress` is recorded in `audit_logs` (actor, instant, from
-- and to status), which is append-only and is already rendered on the manager
-- load page. A `reopened_at` column would be a SECOND place that has to agree
-- with the audit log about the same event, and the two would eventually
-- disagree — the exact duplication ADR-0090 D2 argued against for the void.
--
-- The one thing a reopen must NOT do is recompute `unload_duration_seconds`
-- (Bill, 2026-08-10: freeze the duration at the first finish). That is enforced
-- in `finishUnload` by a conditional UPDATE whose WHERE is
-- `unload_duration_seconds IS NULL` — a database predicate, not a client-side
-- branch and not a read-then-write — so a second finish, however it is reached
-- and however concurrent, matches zero rows for the timing columns.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'load_stacks' AND column_name = 'voided_at'
    ) THEN
        ALTER TABLE "load_stacks" ADD COLUMN "voided_at" TIMESTAMP(3);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'load_stacks' AND column_name = 'voided_by'
    ) THEN
        ALTER TABLE "load_stacks" ADD COLUMN "voided_by" TEXT;
    END IF;
END
$$;

-- FK on the actor. SET NULL rather than RESTRICT, matching ADR-0084 and the
-- load void above it: deactivating a user must never make a load's stacks
-- unreadable, and `audit_logs` is the append-only record of record for WHO.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = 'load_stacks'
           AND constraint_name = 'load_stacks_voided_by_fkey'
    ) THEN
        ALTER TABLE "load_stacks"
            ADD CONSTRAINT "load_stacks_voided_by_fkey"
            FOREIGN KEY ("voided_by") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- Consistency guard: a stack void is either fully recorded or not recorded at
-- all. Written as "instant present OR actor absent" rather than "both present"
-- because the ON DELETE SET NULL above may legitimately clear `voided_by` later.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = 'load_stacks'
           AND constraint_name = 'load_stacks_void_pair_chk'
    ) THEN
        ALTER TABLE "load_stacks"
            ADD CONSTRAINT "load_stacks_void_pair_chk"
            CHECK ("voided_at" IS NOT NULL OR "voided_by" IS NULL);
    END IF;
END
$$;

-- No new index. Every read of `load_stacks` is already keyed on `load_id` (the
-- two `finishUnload` sums and the two page selects); `voided_at` is never a
-- search key on its own, only a fact carried on a row already found. Same
-- reasoning ADR-0084 and `20260841_adr0090_load_void` recorded for their voids.
