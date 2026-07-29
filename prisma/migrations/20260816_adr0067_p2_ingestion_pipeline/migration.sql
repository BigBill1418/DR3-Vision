-- ADR-0067 §3.2 D4–D8 / §3.4 — shared-file document ingestion, PIPELINE phase.
--
-- The FOUNDATION migration (20260815) landed the five tables, the delegated
-- connection and the `file_drops` provenance columns. This migration adds only
-- what the pipeline itself needs: discovery/traversal bookkeeping, the
-- classify-once-confirm-once proposal columns, the staged-change columns that
-- make the D7 guardrail "stage and page" rather than "gate every change", and
-- the anomaly kinds those checks raise.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty
-- PG16 in CI). Every existing row keeps working: every new column is nullable or
-- carries a default that is TRUE of the rows already there.
--
-- `id` columns are TEXT, never `uuid` — a `uuid`-typed id passes CI (which does
-- not run migrations) and fails only on deploy, taking the app down. House rule.
-- Validated against LIVE PROD inside a `BEGIN; … ROLLBACK;` before commit.
--
-- ── PG note on the enum additions ───────────────────────────────────────────
-- `ALTER TYPE … ADD VALUE` is legal inside a transaction block from PG12 on, so
-- long as the new value is not USED in the same transaction. Nothing below
-- inserts a row using one, so this replays cleanly under `prisma migrate deploy`
-- (which wraps each file in a transaction) on the PG16 prod server.

-- ─────────────────────────────────────────────────────────────────────────────
-- Anomaly kinds — the D7 guardrail + the D8 operational conditions
--
-- The foundation shipped the transport-level kinds (access_denied,
-- source_disappeared, subscription_*, delta_token_invalid, download_failed,
-- checksum_mismatch, oversize, unclassified, reauth_required). These are the
-- CONTENT-level and traversal-level ones the pipeline actually detects.
-- ─────────────────────────────────────────────────────────────────────────────

-- D8: the sharer's account was disabled or they left. Distinct from
-- `access_denied` (share revoked, account fine) because the operator action is
-- "find out who owns this now", and the alert must NAME the previous owner.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'owner_lost';

-- D8: password-protected / structurally unreadable. Marked and paged ONCE —
-- explicitly never retried in a loop, which is why the source carries a
-- `read_blocked_at` latch rather than this being recomputed every sweep.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'unreadable';

-- D7: a billing/inventory aggregate moved beyond the variance threshold. Uses
-- the SAME either-trips $50-flat / 15-percent semantics as ADR-0046 Amendment 5
-- D-M5-4 — deliberately one anomaly concept in the system, not two.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'aggregate_variance';

-- D7: a previously-populated column went empty/null across a revision.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'column_nulled';

-- D7: the revision dropped more than the configured share of rows.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'row_count_drop';

-- D7: the revision no longer parses as its REGISTERED classification. This is
-- also the ONLY trigger for re-classification (D5 forbids re-asking otherwise).
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'parse_broken';

-- §A.9: the Graph validation-token handshake failed on subscription creation.
-- Surfaced rather than silently degrading to polling-only: the sweep still
-- guarantees correctness, but LATENCY degrades and the operator must know.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'webhook_validation_failed';

-- The sweep itself failed. The sweep is the correctness guarantee (D4); a
-- silently failing sweep is precisely the ADR-0057 D9 / MyMRC failure mode.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'sweep_failed';

-- D5: a vendor invoice was shared here. It is NOT routed by this pipeline — the
-- AP mailbox (ADR-0046) is its address. Flagged, never silently ingested, and
-- the detail line states the correct address.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'misdirected_document';

-- D8: a shared folder tree is deeper than the configured traversal limit. The
-- limit is real (it bounds the enumeration) but hitting it means files exist
-- that Vision is NOT watching, which must never be silent.
ALTER TYPE "DocIngestAnomalyKind" ADD VALUE IF NOT EXISTS 'depth_limit_reached';

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_sources — traversal bookkeeping, the classification PROPOSAL, and the
-- unreadable latch
-- ─────────────────────────────────────────────────────────────────────────────

-- Folder traversal (D8 "nested folders"). `parent_item_id` is the driveItem id
-- of the containing folder within the SAME drive; NULL means this row is a
-- shared root (the thing a human actually shared). `depth` is 0 at that root.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "parent_item_id" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "depth" INTEGER NOT NULL DEFAULT 0;

-- D8 "same file shared twice": two people sharing one item yields ONE logical
-- source (the (drive_id, item_id) natural key guarantees that). This counter is
-- the evidence that the dedup happened, so the operator surface can say so
-- instead of leaving it looking like a coincidence.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "shared_by_count" INTEGER NOT NULL DEFAULT 1;

-- D5 — classify ONCE, confirm ONCE, then LOCKED.
--
-- The classifier writes the PROPOSAL columns. `doc_class` (foundation) stays
-- NULL until a human confirms, and once set it is registered and stable — the
-- pipeline never re-asks. That split is the whole point: a non-null `doc_class`
-- IS the lock, so there is no separate boolean to drift out of agreement with it.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_class" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_site_id" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_period" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_confidence" DOUBLE PRECISION;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_reasoning" TEXT;
-- 'local' | 'claude' — which half of the D-M5-2 hybrid produced the proposal.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "proposed_source" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "classification_attempted_at" TIMESTAMP(3);
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "classification_error" TEXT;

-- The confirmed reporting period, set alongside `doc_class` at confirm time.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "period" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "classified_by" TEXT; -- bare audit-actor id

-- D8 "password-protected / unreadable — mark, page, DO NOT retry in a loop".
-- The latch is what stops the loop. It is cleared when the CONTENT changes
-- (a new ctag is a genuinely new file and earns exactly one more attempt),
-- which is why the ctag that blocked is recorded alongside the reason.
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "read_blocked_at" TIMESTAMP(3);
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "read_blocked_reason" TEXT;
ALTER TABLE "doc_sources" ADD COLUMN IF NOT EXISTS "read_blocked_ctag" TEXT;

CREATE INDEX IF NOT EXISTS "doc_sources_parent_item_id_idx"
  ON "doc_sources" ("drive_id", "parent_item_id");

-- The confirm queue's driving index: unconfirmed (doc_class IS NULL) sources
-- that have been classified. Partial so it stays small as the confirmed set grows.
CREATE INDEX IF NOT EXISTS "doc_sources_pending_confirmation_idx"
  ON "doc_sources" ("classification_attempted_at")
  WHERE "doc_class" IS NULL;

DO $$ BEGIN
  ALTER TABLE "doc_sources"
    ADD CONSTRAINT "doc_sources_proposed_site_id_fkey"
    FOREIGN KEY ("proposed_site_id") REFERENCES "sites"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_source_versions — the STAGED-change columns (D6 + D7)
--
-- D6 says changes propagate automatically after confirmation: per-change
-- approval would defeat the whole feature. D7 replaces that gate with a
-- guardrail that catches ABNORMAL changes. So a version is in exactly one of
-- three states:
--
--   applied   — auto-flowed (the normal case), `applied_at` set, audit written
--   staged    — a guardrail condition tripped; held for apply-or-discard
--   discarded — a human rejected the staged revision
--
-- `parse_summary` is the structural projection the guardrail compares
-- revision-over-revision (row count, populated columns, numeric aggregates). It
-- is the "before" of the next comparison and the "after" of this one, which is
-- why it lives on the version row rather than being recomputed.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "staged" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "staged_reason" TEXT;
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "applied_at" TIMESTAMP(3);
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "applied_by" TEXT; -- bare audit-actor id
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "discarded_at" TIMESTAMP(3);
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "discarded_by" TEXT;
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "parse_summary" JSONB;
ALTER TABLE "doc_source_versions" ADD COLUMN IF NOT EXISTS "parse_error" TEXT;

-- Drives the anomalies page's "what is waiting on a human" query.
CREATE INDEX IF NOT EXISTS "doc_source_versions_staged_idx"
  ON "doc_source_versions" ("observed_at")
  WHERE "staged" = true;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_anomalies — the version edge + the shared page ledger
-- ─────────────────────────────────────────────────────────────────────────────

-- Which revision this anomaly is ABOUT. Required for the before/after diff on
-- /admin/doc-ingest/anomalies and for apply-or-discard to know its target.
-- SET NULL on delete, matching the source edge: an anomaly whose subject is
-- gone is exactly the anomaly you most want to still be able to read.
ALTER TABLE "doc_ingest_anomalies" ADD COLUMN IF NOT EXISTS "doc_source_version_id" TEXT;

-- Last time THIS anomaly paged. Same reasoning as
-- `doc_ingest_connections.reauth_paged_at`: `publishNtfy`'s cooldown ledger is
-- per-process and per-container, so it would either re-page on every restart or
-- suppress the FIRST page after one. The DB column is the ledger every process
-- shares.
ALTER TABLE "doc_ingest_anomalies" ADD COLUMN IF NOT EXISTS "last_paged_at" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "doc_ingest_anomalies_doc_source_version_id_idx"
  ON "doc_ingest_anomalies" ("doc_source_version_id");

DO $$ BEGIN
  ALTER TABLE "doc_ingest_anomalies"
    ADD CONSTRAINT "doc_ingest_anomalies_doc_source_version_id_fkey"
    FOREIGN KEY ("doc_source_version_id") REFERENCES "doc_source_versions"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_subscriptions — webhook observability (§A.9)
-- ─────────────────────────────────────────────────────────────────────────────

-- When Graph last actually delivered a notification here. This is the ONLY
-- honest measure of whether push is working; `state = active` merely means the
-- subscription exists. A subscription that is active but has never delivered is
-- the silent-webhook failure the sweep exists to cover.
ALTER TABLE "doc_ingest_subscriptions" ADD COLUMN IF NOT EXISTS "last_notification_at" TIMESTAMP(3);
-- When the validation-token handshake last succeeded. NULL on an active
-- subscription means push was never empirically proven.
ALTER TABLE "doc_ingest_subscriptions" ADD COLUMN IF NOT EXISTS "validated_at" TIMESTAMP(3);
ALTER TABLE "doc_ingest_subscriptions" ADD COLUMN IF NOT EXISTS "notifications_received" INTEGER NOT NULL DEFAULT 0;


-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_sweep_runs — the sweep ledger
--
-- Mirrors `ap_poll_runs` (ADR-0046 C6) and for the same reason: the row is
-- ALWAYS written, including on throw. Without a ledger, "the sweep has not run
-- in three weeks" is invisible — which is exactly how MyMRC ingested nothing
-- for months (ADR-0057 D9). The health surface reads `last sweep` from here,
-- and a stale ledger is itself the alarm.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_ingest_sweep_runs" (
  "id"                  TEXT PRIMARY KEY,
  "started_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"         TIMESTAMP(3),
  -- 'ok' | 'partial' | 'failed' | 'halted' | 'skipped'. TEXT rather than an enum
  -- so a new outcome never needs a migration; the values are asserted in code.
  "status"              TEXT NOT NULL,
  -- 'scheduled' | 'notification' | 'manual' — WHY this run happened. The
  -- distinction matters: a fleet of `notification` runs with no `scheduled` ones
  -- means the cron is dead and only push is keeping things current, which is the
  -- exact posture D4 forbids relying on.
  "trigger"             TEXT NOT NULL DEFAULT 'scheduled',
  "sources_discovered"  INTEGER NOT NULL DEFAULT 0,
  "sources_updated"     INTEGER NOT NULL DEFAULT 0,
  "versions_created"    INTEGER NOT NULL DEFAULT 0,
  "versions_applied"    INTEGER NOT NULL DEFAULT 0,
  "versions_staged"     INTEGER NOT NULL DEFAULT 0,
  "anomalies_raised"    INTEGER NOT NULL DEFAULT 0,
  "subscriptions_renewed" INTEGER NOT NULL DEFAULT 0,
  "error"               TEXT,  -- human error text; never credentials or PII
  "run_id"              TEXT,  -- per-run correlation id (crypto.randomUUID)
  "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "doc_ingest_sweep_runs_started_at_idx"
  ON "doc_ingest_sweep_runs" ("started_at");

CREATE INDEX IF NOT EXISTS "doc_ingest_sweep_runs_status_started_at_idx"
  ON "doc_ingest_sweep_runs" ("status", "started_at");
