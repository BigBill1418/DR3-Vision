-- ADR-0041 — Invoice generation (invoices + invoice_lines).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Two new tables + two enums. Money is integer CENTS; billing windows are
-- DATE. Invoice generation is a pure read of `state_program_rules` (ADR-0037) +
-- the ADR-0040 rate tables + operational data — this migration only adds the
-- artifact store the generated result lands in.
--
-- The dir name `20260707_invoice_generation` sorts AFTER the current main chain
-- tip (`20260706_billing_rate_infrastructure`) and after the sibling CAPTURE
-- migration (`20260706b_*`) — preserving ADR-0035 lexical migration ordering.
-- This migration references only `sites` (present in the init chain), so it
-- applies cleanly with or without the sibling migration.
--
-- FK columns to sibling-owned models (`site_id`) carry a DB-level FOREIGN KEY
-- constraint here rather than a Prisma relation, so the ADR-0041 schema block
-- stays self-contained (no back-relation fields on the shared `Site` model).
-- The audit-actor columns (`generated_by`/`approved_by`/`voided_by`) are bare
-- columns (mirrors `state_program_rules.created_by`), not constraints. The
-- `supersedes_id` self-FK and the `invoice_lines`→`invoices` FK ARE constraints
-- (both tables are wholly owned by this ADR).

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "InvoiceKind" AS ENUM (
    'ca_processing_mid_month',
    'ca_processing_eom',
    'ca_transportation_eom',
    'or_processing_eom',
    'or_transportation_eom',
    'or_collection_site_count'
);

CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'approved', 'void');

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — invoices (immutable-versioned artifact with a supersede chain)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "billing_month" DATE NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_id" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "total_cents" INTEGER NOT NULL,
    "generated_by" TEXT,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" TEXT,
    "approved_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "voided_at" TIMESTAMP(3),
    "gate_override_note" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoices_site_id_kind_billing_month_idx"
    ON "invoices"("site_id", "kind", "billing_month");

CREATE INDEX "invoices_site_id_status_idx"
    ON "invoices"("site_id", "status");

CREATE INDEX "invoices_supersedes_id_idx"
    ON "invoices"("supersedes_id");

ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoices"
    ADD CONSTRAINT "invoices_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — invoice_lines (one priced line, full rate_ref + source provenance)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "line_code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,2),
    "rate_ref" JSONB,
    "amount_cents" INTEGER NOT NULL,
    "source" JSONB,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_lines_invoice_id_position_idx"
    ON "invoice_lines"("invoice_id", "position");

ALTER TABLE "invoice_lines"
    ADD CONSTRAINT "invoice_lines_invoice_id_fkey"
    FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
