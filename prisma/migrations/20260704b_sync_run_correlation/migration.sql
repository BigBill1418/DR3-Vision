-- ADR-0038 hardening (2026-07-03) — MyMRC sync-run correlation id.
--
-- Additive only (ADR-0035 gate): one new nullable column on the existing run
-- ledger, no changes to any other table. Named `20260704b_sync_run_correlation`
-- to sort AFTER `20260704_mymrc_mirrors` per the ADR-0035 lexical ordering rule.
--
-- `run_id` is a crypto.randomUUID minted once per site+feed run and stamped on
-- every structured log line of that run, so a run's logs and its ledger row can
-- be correlated in Loki without joining on timestamps. Nullable: historical rows
-- (and any run whose ledger write predates this column) carry NULL.

-- AlterTable
ALTER TABLE "mymrc_sync_runs" ADD COLUMN "run_id" TEXT;
