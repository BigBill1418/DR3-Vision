-- ADR-0125 — the day is closed by a person, and the sheet's Assignment column
-- finally has a home.
--
-- ── `eod_day_close` ─────────────────────────────────────────────────────────
--
-- The Woodland daily-log workbook ends each day because somebody looks at it and
-- decides it is finished. Vision had no equivalent, so a day with nothing
-- recorded and a day a manager reviewed and found genuinely empty were
-- byte-identical on every surface. "Not recorded" and "zero" are different
-- statements about a business day and the gap-flag discipline this whole surface
-- rests on is worthless without a row that says which one happened.
--
-- ONE row per (site, Pacific calendar day). The row exists only because the day
-- was closed at least once — there is no "open" row created up front, because an
-- absent row already means exactly that and a second representation of the same
-- fact is a second thing to keep in sync.
--
-- ── Why `close_date` is a DATE and not an instant ──────────────────────────
--
-- The manager reviews a DAY, not a moment inside one. `@db.Date` keyed via
-- `src/lib/time.ts`'s day-key helpers (UTC midnight of the Pacific calendar day)
-- is the same shape `processed_units_daily.production_date`,
-- `outbound_materials.ship_date` and `consumer_dropoffs.dropoff_date` already
-- use, so every section this screen aggregates keys on one definition of "day".
-- `time.ts:229-230` — "Do NOT introduce a second day-key definition."
--
-- ── Why the close columns are NULLABLE ─────────────────────────────────────
--
-- `closed_by`/`closed_at` are both NULL exactly when the day stands REOPENED.
-- The alternative — keeping the last close stamped and deciding the state by
-- comparing `closed_at` against `reopened_at` — makes "is this day closed?" a
-- computation, and two readers computing it slightly differently is the
-- two-computations defect ADR-0110 exists to record. Here the state is a fact on
-- the row: a NULL `closed_at` IS the open state, and the CHECK below makes the
-- both-NULL-and-never-reopened row impossible to write.
--
-- `reopened_by/at/reason` are the LAST reopen and are deliberately NOT cleared
-- when the day is re-closed. Clearing them would make a day that was reopened,
-- corrected and closed again indistinguishable from one closed once and never
-- touched — and that distinction is the entire reason the reopen is audited.
-- `reopen_count` carries the same fact across repeats.
--
-- Actor columns are bare user ids with NO foreign key, matching
-- `audit_log.actor_user_id` and the AP / file-drop actor columns: a deleted user
-- must never be able to delete or NULL the record of what they did.
--
-- Each individual close and reopen ALSO writes its own append-only `audit_log`
-- row in the SAME transaction (CLAUDE.md hard rule #6, ADR-0118 D3). This table
-- is the CURRENT state; the audit log is the history. Neither substitutes.

CREATE TYPE "EodCloseOutcome" AS ENUM ('clean', 'exception');

CREATE TABLE IF NOT EXISTS "eod_day_close" (
  "id"             TEXT             NOT NULL,
  "site_id"        TEXT             NOT NULL,
  "close_date"     DATE             NOT NULL,
  "outcome"        "EodCloseOutcome" NOT NULL,
  "exception_note" TEXT,
  "closed_by"      TEXT,
  "closed_at"      TIMESTAMP(3),
  "reopened_by"    TEXT,
  "reopened_at"    TIMESTAMP(3),
  "reopen_reason"  TEXT,
  "reopen_count"   INTEGER          NOT NULL DEFAULT 0,
  "created_at"     TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3)     NOT NULL,

  CONSTRAINT "eod_day_close_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_site_id_fkey";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One close row per site per day. This is what makes a second close a REFUSAL
-- rather than a second row: without it, double-clicking "Close day" writes two
-- closes with two different outcomes and nothing says which one stands.
CREATE UNIQUE INDEX IF NOT EXISTS "eod_day_close_site_id_close_date_key"
  ON "eod_day_close" ("site_id", "close_date");
CREATE INDEX IF NOT EXISTS "eod_day_close_site_id_close_date_idx"
  ON "eod_day_close" ("site_id", "close_date");

-- An `exception` close MUST name what is still outstanding. A close-with-exception
-- whose note is blank records that gaps remain and destroys the only information
-- that made recording it worthwhile. Four characters is the same floor the
-- ADR-0106 prior-day reason uses, so the two reason fields cannot drift into
-- disagreeing about what counts as an explanation.
ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_exception_requires_note";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_exception_requires_note"
  CHECK (
    "outcome" <> 'exception'
    OR ("exception_note" IS NOT NULL AND length(btrim("exception_note")) >= 4)
  );

-- A `clean` close carries no note. Not cosmetic: a note on a clean close reads
-- as an unresolved exception to anyone scanning the column, which is precisely
-- the ambiguity the two outcomes exist to remove.
ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_clean_has_no_note";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_clean_has_no_note"
  CHECK ("outcome" <> 'clean' OR "exception_note" IS NULL);

-- The reopen triple is all-or-nothing, and a reopen without a reason is refused.
-- Same rule as ADR-0106 D3's backdated write: the reason is the point, so a row
-- holding a reopen timestamp and no reason is a reopen that told nobody why.
ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_reopen_triple_complete";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_reopen_triple_complete"
  CHECK (
    ("reopened_at" IS NULL AND "reopened_by" IS NULL AND "reopen_reason" IS NULL)
    OR (
      "reopened_at" IS NOT NULL
      AND "reopened_by" IS NOT NULL
      AND "reopen_reason" IS NOT NULL
      AND length(btrim("reopen_reason")) >= 4
    )
  );

-- `closed_by` and `closed_at` move together: a close is one act.
ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_close_pair_complete";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_close_pair_complete"
  CHECK (("closed_at" IS NULL) = ("closed_by" IS NULL));

-- The row exists BECAUSE the day was closed. So it is either closed now, or it
-- was closed and has since been reopened. A row that is neither has no reason to
-- exist and would render as a phantom "open" day the screen could not explain.
ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_closed_or_reopened";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_closed_or_reopened"
  CHECK ("closed_at" IS NOT NULL OR "reopened_at" IS NOT NULL);

ALTER TABLE "eod_day_close"
  DROP CONSTRAINT IF EXISTS "eod_day_close_reopen_count_non_negative";
ALTER TABLE "eod_day_close"
  ADD CONSTRAINT "eod_day_close_reopen_count_non_negative"
  CHECK ("reopen_count" >= 0);

COMMENT ON TABLE "eod_day_close" IS
  'ADR-0125 — one row per (site, Pacific day) recording that a manager reviewed and closed the day, clean or with a named exception. Absent row = day not yet closed.';
COMMENT ON COLUMN "eod_day_close"."close_date" IS
  'ADR-0125 — the Pacific calendar day as a @db.Date day key (src/lib/time.ts). Never an instant.';
COMMENT ON COLUMN "eod_day_close"."closed_at" IS
  'ADR-0125 — NULL exactly when the day stands reopened. The state is a fact on the row, not a comparison against reopened_at.';
COMMENT ON COLUMN "eod_day_close"."reopen_reason" IS
  'ADR-0125 — required with every reopen (>= 4 chars). The last reopen survives a re-close; each reopen also writes its own audit_log row.';

-- ── `sources.haul_assignment` (Phase 0 gap G-9) ────────────────────────────
--
-- The workbook's `variables!Mileage_Table` carries an `Assignment` column that
-- selects which haul-rate leg a collection source bills on. The Phase 0 parity
-- audit graded it NO HOME — the only column on the freight tab with no schema
-- home at all — and `src/lib/rates/woodland-freight.ts:11` says so in the source:
-- "no Assignment table exists yet", followed by pinning every Woodland freight
-- row to Primary as an admitted transitional rule.
--
-- ENUM, not TEXT: the live 61-row table holds exactly three values. A free-text
-- column would let a typo select a different rate leg silently.
--
-- NULLABLE, and nothing is backfilled. `woodland-freight.ts` pins to Primary
-- today, but writing 'primary' onto 61 rows here would turn a documented
-- transitional assumption into 61 fabricated measurements indistinguishable from
-- real ones — the ADR-0079 no-fabricated-history rule, and the same reasoning
-- ADR-0107 used to leave `start_hours`/`end_hours` NULL. NULL means "not yet
-- loaded from the Mileage_Table", which is the truth.

CREATE TYPE "SourceHaulAssignment" AS ENUM ('primary', 'secondary', 'tertiary');

ALTER TABLE "sources"
  ADD COLUMN IF NOT EXISTS "haul_assignment" "SourceHaulAssignment";

COMMENT ON COLUMN "sources"."haul_assignment" IS
  'ADR-0125 — the workbook variables!Mileage_Table Assignment column (G-9). NULL = not yet loaded; never backfilled.';

-- ── Register the `eod_review` UI surface, BORN PILOT ───────────────────────
--
-- ADR-0047 decision #3 / CLAUDE.md #12: new staff-visible exposure ships dark,
-- admin-only, and is ramped per site by Bill from /admin/rollout. This one is a
-- genuinely new surface AND a new authority — it is the only place a manager can
-- close a business day — so the default applies unmodified.
--
-- Its OWN code rather than riding `loads_inventory`: that gate is the master
-- switch for every manager loads/inventory tab and every loads write, so ramping
-- EOD on it would either expose this screen the moment those tabs go live at a
-- site, or force taking the working tabs down to pull EOD back.
--
-- Registered for BOTH sites. `getRolloutState` looks up (surface_code, site_id)
-- and an unregistered pair resolves to admin-only via `UnregisteredSurfaceError`;
-- seeding only one site would make the other's state a swallowed exception rather
-- than a stated decision.
--
-- `id` is TEXT (gen_random_uuid()::text), matching `rollout_surfaces.id` — a
-- `uuid`-typed id here would pass the correctness job (which does not run
-- migrations) and fail only on deploy.
--
-- Idempotent via ON CONFLICT on the (surface_code, site_id) unique, so a replay
-- NEVER reverts a flip an admin has made. On the clean-DB CI replay the `sites`
-- table is empty at this point (sites are seeded later by prisma/seed.mjs), so
-- the SELECT yields zero rows — additive and safe. prisma/seed.mjs carries the
-- same code with the same state for first-deploy/dev parity.

INSERT INTO "rollout_surfaces" ("id", "kind", "surface_code", "site_id", "rollout_state", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  'ui'::"RolloutSurfaceKind",
  v.surface_code,
  s."id",
  v.rollout_state::"RolloutState",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "sites" s
CROSS JOIN (VALUES
  ('eod_review', 'pilot')
) AS v(surface_code, rollout_state)
WHERE s."code" IN ('eugene', 'woodland')
ON CONFLICT ("surface_code", "site_id") DO NOTHING;
