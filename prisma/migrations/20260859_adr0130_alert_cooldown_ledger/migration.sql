-- ADR-0130 D1 — the ADR-0037 cooldown ledger moves into Postgres.
--
-- Both ntfy publishers kept their per-fingerprint cooldown in a module-scope
-- `Map`. `src/lib/ntfy.ts` stated the assumption: "One ledger per Node.js process
-- […] DR3-Vision runs a single replica on CHAD-HQ so this is sufficient."
--
-- The replica count was never the load-bearing part. `dr3-vision-mymrc-scrape` is
-- a cron HOST that spawns `scripts/mymrc-scrape.mjs` as a FRESH child process
-- every hour and reaps it. A new process gets a new empty Map, so the 24 h
-- stale-mirror cooldown reset 24 times a day: measured from ntfy history, the gaps
-- between consecutive `mymrc-stale-mirror:woodland:processed` pages were
-- 3601/3604/3595/3595/3604/3603/3601/3593 seconds — the cron period, for four
-- days, two feeds at a time, at priority `high`.
--
-- The same class hits every other publisher on a deploy: `swarmpilot_deployer`
-- recreates ~19 containers, every in-memory ledger is wiped, and every alert
-- condition that is still true re-pages at once.
--
-- Postgres rather than Redis or a file (ADR-0130 §Alternatives, re-verified on
-- CHAD-HQ 2026-09-07): six Redis containers run on that host and NONE is reachable
-- — DR3-Vision joins only its own bridge `dr3-vision_dr3net`; and
-- `docker-compose.yml` declares two volumes, neither of which is mounted into more
-- than one alerting container, so a file ledger would be per-container — the same
-- defect with a longer TTL.

CREATE TABLE IF NOT EXISTS "alert_cooldowns" (
  -- The caller-owned ADR-0037 fingerprint, e.g. `mymrc-stale-mirror:woodland:processed`,
  -- or the FNV-1a hash of `topic` + `title` when the caller supplied none. The
  -- PRIMARY KEY is what makes the claim atomic.
  "key" TEXT NOT NULL,

  -- When this alert may page again. The claim predicate is `expires_at <= $now`.
  --
  -- TIMESTAMPTZ, not the repo's usual `timestamp(3)`, for the same reason
  -- `users.sessions_invalidated_at` uses it (2026-07-23): this is a BARE INSTANT
  -- compared across processes, and a zone-naive column would make the comparison
  -- depend on the session TimeZone of whichever container happened to write it.
  "expires_at" TIMESTAMPTZ(3) NOT NULL,

  -- ADR-0130 D4 — the instrument. The Map could only answer "is this suppressed
  -- right now"; it could never answer "how often has this fired", which is what
  -- makes the next ADR-0037 re-grade evidence rather than anecdote.
  "last_sent_at" TIMESTAMPTZ(3) NOT NULL,
  "send_count"   INTEGER NOT NULL DEFAULT 1,

  CONSTRAINT "alert_cooldowns_pkey" PRIMARY KEY ("key")
);

-- Drives the reaper (`DELETE … WHERE expires_at < now - 7d`), which is the only
-- thing that ever deletes rows other than a claim RELEASE on a dropped publish.
-- Same shape as `idempotency_keys`' TTL-sweep index.
CREATE INDEX IF NOT EXISTS "alert_cooldowns_expires_at_idx" ON "alert_cooldowns" ("expires_at");

COMMENT ON TABLE "alert_cooldowns" IS
  'ADR-0130 - durable ADR-0037 per-fingerprint alert cooldown. Claimed atomically via INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= $now; the affected-row count IS the verdict. A claim is RELEASED (row deleted) when neither the primary nor the ntfy.sh fallback transport landed, so the caller may retry on its next tick. Ephemeral operational state - not an audit surface.';
