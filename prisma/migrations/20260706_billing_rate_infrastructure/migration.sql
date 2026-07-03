-- ADR-0040 — Billing rate infrastructure (transport tiers, account overrides,
-- container rentals, fuel prices, scoped rate-write access).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). Four new tables + two enums + one User flag. Money is integer CENTS;
-- effective windows are DATE. The P2 invoice layer (ADR-0041) becomes a pure read
-- of `state_program_rules` + these rate tables + operational data.
--
-- The dir name `20260706_billing_rate_infrastructure` sorts AFTER the current
-- main chain tip (`20260704_mymrc_mirrors`) and after the sibling migrations being
-- added in parallel (`20260704b_sync_run_correlation`, `20260705_audit_engine`) —
-- preserving ADR-0035 lexical migration ordering. This migration references only
-- `sources`, `sites`, and `users` (all present in the init chain), so it applies
-- cleanly on the current main chain with or without the sibling migrations.
--
-- FK columns (`source_id`, `site_id`) carry DB-level FOREIGN KEY constraints here
-- rather than Prisma relations, so the ADR-0040 schema block stays self-contained
-- (no back-relation fields on the sibling-owned `Source`/`Site` models). `created_by`
-- is a bare column (mirrors `state_program_rules.created_by`), not a constraint.

-- ─────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────
CREATE TYPE "TransportRateJurisdiction" AS ENUM ('CA', 'OR');

CREATE TYPE "FuelPriceSource" AS ENUM ('eia_api', 'manual');

-- ─────────────────────────────────────────────────────────────────────────
-- D5 — scoped rate-table write access (users.can_manage_rates)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "can_manage_rates" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────────
-- D1 — transport_rate_tiers (freight zone table)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "transport_rate_tiers" (
    "id" TEXT NOT NULL,
    "jurisdiction" "TransportRateJurisdiction" NOT NULL,
    "min_miles" INTEGER NOT NULL,
    "max_miles" INTEGER NOT NULL,
    "rate_cents" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "transport_rate_tiers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transport_rate_tiers_jurisdiction_effective_from_idx"
    ON "transport_rate_tiers"("jurisdiction", "effective_from");

-- ─────────────────────────────────────────────────────────────────────────
-- D2 — account_haul_rates (per-account freight override)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "account_haul_rates" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "rate_cents" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_haul_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "account_haul_rates_source_id_effective_from_idx"
    ON "account_haul_rates"("source_id", "effective_from");

ALTER TABLE "account_haul_rates"
    ADD CONSTRAINT "account_haul_rates_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D3 — container_rental_sites (monthly trailer/container rentals)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "container_rental_sites" (
    "id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "location_name" TEXT NOT NULL,
    "source_id" TEXT,
    "trailer_count" INTEGER NOT NULL,
    "trailer_size" TEXT,
    "monthly_rate_cents" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "container_rental_sites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "container_rental_sites_site_id_effective_from_idx"
    ON "container_rental_sites"("site_id", "effective_from");

ALTER TABLE "container_rental_sites"
    ADD CONSTRAINT "container_rental_sites_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "container_rental_sites"
    ADD CONSTRAINT "container_rental_sites_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- D4 — fuel_prices (weekly diesel index)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE "fuel_prices" (
    "id" TEXT NOT NULL,
    "week_of" DATE NOT NULL,
    "usd_per_gal" DECIMAL(5,3) NOT NULL,
    "source" "FuelPriceSource" NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fuel_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fuel_prices_week_of_key" ON "fuel_prices"("week_of");
