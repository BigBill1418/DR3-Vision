-- ADR-0040 amendment (2026-07-18, rollup §3.3) — per-source, effective-dated service
-- rates for the Oregon program billing components (trans / trailer / per-mattress /
-- MRC unit).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in CI).
-- ONE enum + ONE table. Money is integer CENTS; effective windows are DATE. This
-- parallels `account_haul_rates` (the existing per-source effective-dated rate
-- pattern) — same shape, same tie/window discipline in the resolver.
--
-- The dir name `20260726_adr0040_rate_infrastructure` sorts AFTER the current main
-- chain tip (`20260725_adr0037_inventory_foundation`), preserving ADR-0035 lexical
-- migration ordering. It references only `sources` (present in the init chain), so it
-- applies cleanly.
--
-- NO ROWS ARE SEEDED HERE. The §7 seed PR loads the OR source rate rows (The Dalles
-- effective 2026-06-01; the rest 2026-01-01) after this merges — seeding source-
-- specific rates before Rick confirms them would launder unconfirmed numbers into
-- "truth" (same discipline as the ADR-0040 account_haul_rates / container_rental_sites
-- deliberate empties).
--
-- The `source_id` FK carries a DB-level FOREIGN KEY constraint (bare column, no Prisma
-- back-relation) to keep the ADR-0040 block self-contained, mirroring
-- `account_haul_rates`. `created_by` is a bare column (mirrors `state_program_rules`).

CREATE TYPE "SourceServiceRateKind" AS ENUM ('trans', 'trailer', 'per_mattress', 'mrc_unit');

CREATE TABLE "source_service_rates" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "rate_kind" "SourceServiceRateKind" NOT NULL,
    "rate_cents" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_service_rates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "source_service_rates_source_id_rate_kind_effective_from_idx"
    ON "source_service_rates"("source_id", "rate_kind", "effective_from");

ALTER TABLE "source_service_rates"
    ADD CONSTRAINT "source_service_rates_source_id_fkey"
    FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
