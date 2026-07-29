-- ADR-0067 §3.3 + Amendment A — shared-file document ingestion, FOUNDATION.
--
-- WHY: Bill hand-uploads every document Vision needs. A forwarded email is a
-- SNAPSHOT — the moment it left the sender it stopped tracking the source. A
-- shared FILE is current state: the document stays where it lives in Microsoft,
-- is shared to the `docs-dr3@svdp.us` service account, and Vision reads the LIVE
-- document. That distinction is the whole point of this ADR, and it is why the
-- schema is version-aware (`doc_source_versions`) rather than drop-shaped.
--
-- PURELY ADDITIVE / CLEAN-REPLAY SAFE (ADR-0035 invariant: replays on an empty
-- PG16 in CI). Every existing `file_drops` row keeps working unchanged: the new
-- `ingest_source` column defaults to 'manual' and `doc_source_id` is NULL.
-- Nothing here reads or rewrites an existing row.
--
-- `id` columns are TEXT (`gen_random_uuid()::text`) per the repo's hand-written
-- migration rule — a `uuid`-typed id passes CI (which does not run migrations)
-- and only fails on deploy, taking the app down. Validated against LIVE PROD
-- inside a rolled-back transaction before commit.
--
-- ── Auth model (Amendment A, supersedes §3.5 entirely) ──────────────────────
-- Authorization-code + refresh token, NOT ROPC. A human (Bill) signs in ONCE,
-- interactively, in a browser, as docs-dr3@svdp.us, completing MFA. Vision
-- exchanges the code and rolls the refresh token forward. The service-account
-- PASSWORD is never a runtime credential and has no column here — if a column
-- for it ever appears, the design has regressed.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums
-- ─────────────────────────────────────────────────────────────────────────────

-- How a file_drops row got here. 'manual' is the pre-ADR-0067 world and stays
-- the default forever, so historical rows are correct without a backfill.
CREATE TYPE "DocIngestSource" AS ENUM ('manual', 'email', 'shared_file');

CREATE TYPE "DocSourceKind" AS ENUM ('file', 'folder');

-- 'access_denied' is deliberately NOT folded into 'disappeared'. A revoked share
-- and a deleted file look identical from a 404 but need different operator
-- action, and collapsing them is how "the document is gone" silently becomes
-- "nobody noticed the share lapsed".
CREATE TYPE "DocSourceState" AS ENUM ('active', 'disappeared', 'access_denied');

CREATE TYPE "DocIngestSubscriptionState" AS ENUM (
  'pending', 'active', 'expired', 'failed', 'revoked'
);

CREATE TYPE "DocIngestAnomalyKind" AS ENUM (
  'access_denied',
  'source_disappeared',
  'subscription_expired',
  'subscription_renew_failed',
  'delta_token_invalid',
  'download_failed',
  'checksum_mismatch',
  'oversize',
  'unclassified',
  'reauth_required'
);

CREATE TYPE "DocIngestAnomalySeverity" AS ENUM ('info', 'warning', 'critical');

CREATE TYPE "DocIngestAnomalyStatus" AS ENUM ('open', 'acknowledged', 'resolved');

-- Two states, deliberately. There is no 'degraded'. Amendment A §A.6: ingestion
-- halts LOUDLY rather than degrading quietly, so the only alternative to
-- 'connected' is "a human must sign in again".
CREATE TYPE "DocIngestConnectionState" AS ENUM ('connected', 'reauth_required');

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_connections — the delegated Entra connection (Amendment A §A.7)
--
-- Singleton row (`id = 'singleton'`), same shape as `mymrc_admin_credentials`
-- (ADR-0057 D1/D9): AES-256-GCM ciphertext + iv + auth tag + key_version, key
-- from a DEDICATED secret under ~/.dr3-vision-secrets/. Never a .env credential.
--
-- tenant_id / client_id / account_upn / account_object_id are NOT secrets
-- (Amendment A §A.1) and may appear in config, logs and API responses. The
-- tokens are, and are never SELECTed by the status path.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_ingest_connections" (
  "id"                          TEXT PRIMARY KEY DEFAULT 'singleton',

  -- Non-secret identity of the connection (§A.1).
  "tenant_id"                   TEXT NOT NULL,
  "client_id"                   TEXT NOT NULL,
  "account_upn"                 TEXT NOT NULL,
  "account_object_id"           TEXT,

  -- Refresh token: the only durable credential. Rolled forward on every refresh.
  "refresh_token_ciphertext"    TEXT NOT NULL,
  "refresh_token_iv"            TEXT NOT NULL,
  "refresh_token_auth_tag"      TEXT NOT NULL,
  "refresh_token_issued_at"     TIMESTAMP(3) NOT NULL,

  -- Access token cache. Nullable: a connection with an expired access token is
  -- healthy (the refresh token regenerates it); a connection with no refresh
  -- token is not, which is why only the refresh columns are NOT NULL.
  "access_token_ciphertext"     TEXT,
  "access_token_iv"             TEXT,
  "access_token_auth_tag"       TEXT,
  "access_token_expires_at"     TIMESTAMP(3),

  "key_version"                 INTEGER NOT NULL DEFAULT 1,

  -- Space-delimited scope string exactly as the token endpoint returned it.
  -- Stored verbatim so the connect surface can diff granted-vs-required (§A.6)
  -- without re-deriving what Entra actually consented.
  "granted_scopes"              TEXT NOT NULL,

  "acquired_at"                 TIMESTAMP(3) NOT NULL,
  "last_refresh_at"             TIMESTAMP(3),
  "last_refresh_error"          TEXT,

  "state"                       "DocIngestConnectionState" NOT NULL DEFAULT 'connected',
  "reauth_reason"               TEXT,
  "reauth_since"                TIMESTAMP(3),
  -- Last time the reauth_required state was PAGED. Latches the ntfy re-page
  -- cooldown (ADR-0037) without suppressing the transition page itself.
  "reauth_paged_at"             TIMESTAMP(3),

  -- OneDrive provisions ASYNCHRONOUSLY (§A.5). NULL is a legitimate
  -- "not provisioned yet" state, NOT an error — the first interactive sign-in
  -- creates the drive, so a 404 before that is expected.
  "drive_id"                    TEXT,
  "drive_provisioned_at"        TIMESTAMP(3),
  "drive_check_error"           TEXT,

  "connected_by"                TEXT NOT NULL, -- bare audit-actor user id (no FK)
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"                  TIMESTAMP(3) NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_sources — one row per shared file or folder Vision watches
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_sources" (
  "id"                TEXT PRIMARY KEY,

  -- Graph identity. (drive_id, item_id) is THE natural key — a driveItem id is
  -- only unique within its drive, so the pair is what makes the sweep's upsert
  -- idempotent across a shared-with-me set spanning several people's OneDrives.
  "drive_id"          TEXT NOT NULL,
  "item_id"           TEXT NOT NULL,
  "kind"              "DocSourceKind" NOT NULL DEFAULT 'file',

  "display_name"      TEXT NOT NULL,
  "web_url"           TEXT,          -- click-through for the operator surface
  "path_hint"         TEXT,          -- parentReference path, for humans only
  "owner_upn"         TEXT,          -- who shared it (best-effort, may be absent)
  "content_type"      TEXT,
  "size_bytes"        INTEGER,       -- INTEGER not BIGINT, matching file_drops.byte_size

  -- Site scoping (CLAUDE.md hard rule #2). NULLABLE and NULL by default: the
  -- classifier (next phase) decides Eugene vs Woodland. A NULL site is
  -- "unclassified", never "both" — read paths must treat it as not-yet-scoped
  -- and must not leak it into a site-scoped list.
  "site_id"           TEXT,

  -- Classifier output (next phase). Left unconstrained TEXT on purpose: the
  -- class vocabulary is not settled, and freezing it into an enum now would
  -- force a migration on every new document type discovered in the wild.
  "doc_class"         TEXT,
  "doc_class_source"  TEXT,          -- 'classifier' | 'operator'
  "classified_at"     TIMESTAMP(3),

  -- Current-state markers straight off the driveItem. `ctag` changes on CONTENT
  -- change; `etag` changes on content OR metadata change. The sweep compares
  -- ctag to decide whether a new version row is warranted.
  "etag"              TEXT,
  "ctag"              TEXT,
  "last_modified_at"  TIMESTAMP(3),

  "state"             "DocSourceState" NOT NULL DEFAULT 'active',
  -- Operator kill switch, independent of `state`. `state` is what Microsoft
  -- says; `enabled` is what Bill says. Never conflate them.
  "enabled"           BOOLEAN NOT NULL DEFAULT true,

  "first_seen_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disappeared_at"    TIMESTAMP(3),
  "last_ingested_at"  TIMESTAMP(3),

  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_sources_drive_id_item_id_key"
  ON "doc_sources" ("drive_id", "item_id");

CREATE INDEX IF NOT EXISTS "doc_sources_state_enabled_idx"
  ON "doc_sources" ("state", "enabled");

CREATE INDEX IF NOT EXISTS "doc_sources_site_id_doc_class_idx"
  ON "doc_sources" ("site_id", "doc_class");

CREATE INDEX IF NOT EXISTS "doc_sources_last_seen_at_idx"
  ON "doc_sources" ("last_seen_at");

DO $$ BEGIN
  ALTER TABLE "doc_sources"
    ADD CONSTRAINT "doc_sources_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_subscriptions — Graph change-notification + delta state
--
-- Built by the NEXT phase; the table lands now so the sweep/renewal worker has a
-- durable home and so anomalies can reference a subscription from day one.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_ingest_subscriptions" (
  "id"                    TEXT PRIMARY KEY,

  "drive_id"              TEXT NOT NULL,
  "resource"              TEXT NOT NULL,   -- e.g. /drives/{driveId}/root
  "subscription_id"       TEXT,            -- Graph-assigned; NULL until created
  "notification_url"      TEXT NOT NULL,

  -- HASH of the clientState secret, never the secret. The webhook compares a
  -- hash of the value Graph echoes back; storing the plaintext would put a
  -- bearer-equivalent value in every DB backup for no gain.
  "client_state_hash"     TEXT,

  "expires_at"            TIMESTAMP(3),
  "last_renewed_at"       TIMESTAMP(3),
  "renew_after"           TIMESTAMP(3),    -- scheduler wake time

  -- Opaque Graph deltaLink. Long; never parsed, only replayed. An invalidated
  -- token is a `delta_token_invalid` anomaly + a full re-enumeration, never a
  -- silent skip.
  "delta_link"            TEXT,
  "delta_synced_at"       TIMESTAMP(3),

  "state"                 "DocIngestSubscriptionState" NOT NULL DEFAULT 'pending',
  "failure_count"         INTEGER NOT NULL DEFAULT 0,
  "last_error"            TEXT,

  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL
);

-- Partial unique: many rows may sit at subscription_id IS NULL while pending,
-- but a live Graph subscription id maps to exactly one row.
CREATE UNIQUE INDEX IF NOT EXISTS "doc_ingest_subscriptions_subscription_id_key"
  ON "doc_ingest_subscriptions" ("subscription_id")
  WHERE "subscription_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "doc_ingest_subscriptions_state_renew_after_idx"
  ON "doc_ingest_subscriptions" ("state", "renew_after");

CREATE INDEX IF NOT EXISTS "doc_ingest_subscriptions_drive_id_idx"
  ON "doc_ingest_subscriptions" ("drive_id");

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_source_versions — append-only observed history of a source
--
-- This table is what makes "live document" real. Each observed content change
-- (a new ctag) appends a row. Bytes go to R2 (CLAUDE.md hard rule #7) and only
-- the key is stored here — never the blob, never a local path.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_source_versions" (
  "id"                TEXT PRIMARY KEY,
  "doc_source_id"     TEXT NOT NULL,

  -- The content-change marker this version was cut on. UNIQUE per source, which
  -- is exactly what makes a re-delivered Graph notification a no-op instead of a
  -- duplicate ingest.
  "ctag"              TEXT NOT NULL,
  "etag"              TEXT,

  "size_bytes"        INTEGER,
  "last_modified_at"  TIMESTAMP(3),
  "modified_by"       TEXT,            -- display name / UPN off the driveItem

  "r2_key"            TEXT,            -- NULL until the bytes are fetched
  "content_sha256"    TEXT,

  "observed_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fetched_at"        TIMESTAMP(3),
  "ingested_at"       TIMESTAMP(3),    -- when a downstream consumer accepted it

  -- The precise provenance edge: THIS version became THAT drop. The coarse
  -- `file_drops.doc_source_id` answers "everything from this source"; this
  -- answers "which exact revision produced this drop".
  "file_drop_id"      TEXT,

  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_source_versions_doc_source_id_ctag_key"
  ON "doc_source_versions" ("doc_source_id", "ctag");

CREATE INDEX IF NOT EXISTS "doc_source_versions_doc_source_id_observed_at_idx"
  ON "doc_source_versions" ("doc_source_id", "observed_at");

CREATE INDEX IF NOT EXISTS "doc_source_versions_file_drop_id_idx"
  ON "doc_source_versions" ("file_drop_id");

DO $$ BEGIN
  ALTER TABLE "doc_source_versions"
    ADD CONSTRAINT "doc_source_versions_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id")
    ON UPDATE CASCADE ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "doc_source_versions"
    ADD CONSTRAINT "doc_source_versions_file_drop_id_fkey"
    FOREIGN KEY ("file_drop_id") REFERENCES "file_drops"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- doc_ingest_anomalies — the guardrail surface
--
-- The detection logic is the NEXT phase's; the ledger is here so it has an
-- idempotent target. `fingerprint` + a partial unique index over OPEN rows is
-- what makes "raise this anomaly" safe to call on every sweep: a recurring
-- condition bumps `occurrences` and `last_seen_at` instead of growing an
-- unbounded row-per-poll queue. Resolved rows are retained (they are the
-- evidence that a thing was wrong and got fixed).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "doc_ingest_anomalies" (
  "id"               TEXT PRIMARY KEY,

  "doc_source_id"    TEXT,
  "subscription_id"  TEXT,

  "kind"             "DocIngestAnomalyKind" NOT NULL,
  "severity"         "DocIngestAnomalySeverity" NOT NULL DEFAULT 'warning',
  "status"           "DocIngestAnomalyStatus" NOT NULL DEFAULT 'open',

  -- Stable dedup key the raiser computes (kind + the entity it is about).
  "fingerprint"      TEXT NOT NULL,
  "detail"           TEXT NOT NULL,
  "context"          JSONB,

  "occurrences"      INTEGER NOT NULL DEFAULT 1,
  "first_seen_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  "resolved_at"      TIMESTAMP(3),
  "resolved_by"      TEXT,            -- bare audit-actor user id (no FK)
  "resolution_note"  TEXT,

  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "doc_ingest_anomalies_open_fingerprint_key"
  ON "doc_ingest_anomalies" ("fingerprint")
  WHERE "status" = 'open';

CREATE INDEX IF NOT EXISTS "doc_ingest_anomalies_status_severity_last_seen_at_idx"
  ON "doc_ingest_anomalies" ("status", "severity", "last_seen_at");

CREATE INDEX IF NOT EXISTS "doc_ingest_anomalies_doc_source_id_idx"
  ON "doc_ingest_anomalies" ("doc_source_id");

CREATE INDEX IF NOT EXISTS "doc_ingest_anomalies_subscription_id_idx"
  ON "doc_ingest_anomalies" ("subscription_id");

-- SET NULL, not CASCADE: an anomaly about a source that has since been deleted
-- is exactly the anomaly you most want to still be able to read.
DO $$ BEGIN
  ALTER TABLE "doc_ingest_anomalies"
    ADD CONSTRAINT "doc_ingest_anomalies_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "doc_ingest_anomalies"
    ADD CONSTRAINT "doc_ingest_anomalies_subscription_id_fkey"
    FOREIGN KEY ("subscription_id") REFERENCES "doc_ingest_subscriptions"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- file_drops — provenance columns (additive; existing rows keep working)
--
-- Every pre-existing row becomes `ingest_source = 'manual'`, `doc_source_id
-- NULL`, which is the truth: they WERE manual uploads. No backfill, no data
-- rewrite, no behaviour change on the /admin/file-drop surface.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE "file_drops"
  ADD COLUMN IF NOT EXISTS "ingest_source" "DocIngestSource" NOT NULL DEFAULT 'manual';

ALTER TABLE "file_drops"
  ADD COLUMN IF NOT EXISTS "doc_source_id" TEXT;

CREATE INDEX IF NOT EXISTS "file_drops_ingest_source_created_at_idx"
  ON "file_drops" ("ingest_source", "created_at");

CREATE INDEX IF NOT EXISTS "file_drops_doc_source_id_idx"
  ON "file_drops" ("doc_source_id");

DO $$ BEGIN
  ALTER TABLE "file_drops"
    ADD CONSTRAINT "file_drops_doc_source_id_fkey"
    FOREIGN KEY ("doc_source_id") REFERENCES "doc_sources"("id")
    ON UPDATE CASCADE ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
