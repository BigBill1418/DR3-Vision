-- ADR-0036 — Survey daily reminders + campaign auto-close.
-- Adds per-invite reminder tracking that gates the once-per-day reminder cron.
-- `last_reminder_at` is the 20h daily gate (send only when NULL or older than
-- the window, stamped only on a successful send); `reminder_count` records how
-- many reminders have been delivered. Pure additive DDL — both columns are safe
-- against existing rows: `last_reminder_at` is nullable (defaults to NULL =
-- "never reminded, eligible on the next tick") and `reminder_count` carries a
-- NOT NULL DEFAULT 0. No FKs, no type changes (ids stay TEXT per this repo's
-- convention — see 20260622_operational_intelligence_survey).

ALTER TABLE "survey_invites"
  ADD COLUMN "last_reminder_at" TIMESTAMP(3);

ALTER TABLE "survey_invites"
  ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0;
