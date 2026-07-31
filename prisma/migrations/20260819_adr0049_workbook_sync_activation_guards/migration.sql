-- ADR-0049 Amendment 3 — the workbook-sync activation guards (A4).
--
-- WHY: the 2026-07-30 pre-activation assessment found that two of the three ways
-- this sync goes quiet page nobody, and that nothing reads the run ledger except an
-- admin page somebody has to choose to open.
--
--   * A missing file (`not_found`) logs at INFO. The ntfy calls live only in the
--     engine's catch block, which `not_found` never reaches — so a renamed, typo'd
--     or `… (1).xlsm`-copied workbook goes silent FOREVER.
--   * An unreadable rollout state was recorded as `status = 'ok'` with
--     `cutover_noop = true` — a row asserting a site is cut over when it is not,
--     while the sync silently stops feeding Vision.
--   * `workbook_sources` recorded `last_polled_at` and nothing else, so "we polled"
--     was a fact and "we last got data on ___" was not. A source dead for three
--     weeks looked exactly like a healthy one.
--
-- This migration adds the state those alarms need. The alarms themselves live in
-- `src/lib/workbook-sync/engine.ts`, graded per ADR-0037: at most one `high` per
-- site per 24 h, escalated rather than repeated, and durable across restarts —
-- the previous 30-minute in-process cooldown reset on every container restart and
-- produced ~28 identical pages per business day on a stuck refusal.
--
-- HOUSE RULES OBSERVED:
--   * `id` / FK columns are TEXT, never `uuid` — a `uuid`-typed id passes CI (which
--     does not run migrations) and fails only on deploy, taking the app down. This
--     migration adds no id column, so the rule is satisfied vacuously; it is
--     restated because the next hand to edit this file will need it.
--   * No APPLIED migration is modified — migrations are checksum-locked.
--   * `ALTER TYPE … ADD VALUE` is legal inside a transaction block from PG12 on so
--     long as the new value is not USED in the same transaction. Nothing below uses
--     it, so this replays cleanly under `prisma migrate deploy` (one txn per file).
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty
-- PG16). One new enum value, three nullable/defaulted columns. No existing object
-- is altered, no data is rewritten, no backfill is required — a source with no
-- successful poll yet reads NULL, which is exactly the honest answer.

-- ── The status that says "nothing ran, and nothing is wrong" ─────────────────
-- Previously the engine had only ok / forbidden / not_found / error, so a poll it
-- deliberately declined to run had to borrow `ok`. That is the failure signature
-- this codebase keeps producing: a state meaning "I am not really connected"
-- recorded as a state meaning "fine".
ALTER TYPE "WorkbookSyncStatus" ADD VALUE IF NOT EXISTS 'skipped';

-- ── The watermark that makes staleness observable ───────────────────────────
-- Set on every poll that READ the workbook — including a delta no-op (cTag
-- unchanged) and a legitimately empty month, because both prove the file is
-- reachable and parseable. NEVER set on `not_found` and never on a refusal: those
-- are precisely the states the staleness alarm exists to notice.
ALTER TABLE "workbook_sources" ADD COLUMN IF NOT EXISTS "last_success_at" TIMESTAMP(3);

-- ── The escalation ladder's state ───────────────────────────────────────────
-- `consecutive_failures` resets to 0 on any success. `last_alert_at` is the
-- DURABLE half of the per-site page cooldown: `src/lib/ntfy.ts` keeps its ledger in
-- a process-local Map, so a restart wiped it and the identical page resumed at full
-- rate. A column survives restarts.
ALTER TABLE "workbook_sources" ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workbook_sources" ADD COLUMN IF NOT EXISTS "last_alert_at" TIMESTAMP(3);
