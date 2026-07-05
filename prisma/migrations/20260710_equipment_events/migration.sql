-- ADR-0044 — Terex equipment module (equipment_events).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). One new table + one enum. The event date is a DATE; hours_down is a
-- NUMERIC(5,2); cost_cents is an integer count of cents. Throughput is DERIVED
-- from `processed_units_daily` (ADR-0037 D5) at read time — this migration only
-- adds the downtime/cost/maintenance/note capture log (D2: no new throughput
-- capture is introduced).
--
-- The dir name `20260710_equipment_events` sorts AFTER the current main chain tip
-- (`20260709_alert_recipients`) — preserving ADR-0035 lexical migration ordering.
-- This migration references only `sites` (present in the init chain), so it
-- applies cleanly on top of the whole chain.
--
-- The `site_id` FK carries a DB-level FOREIGN KEY constraint here rather than a
-- Prisma relation, so the ADR-0044 schema block stays self-contained (no back-
-- relation field on the shared `Site` model). The audit-actor columns
-- (`created_by`/`voided_by`) are bare columns (mirrors `invoices.generated_by`),
-- not constraints. There is deliberately NO `locked_at`: events are freely
-- editable and removal is a soft-void (`voided_at`), history via `audit_log`.

-- ─────────────────────────────────────────────────────────────────────────
-- Enum
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "EquipmentEventKind" AS ENUM ('downtime', 'maintenance', 'repair', 'cost', 'note');

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — equipment_events (Terex-first but not Terex-hardcoded)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "equipment_events" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "equipment_code" TEXT NOT NULL DEFAULT 'terex',
    "event_date" DATE NOT NULL,
    "kind" "EquipmentEventKind" NOT NULL,
    "hours_down" DECIMAL(5,2),
    "cost_cents" INTEGER,
    "vendor" TEXT,
    "notes" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "created_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "equipment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "equipment_events_site_id_event_date_idx"
    ON "equipment_events"("site_id", "event_date");

CREATE INDEX "equipment_events_site_id_equipment_code_event_date_idx"
    ON "equipment_events"("site_id", "equipment_code", "event_date");

CREATE INDEX "equipment_events_site_id_kind_idx"
    ON "equipment_events"("site_id", "kind");

ALTER TABLE "equipment_events"
    ADD CONSTRAINT "equipment_events_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
