-- ADR-0090 C — the honest zero: a load started by mistake can be closed by the
-- floor, without DB surgery.
--
-- JT, 2026-08-10: "I'm not able to fix the pending one under my name, it doesn't
-- let me 0 it out... I fixed everybody else's."
--
-- She could not, and neither could anyone else: `stage-stacks.tsx` refuses a
-- stack of 0 (`unitCount < 1` => 422) and there is NO abandon path anywhere in
-- the 7-stage workflow. ADR-0073 (manager load corrections) is design-only and
-- addresses SUBMITTED loads, not a mis-tap that never should have started. The
-- only remedy used to date has been hand-audited DB surgery — three times in
-- August alone, most recently for H-136796 (tapped 19 seconds before the Santa
-- Rita check-in that was the real intent).
--
-- ORDERING INVARIANT (ADR-0035): this directory name must sort lexically AFTER
-- `20260840_adr0089_recycler_delivery_date`. It does. `prisma migrate deploy`
-- applies in directory-name order, not date order.
--
-- Purely additive: one new enum, one new enum MEMBER, five nullable columns, one
-- FK, one CHECK. Zero drops, zero type changes, zero rewrites of existing rows.
-- Every existing load keeps its status and `voided_at IS NULL`. Safe to apply to
-- the live database with the app running, and safe to apply twice (every
-- statement is guarded).
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why a new enum MEMBER, where ADR-0084 used a nullable column pair
-- ─────────────────────────────────────────────────────────────────────────
--
-- Opposite answers to the same question, because the two tables are READ
-- differently and that is what decides it.
--
-- `site_inventory_snapshots` is selected by RECENCY — `onHand()` takes the
-- latest `physical` row. There is no status allow-list to add a member to, so
-- exclusion had to be an explicit new predicate: `voided_at IS NULL`.
--
-- `inbound_loads` is read through status ALLOW-lists at every path that touches
-- money or inventory: INVOICE_STATUSES (MRC + SVDP exports, invoice freight
-- legs), VERIFIED_INBOUND_STATUSES (onHand, EOD inventory, audit legs, the
-- workbench comparators), OPEN_DOCK_STATUSES (the floor's unfinished list),
-- TAKEOVER_STATUSES, VERIFIABLE_FROM. A new member is excluded from every one of
-- them BY CONSTRUCTION — nothing has to remember to exclude it.
--
-- A `voided_at` column here would have been opt-OUT: each of those queries would
-- need a new predicate, and the one that got missed would silently bill a load
-- the floor had disowned. The enum member also makes `ALLOWED_PRIOR`
-- (Record<LoadStatus, LoadStatus[]> in load-service.ts) a COMPILE ERROR until the
-- transition is declared, which is the only automatic tripwire in the codebase
-- for "a status was added and someone forgot about it".
--
-- The columns below are therefore not the exclusion mechanism; they are the
-- record of WHY, WHO and WHEN, so that `status='voided'` can never disagree with
-- the facts about the void.

-- ── The reason the operator asserts ──────────────────────────────────────────
-- A mis-click and a truck that never came are different facts about the world.
-- Collapsing them loses the only signal separating a UI problem (are we showing
-- confusable cards?) from a carrier problem (is this transporter no-showing?).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoadVoidReason') THEN
        CREATE TYPE "LoadVoidReason" AS ENUM ('wrong_haul', 'truck_never_arrived', 'other');
    END IF;
END
$$;

-- ── The terminal status ──────────────────────────────────────────────────────
-- ADD VALUE IF NOT EXISTS is idempotent and, since PG12, is transactional-safe
-- outside an explicit transaction block for pre-existing types.
ALTER TYPE "LoadStatus" ADD VALUE IF NOT EXISTS 'voided';

-- ── The facts ────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads' AND column_name = 'voided_at'
    ) THEN
        ALTER TABLE "inbound_loads" ADD COLUMN "voided_at" TIMESTAMP(3);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads' AND column_name = 'voided_by'
    ) THEN
        ALTER TABLE "inbound_loads" ADD COLUMN "voided_by" TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads' AND column_name = 'void_reason'
    ) THEN
        ALTER TABLE "inbound_loads" ADD COLUMN "void_reason" "LoadVoidReason";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads' AND column_name = 'void_note'
    ) THEN
        ALTER TABLE "inbound_loads" ADD COLUMN "void_note" TEXT;
    END IF;

    -- The severed parent slot. `expected_load_id` is UNIQUE, so a voided child
    -- would hold its `expected_loads` row hostage and the REAL truck could never
    -- check in. The void NULLs `expected_load_id` and records the original here.
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads'
           AND column_name = 'voided_from_expected_load_id'
    ) THEN
        ALTER TABLE "inbound_loads" ADD COLUMN "voided_from_expected_load_id" TEXT;
    END IF;
END
$$;

-- FK on the actor. SET NULL rather than RESTRICT, matching ADR-0084: deactivating
-- a user must never make a load unreadable, and `audit_logs` is the append-only
-- record of record for WHO.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads'
           AND constraint_name = 'inbound_loads_voided_by_fkey'
    ) THEN
        ALTER TABLE "inbound_loads"
            ADD CONSTRAINT "inbound_loads_voided_by_fkey"
            FOREIGN KEY ("voided_by") REFERENCES "users"("id")
            ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;

-- Consistency guard: a void is either fully recorded or not recorded at all.
-- Written as "instant present OR actor absent" rather than "both present"
-- because ON DELETE SET NULL above may legitimately clear `voided_by` later.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
         WHERE table_schema = current_schema()
           AND table_name = 'inbound_loads'
           AND constraint_name = 'inbound_loads_void_pair_chk'
    ) THEN
        ALTER TABLE "inbound_loads"
            ADD CONSTRAINT "inbound_loads_void_pair_chk"
            CHECK ("voided_at" IS NOT NULL OR "voided_by" IS NULL);
    END IF;
END
$$;

-- No new index. Every reader reaches a voided load through an existing
-- `(site_id, status)` or `(site_id, arrived_at)` path; `voided_at` is never a
-- search key, only a fact carried on a row already found. Same reasoning
-- ADR-0084 recorded for the snapshot void.
