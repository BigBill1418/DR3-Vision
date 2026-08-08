-- ADR-0087 — the throughput-gap watchdog: an instrument that reads the silence.
--
-- ADR-0079 made "nobody wrote a number down" a first-class, honest state: an
-- ABSENT row in `equipment_daily_throughput`, deliberately never a 0. ADR-0081
-- imported the sheet's own history into the same table. Both were correct and
-- both were passive. Between 2026-07-25 and the 2026-08-07 cutover the Terex
-- sheet went unfilled for NINE working days, and the only detector in the system
-- was Bill looking at the chart. Post-cutover the manager surface has exactly the
-- same silence: the trend page draws `not_recorded` faithfully and tells nobody.
--
-- This migration adds the one thing that was missing — a place to record that the
-- silence has ALREADY been reported, so the watchdog can speak once and not
-- again.
--
-- ## Why the key is the MISSED day, not the run day
--
-- ADR-0037 asks for a ≥24h cooldown and one alert per site per day. An in-process
-- cooldown (`publishNtfy`'s fingerprint map) cannot deliver that here: it lives in
-- the app container's memory, so a restart re-arms it, and it is keyed on wall
-- time rather than on the fact being reported. Keying the LEDGER on (site,
-- gap_date) makes the guarantee structural — a given working day is nudged
-- exactly once, ever, regardless of how many times the cron fires, how many cron
-- containers exist, or whether anything restarted in between. That is strictly
-- stronger than the policy floor.
--
-- This is the `alert_digest_logs` pattern (ADR-0043 D5) applied to the same shape
-- of problem, deliberately rather than by coincidence: same per-site scope, same
-- write-after-decision discipline, same unique-as-the-idempotency-mechanism.
--
-- ## Why a table rather than a column on `equipment_daily_throughput`
--
-- The fact being recorded is the ABSENCE of a row in that table. There is no row
-- to hang a column on. That is not a modelling inconvenience — it is the whole
-- reason this feature exists.
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). One new table, its constraints and indexes, plus two born-pilot rollout
-- rows. Nothing existing is altered, dropped or backfilled — in particular NO
-- historical gap is back-alerted. The nine days of July are history; the
-- watchdog's job starts at the first working day AFTER it is deployed.

CREATE TABLE "equipment_throughput_gap_alerts" (
    "id"              TEXT         NOT NULL,
    "site_id"         TEXT         NOT NULL,
    -- The working day that had no live throughput row. Same `date` type and same
    -- Pacific calendar-day representation as
    -- `equipment_daily_throughput.throughput_date`, so the two compare directly
    -- with no zone shift (the ADR-0065 / lib/time invariant).
    "gap_date"        DATE         NOT NULL,
    "equipment_id"    TEXT         NOT NULL,
    -- The Pacific day the scan ran. Normally gap_date + 1 working day; a larger
    -- gap is the only evidence that the watchdog itself was down.
    "scanned_on"      DATE         NOT NULL,
    -- 'live' | 'pilot' — the ADR-0047 state this nudge resolved to. Recorded so
    -- "did the roster actually see it?" is answerable from the ledger alone.
    "notify_mode"     TEXT         NOT NULL,
    "recipient_count" INTEGER      NOT NULL,
    "delivered_count" INTEGER      NOT NULL,
    "last_status"     INTEGER,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_throughput_gap_alerts_pkey" PRIMARY KEY ("id")
);

-- The idempotency mechanism itself. BOTH key columns are NOT NULL, so this
-- genuinely constrains — the repo has been bitten before by a unique index whose
-- key column was nullable and therefore constrained nothing.
CREATE UNIQUE INDEX "equipment_throughput_gap_alerts_site_id_gap_date_key"
    ON "equipment_throughput_gap_alerts" ("site_id", "gap_date");

CREATE INDEX "equipment_throughput_gap_alerts_site_id_gap_date_idx"
    ON "equipment_throughput_gap_alerts" ("site_id", "gap_date");

-- Bare-FK convention (mirrors `equipment_daily_throughput`): the constraints live
-- here, not in the Prisma relation lists, so this block never edits the shared
-- Site/Equipment relation blocks. `RESTRICT` on equipment matches every other
-- equipment reference — nothing in that registry is ever hard-deleted, and an
-- alert that outlived its machine would be a record of a gap nobody can locate.
ALTER TABLE "equipment_throughput_gap_alerts"
    ADD CONSTRAINT "equipment_throughput_gap_alerts_site_id_fkey"
    FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "equipment_throughput_gap_alerts"
    ADD CONSTRAINT "equipment_throughput_gap_alerts_equipment_id_fkey"
    FOREIGN KEY ("equipment_id") REFERENCES "equipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- `notify_mode` is a two-value vocabulary shared with `rollout_surfaces.rollout_state`.
-- A CHECK rather than reusing the `RolloutState` enum: this column records what
-- HAPPENED at a point in time, and an enum that later grows a third value would
-- silently widen the set of things a historical row could claim.
ALTER TABLE "equipment_throughput_gap_alerts"
    ADD CONSTRAINT "equipment_throughput_gap_alerts_notify_mode_check"
    CHECK ("notify_mode" IN ('live', 'pilot'));

-- Counts are counts. A negative delivered_count would be a bug wearing a number.
ALTER TABLE "equipment_throughput_gap_alerts"
    ADD CONSTRAINT "equipment_throughput_gap_alerts_counts_nonnegative_check"
    CHECK ("recipient_count" >= 0 AND "delivered_count" >= 0 AND "delivered_count" <= "recipient_count");

-- ── ADR-0047 rollout surface, born PILOT ────────────────────────────────────
-- Shape copied verbatim from 20260838a_adr0085_ipad_dropoff: a TEXT id (a
-- uuid-typed one passes CI, which does not run migrations, and fails only on
-- deploy), and ON CONFLICT DO NOTHING so a replay never reverts a flip an admin
-- has already made. On a fresh CI replay `sites` is empty at this point (seeded
-- later by prisma/seed.mjs), so the SELECT yields zero rows — additive and safe.
--
-- Both sites are registered even though only Woodland has the machine. Eugene's
-- row is not decoration: `resolveSiteThroughputMachine` returns null there today,
-- so the scan skips the site before it ever consults the surface — but a Terex
-- arriving at Eugene tomorrow is picked up with no code change (ADR-0077's
-- site-derived identity rule), and on that day the surface must already exist and
-- be pilot. Seeding one site would make the other's state a swallowed exception
-- rather than a stated decision.
INSERT INTO "rollout_surfaces" ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  'notification'::"RolloutSurfaceKind",
  v.surface_code,
  s."id",
  v.rollout_state::"RolloutState",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "sites" s
CROSS JOIN (VALUES
  ('equipment_throughput_gap', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
