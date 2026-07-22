-- ADR-0057 D4 — MyMRC reconciliation queue (the canonical write gate) +
-- ADR-0056 amendment (Addendum A §A.3) — `collection_events.dr3_hauled`.
--
-- Vision NEVER auto-updates operational tables (`sources`, `source_aliases`,
-- `state_program_rules`, …) from MyMRC. Mirror sync writes candidate changes to
-- `mymrc_reconciliation_queue`; an admin approves/rejects/snoozes each at
-- `/admin/mymrc/reconcile`, and only on approve does Vision write the change to
-- the target operational table. This migration establishes that queue table and
-- adds the `dr3_hauled` gate to collection events.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant — replays on an empty PG16 in
-- CI). Two new enums, one new table, one new NOT-NULL column with a DEFAULT so
-- existing rows backfill safely. No rows seeded; no existing data mutated beyond
-- the column default.
--
-- The dir name sorts AFTER the Wave-1 chain tip
-- (`20260802_adr0057_mymrc_admin_credentials`), preserving ADR-0035 lexical
-- migration ordering.
--
-- `dr3_hauled` DEFAULT true rationale: event freight is currently summed
-- UNCONDITIONALLY into the invoice `event_transportation_total` (MILES 0 member).
-- Existing events predate the DR3-hauled distinction and all carry billed
-- `freight_cents`, so defaulting true reproduces current invoice output and
-- avoids a silent revenue drop. `false` is the new, explicitly-flagged
-- customer/third-party-haul exception.
--
-- Bare scalar references in the queue (no FKs): `mirror_record_id` /
-- `target_record_id` point at heterogeneous-PK rows across many mirror and
-- operational tables, mirroring the self-contained `mymrc_*_mirror` blocks.

-- ── New enums ──
CREATE TYPE "ReconChangeKind" AS ENUM ('new_record', 'field_update', 'disappeared');
CREATE TYPE "ReconStatus" AS ENUM ('pending', 'approved', 'rejected', 'snoozed');

-- ── ADR-0056 amendment §A.3 — DR3-hauled gate on event transportation ──
ALTER TABLE "collection_events"
    ADD COLUMN "dr3_hauled" BOOLEAN NOT NULL DEFAULT true;

-- ── ADR-0057 D4 — reconciliation queue (canonical write gate) ──
CREATE TABLE "mymrc_reconciliation_queue" (
    "id" TEXT NOT NULL,
    "mirror_table" TEXT NOT NULL,
    "mirror_record_id" TEXT NOT NULL,
    "target_table" TEXT NOT NULL,
    "target_record_id" TEXT,
    "field_name" TEXT NOT NULL,
    "mymrc_value" JSONB NOT NULL,
    "vision_value" JSONB,
    "change_kind" "ReconChangeKind" NOT NULL,
    "status" "ReconStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),
    "decided_by" TEXT,
    "decision_note" TEXT,
    "snooze_until" TIMESTAMP(3),

    CONSTRAINT "mymrc_reconciliation_queue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mymrc_reconciliation_queue_status_mirror_table_change_kind_idx"
    ON "mymrc_reconciliation_queue"("status", "mirror_table", "change_kind");
CREATE INDEX "mymrc_reconciliation_queue_mirror_table_mirror_record_id_idx"
    ON "mymrc_reconciliation_queue"("mirror_table", "mirror_record_id");
CREATE INDEX "mymrc_reconciliation_queue_target_table_target_record_id_idx"
    ON "mymrc_reconciliation_queue"("target_table", "target_record_id");
