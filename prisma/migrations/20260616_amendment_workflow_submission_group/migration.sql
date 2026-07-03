-- ADR-0029: amendment notification batching — one notification per root action.
--
-- Adds a nullable grouping key so the N requests created by a single manager
-- "save" (a multi-line prior-day correction) can be stamped with a shared id
-- and notified ONCE per direction (submit / approve / reject) instead of once
-- per line.
--
-- Purely additive and idempotent: the column is nullable TEXT (NOT UUID — this
-- database stores all ids/FKs as TEXT; a UUID-typed column is incompatible with
-- the TEXT ids it would be compared against, which is exactly what broke prod
-- in the original ADR-0028 migration). Existing rows — including any live-test
-- pending request already in prod — keep submission_group_id = NULL and continue
-- to behave as singletons. No data is rewritten.

ALTER TABLE "bonus_amendment_requests"
  ADD COLUMN IF NOT EXISTS "submission_group_id" TEXT;

CREATE INDEX IF NOT EXISTS "bonus_amendment_requests_submission_group_idx"
  ON "bonus_amendment_requests"("submission_group_id");
