-- ADR-0042 — COR generator (cor_certificates + cor_site_config).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Two new tables + one enum. Inventory is an integer unit count; the cover
-- month is a DATE. COR generation is a pure read of the ADR-0037 running balance
-- + the daily-close series + the site signer config — this migration only adds
-- the artifact store the generated + reviewed result lands in.
--
-- The dir name `20260708_cor_certificates` sorts AFTER the current main chain tip
-- (`20260707_invoice_generation`) — preserving ADR-0035 lexical migration
-- ordering. This migration references only `sites` (present in the init chain),
-- so it applies cleanly on top of the whole chain.
--
-- FK columns to sibling-owned models (`site_id`) carry a DB-level FOREIGN KEY
-- constraint here rather than a Prisma relation, so the ADR-0042 schema block
-- stays self-contained (no back-relation fields on the shared `Site` model). The
-- audit-actor columns (`prepared_by`/`finalized_by`) are bare columns (mirrors
-- `invoices.generated_by`), not constraints. The `supersedes_id` self-FK IS a
-- constraint (the table is wholly owned by this ADR).

-- ─────────────────────────────────────────────────────────────────────────
-- Enum
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "CorStatus" AS ENUM ('draft', 'finalized', 'void');

-- ─────────────────────────────────────────────────────────────────────────
-- D2.3 — cor_site_config (site-scoped signer, one row per CA site)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "cor_site_config" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_title" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cor_site_config_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cor_site_config_site_id_key" ON "cor_site_config"("site_id");

ALTER TABLE "cor_site_config"
    ADD CONSTRAINT "cor_site_config_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — cor_certificates (immutable-versioned artifact with a supersede chain)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "cor_certificates" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "cover_month" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "supersedes_id" TEXT,
    "status" "CorStatus" NOT NULL DEFAULT 'draft',
    "inventory_units" INTEGER NOT NULL,
    "inventory_source" JSONB NOT NULL,
    "ft_headcount" INTEGER,
    "pt_headcount" INTEGER,
    "headcount_source" JSONB NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_title" TEXT NOT NULL,
    "prepared_by" TEXT,
    "prepared_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalized_by" TEXT,
    "finalized_at" TIMESTAMP(3),
    "pdf_storage_key" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cor_certificates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cor_certificates_site_id_cover_month_idx"
    ON "cor_certificates"("site_id", "cover_month");

CREATE INDEX "cor_certificates_site_id_status_idx"
    ON "cor_certificates"("site_id", "status");

CREATE INDEX "cor_certificates_supersedes_id_idx"
    ON "cor_certificates"("supersedes_id");

ALTER TABLE "cor_certificates"
    ADD CONSTRAINT "cor_certificates_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cor_certificates"
    ADD CONSTRAINT "cor_certificates_supersedes_id_fkey"
    FOREIGN KEY ("supersedes_id") REFERENCES "cor_certificates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
