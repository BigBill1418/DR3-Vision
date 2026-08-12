-- ADR-0071 Amendment 2: default flag threshold moves 2 -> 3 misses per week.
-- Existing rows are updated separately by the operator (runtime-tunable by
-- design); this only changes the default for future site configs.
ALTER TABLE "processor_quota_config" ALTER COLUMN "min_misses" SET DEFAULT 3;
