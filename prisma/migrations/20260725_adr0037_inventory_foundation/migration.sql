-- ADR-0037 amendment — inventory + sources foundation (rollup 2026-07-17 §8.1).
-- PURELY ADDITIVE (ADR-0035 clean-replay): one new enum type + nullable/defaulted
-- columns only. Every column has a default or is nullable, so the migration is safe
-- on populated prod tables and replays cleanly on empty PG16.
--
-- Dir name sorts after 20260724_admin_file_drops.

-- Site billing taxonomy (rollup §3.2, Rick 2026-07-17). Four billing routings.
CREATE TYPE "SourceSiteType" AS ENUM (
  'mrc_inbound',
  'cvp_retailer',
  'collection_site',
  'third_party_inbound'
);

-- Source billing routing columns (§3.2). `site_type` is nullable (legacy seeds
-- predate the taxonomy). `active_billing` false suppresses all invoice lines
-- (Roseburg pattern). `bill_trans` / `bill_trailer` are per-source overrides of the
-- site_type default (Cottage Grove: both false).
ALTER TABLE "sources"
  ADD COLUMN "site_type" "SourceSiteType",
  ADD COLUMN "active_billing" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bill_trans" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "bill_trailer" BOOLEAN NOT NULL DEFAULT true;

-- Consumer drop-off traceability (§1.3, Kelsey Q4). `consumer_name` is optional CIP
-- PII for traceable unpaid records (distinct from the required incentive-payee
-- `person_name`). `incentive_amount_cents` is the explicit unpaid check amount
-- (default units × 300¢ = $3/unit at capture, overridable) — distinct from the
-- rule-capped, incentive-kind-only `incentive_cents`.
ALTER TABLE "consumer_dropoffs"
  ADD COLUMN "consumer_name" TEXT,
  ADD COLUMN "incentive_amount_cents" INTEGER;
