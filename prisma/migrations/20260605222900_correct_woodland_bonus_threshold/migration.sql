-- T-101: Correct the Woodland processor bonus high threshold (75 -> 74) per ADR-0019 §1.
--
-- The original spreadsheet (Bonus_Spread_Sheet_2026.xlsx) used a high threshold
-- of 75, which underpaid processors by ~$0.25/day on high-throughput days. The
-- corrected formula is:
--
--   daily_bonus = MAX(units - 50, 0) * $0.50 + MAX(units - 74, 0) * $0.25
--
-- This migration is DEFENSIVE: no processor_bonus_rules row is expected to exist
-- in production yet (the portal was not built when this shipped). It updates the
-- Woodland rule in place if present, and is idempotent (the `threshold_high = 75`
-- guard means a re-run after correction is a no-op).
UPDATE "processor_bonus_rules"
SET
  "threshold_high" = 74,
  "notes" = 'Woodland daily bonus = MAX(units - 50, 0) * $0.50 + MAX(units - 74, 0) * $0.25. Spec per ADR-0019 §1 (replaces incorrect 75 threshold from original spreadsheet). Mattress 51-74 earns $0.50; mattress 75+ earns $0.75.'
WHERE
  "site_id" IN (SELECT "id" FROM "sites" WHERE "code" = 'woodland')
  AND "threshold_high" = 75;
