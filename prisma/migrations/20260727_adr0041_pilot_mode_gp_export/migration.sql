-- ADR-0041 amendment (2026-07-18) — SIMPLIFIED invoice generation: pilot/production
-- launch safety net, program/non-program billing basis, GP export identifiers.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in CI).
-- The dir name `20260727_adr0041_pilot_mode_gp_export` sorts AFTER the current main
-- chain tip (`20260726_adr0040_rate_infrastructure`), preserving ADR-0035 lexical
-- migration ordering.
--
-- Backfill safety: `invoices.mode` is added with DEFAULT 'pilot' NOT NULL, so every
-- pre-existing invoice row becomes `pilot` — nothing already on file can reach MRC
-- until an admin explicitly flips its (site, kind) to production. The two unit-count
-- columns are NULLABLE (only processing invoices carry them; pre-existing rows stay
-- NULL — a faithful "not recorded on this row" rather than a fabricated 0).
--
-- `site_id` columns on the new config tables carry DB-level FOREIGN KEY constraints
-- (bare columns, no Prisma back-relations) to keep the amendment block self-contained,
-- mirroring the ADR-0040/0041/0042 blocks. `created_by`/`updated_by` are bare
-- audit-actor columns.

-- ── enum ────────────────────────────────────────────────────────────────────
CREATE TYPE "InvoiceMode" AS ENUM ('pilot', 'production');

-- ── invoices: pilot mode + program/non-program split (additive columns) ───────
ALTER TABLE "invoices" ADD COLUMN "mode" "InvoiceMode" NOT NULL DEFAULT 'pilot';
ALTER TABLE "invoices" ADD COLUMN "program_units_processed" DECIMAL(9,1);
ALTER TABLE "invoices" ADD COLUMN "non_program_units_processed" DECIMAL(9,1);

-- ── invoice_pilot_recipients (Bill + Rick roster) ─────────────────────────────
CREATE TABLE "invoice_pilot_recipients" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pilot_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_pilot_recipients_email_key" ON "invoice_pilot_recipients"("email");
CREATE INDEX "invoice_pilot_recipients_active_idx" ON "invoice_pilot_recipients"("active");

-- ── invoice_mode_config (per site+kind flip; no row ⇒ pilot) ──────────────────
CREATE TABLE "invoice_mode_config" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "mode" "InvoiceMode" NOT NULL DEFAULT 'pilot',
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_mode_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_mode_config_site_id_kind_key" ON "invoice_mode_config"("site_id", "kind");

ALTER TABLE "invoice_mode_config"
    ADD CONSTRAINT "invoice_mode_config_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── gp_billing_config (company-wide GP statics; one row id="singleton") ────────
CREATE TABLE "gp_billing_config" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "bill_to_name" TEXT NOT NULL,
    "bill_to_attn" TEXT,
    "bill_to_street" TEXT NOT NULL,
    "bill_to_locality" TEXT NOT NULL,
    "sales_id" TEXT NOT NULL,
    "payment_terms" TEXT NOT NULL,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gp_billing_config_pkey" PRIMARY KEY ("id")
);

-- ── gp_site_billing_config (per-site Customer ID + PO suffix) ──────────────────
CREATE TABLE "gp_site_billing_config" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "po_site_suffix" TEXT,
    "pending_note" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gp_site_billing_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "gp_site_billing_config_site_id_key" ON "gp_site_billing_config"("site_id");

ALTER TABLE "gp_site_billing_config"
    ADD CONSTRAINT "gp_site_billing_config_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
