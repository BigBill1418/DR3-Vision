-- ADR-0120 — one opening anchor per promoted window, enforced by the database.
--
-- The advisory lock in `promotion-lock.ts` stops a promotion interleaving with
-- the FLOOR. This index is the database-level backstop for the other half:
-- promotion racing promotion. `workbook_promotions.import_id` is already UNIQUE,
-- so two promotions of the SAME import already collide there; what remains is
-- two DIFFERENT imports whose windows share an opening instant, each writing an
-- opening anchor for it. Two live `physical` anchors at one instant, and by
-- ADR-0078 D1's `created_at DESC` tiebreak the later one silently becomes the
-- floor's inventory anchor.
--
-- ── WHY THIS INDEX IS SCOPED TO source = 'import' ───────────────────────────
--
-- The transaction-boundary review specified a partial unique index on
--     (site_id, snapshot_at) WHERE snapshot_kind = 'physical' AND voided_at IS NULL
-- on the premise — reasonable, and stated as a thing to verify — that
-- correct-count's void-first ordering already satisfies it.
--
-- It does not, and the verification is what found it. **Two live physical counts
-- at one site on one day, with a byte-identical `snapshot_at`, are a SUPPORTED
-- and PRODUCTION-OBSERVED state**, not an accident:
--
--   - the floor anchors every count at Pacific MIDNIGHT of its day (ADR-0060
--     D-3), so two counts taken on the same day are stored at the same instant
--     by construction;
--   - ADR-0078 D1 exists BECAUSE of that. It added the `created_at DESC`
--     tiebreak so "the latest anchor" is a fact rather than a query-planner
--     preference, and its own suite header records: "verified in production,
--     where both existing physical snapshots sit exactly on 07:00:00 UTC."
--
-- The unguarded index was applied to a scratch database carrying the full
-- migration chain and the ADR-0078 D1 suite was run against it. It went RED:
--
--     Key (site_id, snapshot_at)=(tiebreak-site, 2026-08-07 07:00:00) already exists.
--     Test Files  1 failed (1)   Tests  3 failed (3)
--
-- and GREEN again with the index dropped and nothing else changed. Shipping it
-- would have made the SECOND same-day physical count at a site fail with a raw
-- Postgres unique violation — on the operator floor, on an overnight deploy,
-- contradicting a shipped and tested invariant without superseding it.
--
-- So the index is narrowed to the rows the promotion race actually produces:
-- `source = 'import'`. It catches two promotions writing an opening anchor for
-- one site-instant, and it is silent on the manual counts ADR-0078 D1 governs.
-- Production was checked before writing this: 4 snapshot rows total, 3 live
-- physical, ZERO duplicate (site_id, snapshot_at) groups under either predicate,
-- so this applies cleanly.
--
-- Plain CREATE UNIQUE INDEX, not CONCURRENTLY: `prisma migrate deploy` wraps
-- each migration in a transaction and CONCURRENTLY cannot run inside one. The
-- table holds single-digit rows in production; the exclusive lock is momentary.

-- CreateIndex
CREATE UNIQUE INDEX "site_inventory_snapshots_import_anchor_uniq"
  ON "site_inventory_snapshots" ("site_id", "snapshot_at")
  WHERE "snapshot_kind" = 'physical'
    AND "voided_at" IS NULL
    AND "source" = 'import';
