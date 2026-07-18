-- ADR-0042 amendment (2026-07-18) — mid-month COR support.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI, and is safe on the populated prod `cor_certificates` table):
--   1. One new enum type `CorPeriod` (end_of_month | mid_month).
--   2. One new column `period` with a DEFAULT — every existing row backfills to
--      `end_of_month`, so all current certificates keep their exact behavior
--      (reconcile tripwire + capacity banner + required FT/PT all remain in force).
--   3. `inventory_units` is WIDENED to nullable (DROP NOT NULL) — a mid-month
--      certificate files inventory BLANK. Dropping a NOT NULL is non-destructive:
--      existing values are untouched; only new mid-month rows store NULL.
--
-- The COR form (Exhibit 5) is used for both the end-of-month close and Rick's
-- mid-month filing (inventory + FT/PT blank, signature + date only). This
-- migration adds only the discriminator + the nullability the blank filing needs.
--
-- Dir name `20260726_adr0042_midmonth_cor` sorts AFTER the current chain tip
-- `20260725_adr0037_inventory_foundation`, preserving lexical migration ordering.

-- ADR-0042 amendment — end-of-month vs mid-month filing discriminator.
CREATE TYPE "CorPeriod" AS ENUM ('end_of_month', 'mid_month');

-- Additive: DEFAULT backfills every existing row to 'end_of_month' (behavior-preserving).
ALTER TABLE "cor_certificates"
    ADD COLUMN "period" "CorPeriod" NOT NULL DEFAULT 'end_of_month';

-- Widen inventory_units to nullable — a mid-month certificate has no inventory
-- figure. Non-destructive: existing (end-of-month) values are unchanged.
ALTER TABLE "cor_certificates"
    ALTER COLUMN "inventory_units" DROP NOT NULL;
