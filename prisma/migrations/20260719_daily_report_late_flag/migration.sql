-- 2026-07-11 (operator directive, Bill): production data goes out to the team
-- as soon as it is saved, even when the site missed the scheduled report time —
-- flagged with when it was submitted. PURELY ADDITIVE (ADR-0035 clean-replay).
ALTER TABLE "bonus_daily_report_log" ADD COLUMN "late_submission" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bonus_daily_report_log" ADD COLUMN "data_entered_at" TIMESTAMP(3);
ALTER TABLE "bonus_daily_report_log" ADD COLUMN "resend_count" INTEGER NOT NULL DEFAULT 0;
