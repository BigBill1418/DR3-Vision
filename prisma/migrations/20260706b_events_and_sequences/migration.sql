-- ADR-0041 (CAPTURE HALF) — collection events, OR collection-site counts, and
-- per-site document-number sequences (+ the Vision-assigned `dr3_number` column
-- on inbound_loads).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Three new tables + one nullable column on an existing table. Money is
-- integer CENTS; effective/anchor dates are DATE.
--
-- The dir name `20260706b_events_and_sequences` sorts AFTER
-- `20260706_billing_rate_infrastructure` (ADR-0040) and BEFORE the sibling
-- invoice migration (`20260707…`) — preserving ADR-0035 lexical ordering. This
-- migration references only `sites` (present in the init chain) and adds a column
-- to `inbound_loads` (present in the init chain), so it applies cleanly on the
-- current main chain with or without the sibling migrations.
--
-- FK columns (`site_id`) carry DB-level FOREIGN KEY constraints here rather than
-- Prisma relations, so the ADR-0041 capture-half schema block stays
-- self-contained (no back-relation fields on the sibling-touched `sites` model).
-- `created_by` is a bare column (mirrors `state_program_rules.created_by`), not a
-- constraint.

-- ─────────────────────────────────────────────────────────────────────────
-- Vision-assigned DR3 document number on inbound_loads (issued at office verify
-- for CA-jurisdiction sites; OR loads leave it null).
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "inbound_loads" ADD COLUMN "dr3_number" TEXT;

-- ─────────────────────────────────────────────────────────────────────────
-- D3 — collection_events (daily-log Events tab)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "collection_events" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "event_date" DATE NOT NULL,
    "customer" TEXT NOT NULL,
    "county" TEXT,
    "slip_number" TEXT,
    "units" INTEGER,
    "freight_cents" INTEGER,
    "driver_hours" DECIMAL(5,2),
    "driver_wages_cents" INTEGER,
    "labor_hours" DECIMAL(5,2),
    "labor_wages_cents" INTEGER,
    "mileage" INTEGER,
    "mileage_cents" INTEGER,
    "per_diem_cents" INTEGER,
    "misc_cents" INTEGER,
    "retrac_id" TEXT,
    "notes" TEXT,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collection_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "collection_events_site_id_event_date_idx" ON "collection_events"("site_id", "event_date");
CREATE INDEX "collection_events_retrac_id_idx" ON "collection_events"("retrac_id");

ALTER TABLE "collection_events"
    ADD CONSTRAINT "collection_events_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D3 — or_collection_site_counts (Oregon satellite counts, hand-entered)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "or_collection_site_counts" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "billing_month" DATE NOT NULL,
    "location" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "source" "RecordSource" NOT NULL DEFAULT 'manual',
    "locked_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "or_collection_site_counts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "or_collection_site_counts_site_id_billing_month_idx" ON "or_collection_site_counts"("site_id", "billing_month");

ALTER TABLE "or_collection_site_counts"
    ADD CONSTRAINT "or_collection_site_counts_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D3 — document_sequences (per-site atomic counters; DR3#)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "document_sequences" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "sequence_code" TEXT NOT NULL,
    "next_value" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_sequences_site_id_sequence_code_key" ON "document_sequences"("site_id", "sequence_code");

ALTER TABLE "document_sequences"
    ADD CONSTRAINT "document_sequences_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
