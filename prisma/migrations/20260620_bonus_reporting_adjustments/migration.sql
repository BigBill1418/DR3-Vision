-- ADR-0032 — Reporting-only production adjustments, decoupled from bonus math.
--
-- Context (operator decision 2026-06-19, "Option B"):
--   The Woodland production TOTALS shown in the daily report (month-to-date) and
--   in the annual year-over-year aggregate must reflect the operator's true paper
--   figures. But the CLOSED pay period 2026-05-26..2026-06-08
--   (a540fc56-2434-4c02-94e1-4c8d5ad80477, state historical_imported) is LOCKED:
--   its frozen payout legacy_total_payout_cents = 96475 ($964.75) must stay
--   byte-for-byte identical. So production totals are corrected WITHOUT touching
--   any bonus/payout dollars.
--
--   This table is a SEPARATE, additive layer. Every bonus-DOLLAR read path queries
--   bonus_daily_entries (never this table), so an adjustment can NEVER leak into
--   payroll math. Only production-QUANTITY read paths opt in to summing these rows.
--
--   Granularity is per-day, per-site (a signed unit delta), which is sufficient
--   under Option B — these are reporting corrections, not per-employee bonus entries.
--
-- Convention (matches every other migration in this repo): ids and FK columns are
-- TEXT (Prisma `String @id @default(uuid())` generates the id app-side — there is
-- NO DB-side gen_random_uuid() default). FK columns must be TEXT to match
-- sites.id / users.id, which are TEXT, not UUID. Constraint/index names follow
-- Prisma's generated form so a future `prisma migrate dev` sees no drift.

-- ─────────────────────────────────────────────────────────────────────
-- Table
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_reporting_adjustments" (
    "id"         TEXT NOT NULL,
    "site_id"    TEXT NOT NULL,
    -- Pacific calendar day this adjustment applies to (UTC-midnight @db.Date key,
    -- same discipline as bonus_daily_entries.entry_date).
    "entry_date" DATE NOT NULL,
    -- Signed unit delta. Positive = add production, negative = subtract. INT
    -- (whole mattresses) — production totals floor per row, so fractional deltas
    -- have no meaning here.
    "units"      INTEGER NOT NULL,
    "reason"     TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bonus_reporting_adjustments_pkey" PRIMARY KEY ("id")
);

-- ─────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────

-- Daily-report MTD + comparison sums scan by (site_id, entry_date) range.
CREATE INDEX "bonus_reporting_adjustments_site_id_entry_date_idx"
  ON "bonus_reporting_adjustments"("site_id", "entry_date");

-- At most one adjustment row per site per day (one reconciliation per day).
-- A correction to an existing day is an UPDATE, not a second row.
CREATE UNIQUE INDEX "bonus_reporting_adjustments_site_id_entry_date_key"
  ON "bonus_reporting_adjustments"("site_id", "entry_date");

-- ─────────────────────────────────────────────────────────────────────
-- Foreign keys
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "bonus_reporting_adjustments"
  ADD CONSTRAINT "bonus_reporting_adjustments_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "bonus_reporting_adjustments"
  ADD CONSTRAINT "bonus_reporting_adjustments_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
