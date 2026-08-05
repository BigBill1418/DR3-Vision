-- ADR-0076 — distinct-processor headcounts on the daily production report log.
-- Additive + nullable: rows written before this migration genuinely did not
-- carry these figures (a 0 default would assert a false fact about past sends).
ALTER TABLE "bonus_daily_report_log" ADD COLUMN IF NOT EXISTS "processors_today" integer;
ALTER TABLE "bonus_daily_report_log" ADD COLUMN IF NOT EXISTS "processors_mtd" integer;
