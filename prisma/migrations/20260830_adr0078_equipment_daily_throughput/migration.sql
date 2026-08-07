-- ADR-0078 D1/D2 — the manager's DAILY Terex capture: units processed + run hours.
--
-- ADR-0044 D2 declared "throughput needs NO new capture — it is DERIVED from the
-- daily processed-units close" and computed the Terex's units/day as
-- `stripped_program + stripped_non_program`. That is the WHOLE FLOOR's output
-- wearing one machine's name: it cannot distinguish the Terex from hand-stripping
-- or a second machine. Production shows the scale — Woodland's derived "Terex"
-- days run 1,000–1,250 units (2026-08-06: 769 + 294 = 1,063). The paper sheet this
-- product replaces carried an authoritative, manager-entered Terex number every
-- day, and Vision must carry it too.
--
-- WHY A DEDICATED TABLE rather than a sixth `equipment_events` kind (ADR-0078 D2).
-- The alternative was considered first and rejected on three findings, each read
-- out of the live code rather than assumed:
--
--   1. `equipment_events` is MANY-ROWS-PER-DAY by design — several downtime,
--      repair and cost rows legitimately share one date. "One entry per machine
--      per day" therefore cannot be a table-level unique there; it could only be a
--      partial index carving one kind out of a table whose whole invariant is the
--      opposite.
--   2. THREE read paths query `equipment_events` with NO kind filter and would
--      silently absorb a daily row:
--        - `src/lib/equipment/tile.ts` `findFirst` ordered by event_date desc — a
--          daily row written every working day would permanently become "the LAST
--          equipment event" and bury the downtime the tile exists to surface;
--        - `src/lib/equipment/service.ts` `listEquipmentEvents` — ~250 rows/yr
--          flooding the maintenance log a manager actually reads;
--        - `src/lib/equipment/terex-ledger.ts` — selects `hours_down` with no kind
--          filter and sums it into `downtime.totalHours`. This is the sharp edge:
--          carrying RUN hours in `hours_down` would report the hours the machine
--          RAN as the hours it was DOWN. That is ADR-0077's defect class inverted
--          and worse — it MANUFACTURES a measurement instead of mis-rendering a
--          missing one.
--      (`src/lib/ops/equipment-provider.ts` is safe: both its queries already
--      filter, by `kind IN (...)` and by `cost_cents >=`.)
--   3. `equipment_events` has NO equipment foreign key at all — `equipment_code` is
--      a free-text string (ADR-0044 D1: "a second machine is a data value, never a
--      migration"). The requirement is uniqueness per EQUIPMENT ROW, which a typed
--      string cannot express, and which the ADR-0075 merge machinery
--      (`merged_into_id`) depends on to keep a merged-away duplicate from quietly
--      accumulating a parallel history.
--
-- `run_hours` and `equipment_events.hours_down` are deliberately in DIFFERENT
-- TABLES so that no query can ever confuse the two. They are near-opposites, and
-- one of them has already been mis-rendered once in production (ADR-0077 D4).
--
-- PURELY ADDITIVE (ADR-0035 clean-replay invariant: replays on an empty PG16 in
-- CI). One new table, its constraints and its indexes. Nothing existing is
-- altered, dropped or backfilled — in particular NO derived history is written
-- into it. A day before this table existed has no manager entry and must read as
-- "not recorded", which is exactly what an empty table produces.
--
-- Every statement is IF NOT EXISTS / idempotent, so a re-run or a replay is a
-- no-op rather than an error.
--
-- `id` is TEXT (the repo's hand-written-migration rule). `equipment.id`,
-- `sites.id` and `users.id` are all `text` in production (verified 2026-08-07);
-- a `uuid`-typed column here would pass CI — which does not run migrations in the
-- test job — and fail only at deploy, in the init container.
--
-- The dir name sorts AFTER the current chain tip
-- (`20260829_adr0077_terex_ledger_surface`), preserving ADR-0035 ordering.

CREATE TABLE IF NOT EXISTS "equipment_daily_throughput" (
  "id"              TEXT PRIMARY KEY,
  "site_id"         TEXT NOT NULL,
  "equipment_id"    TEXT NOT NULL,
  -- The PRODUCTION day, Pacific (`appTodayISO`), as a pure DATE — no wall-clock,
  -- so it is DST-safe and compares exactly like `equipment_events.event_date`.
  "throughput_date" DATE NOT NULL,
  -- Units the MACHINE processed. `0` is a legitimate RECORDED value (it ran and
  -- produced nothing); "nobody entered a number" is the ABSENCE of a row. The two
  -- are never the same thing — ADR-0077 D4 restated for units.
  "units_processed" INTEGER NOT NULL,
  -- Hours the machine actually RAN — the whole reason to capture rather than
  -- derive. Units-per-hour was previously computed against an ASSUMED 8-hour day
  -- (`ASSUMED_DAY_HOURS`), a guess standing in for a measurement.
  -- DECIMAL(5,2) mirrors `equipment_events.hours_down` exactly.
  "run_hours"       DECIMAL(5,2) NOT NULL,
  "notes"           TEXT,
  -- ADR-0036 / ADR-0077 actor discipline. A human entry carries the REAL
  -- `users.id` in `created_by` with `actor_label` NULL. A write with no signed-in
  -- human (a script under written instruction) sets `actor_label` and leaves
  -- `created_by` NULL, rather than borrowing a person's id and writing a false
  -- claim into a trail hard rule #6 means we can never take back.
  "created_by"      TEXT,
  "actor_label"     TEXT,
  -- Soft-void (hard rule #6 — no hard delete).
  "voided_at"       TIMESTAMP(3),
  "voided_by"       TEXT,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "equipment_daily_throughput_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- ON DELETE RESTRICT matches every other equipment reference: nothing in the
  -- equipment registry is ever hard-deleted, and a machine must not be removable
  -- out from under the days recorded against it.
  CONSTRAINT "equipment_daily_throughput_equipment_fk"
    FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  -- A negative unit count is not a light day, it is a typo.
  CONSTRAINT "equipment_daily_throughput_units_nonneg"
    CHECK ("units_processed" >= 0),
  -- Run hours must be POSITIVE (a day the machine did not run is not an entry —
  -- it is the absence of one) and cannot exceed the 24 hours a calendar day has.
  -- Validated here as well as in the service so the invariant survives any future
  -- write path that forgets to call it.
  CONSTRAINT "equipment_daily_throughput_run_hours_sane"
    CHECK ("run_hours" > 0 AND "run_hours" <= 24)
);

-- THE uniqueness guarantee: one live entry per (machine, day). A second same-day
-- entry is an EDIT, never a duplicate.
--
-- PARTIAL on `voided_at IS NULL` so that a mistaken entry can be soft-voided and
-- the day then re-entered — an unconditional unique would let a voided row hold
-- the slot forever and make a reversal unrecoverable.
--
-- Note which column is nullable: the KEY columns `equipment_id` and
-- `throughput_date` are both NOT NULL, and only the PREDICATE reads a nullable
-- column. That distinction is the whole ballgame — a unique index whose KEY
-- includes a nullable column constrains nothing, because NULL never equals NULL,
-- and every row would slip past it. This index genuinely constrains, and the
-- migration test asserts a real second insert is REFUSED rather than trusting the
-- DDL to read correctly.
CREATE UNIQUE INDEX IF NOT EXISTS "equipment_daily_throughput_machine_day_key"
  ON "equipment_daily_throughput" ("equipment_id", "throughput_date")
  WHERE "voided_at" IS NULL;

-- Site-scoped range scans (CLAUDE.md hard rule #2 — every read is one site).
CREATE INDEX IF NOT EXISTS "equipment_daily_throughput_site_date_idx"
  ON "equipment_daily_throughput" ("site_id", "throughput_date");

-- The machine-scoped series read, including voided rows for the audit view.
CREATE INDEX IF NOT EXISTS "equipment_daily_throughput_equipment_date_idx"
  ON "equipment_daily_throughput" ("equipment_id", "throughput_date");
