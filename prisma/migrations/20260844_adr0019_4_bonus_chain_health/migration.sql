-- ADR-0019.4 — standing signature-chain health ledger.
--
-- One row per poll per site. The previous row's `status` is the last-known state
-- that the leading-edge pager compares against, so paging decisions survive the
-- container recreation that every deploy performs.

CREATE TABLE "bonus_chain_health_runs" (
    "id" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "site_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "findings" JSONB NOT NULL,
    "paged" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "bonus_chain_health_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bonus_chain_health_runs_site_id_observed_at_idx"
    ON "bonus_chain_health_runs"("site_id", "observed_at");

CREATE INDEX "bonus_chain_health_runs_observed_at_idx"
    ON "bonus_chain_health_runs"("observed_at");

ALTER TABLE "bonus_chain_health_runs"
    ADD CONSTRAINT "bonus_chain_health_runs_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
