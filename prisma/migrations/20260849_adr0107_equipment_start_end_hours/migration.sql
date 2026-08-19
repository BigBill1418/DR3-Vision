-- ADR-0107 §D1/D2 — the TEREX sheet's Start / End HOUR-METER readings.
--
-- ── What these columns are ─────────────────────────────────────────────────
-- The workbook's `Start Hours` / `End Hours` are CUMULATIVE HOUR-METER readings
-- off the machine, NOT clock times. Measured against the live workbook
-- 2026-08-18: `Jul26` runs 2,462.75 -> 2,608.05 and `Aug26` continues
-- 2,685 -> 2,804.8, with each day's Start carried from the prior day's End by
-- formula (`=F<prev>`, and `='Jul26'!F33` across the month boundary). Daily
-- deltas land at ~6-12 h.
--
-- The repo already knew this and said so in
-- `src/lib/doc-ingest/terex-monthly-extract.ts`, which types them
-- "Hour-meter readings" and calls out `Nov24`/`Dec24` as the tabs carrying
-- "`Start Time`/`End Time` clock times rather than hour-meter readings". Both
-- shapes exist in the workbook's history; the 2025/2026 monthly tabs this
-- product mirrors are METERS.
--
-- ── Why NULLABLE, and why nothing is backfilled ────────────────────────────
-- Additive by construction. Every existing row keeps its `run_hours` and gets
-- NULL start/end. They are NOT backfilled: `run_hours` is a DIFFERENCE, and a
-- difference does not determine the pair it came from — inventing a Start of 0
-- and an End of 6.5 would put two fabricated meter readings, indistinguishable
-- from real ones, into the table whose entire purpose is that the number is
-- authoritative (ADR-0079's no-fabricated-history rule, restated).
--
-- NULLABLE is also what keeps the ADR-0081 workbook importer writable: it
-- projects sheet rows whose Start/End cells are legitimately blank on some
-- tabs, and a NOT NULL here would turn an honest gap into a failed import.
-- REQUIREDNESS FOR MANAGER ENTRY IS ENFORCED IN THE SERVICE, not here.
--
-- ── Precision ──────────────────────────────────────────────────────────────
-- Decimal(8,2), not (5,2) like `run_hours`. `run_hours` is bounded by 24; a
-- METER is cumulative and only ever climbs. The machine reads ~2,805 h today
-- and accrues ~1,400 h/yr, so a (6,2) ceiling of 9,999.99 would be reached
-- inside this asset's service life — a column that overflows in five years is
-- a defect with a delivery date. (8,2) holds 999,999.99.

ALTER TABLE "equipment_daily_throughput"
  ADD COLUMN IF NOT EXISTS "start_hours" DECIMAL(8,2),
  ADD COLUMN IF NOT EXISTS "end_hours"   DECIMAL(8,2);

-- The pair is all-or-nothing. A row holding an End with no Start is a reading
-- that cannot be differenced and cannot be carried forward to the next day —
-- it would silently defeat the prior-day prefill (D4) rather than announce a
-- gap. Existing rows satisfy this trivially: both are NULL.
ALTER TABLE "equipment_daily_throughput"
  DROP CONSTRAINT IF EXISTS "equipment_daily_throughput_meter_pair_complete";
ALTER TABLE "equipment_daily_throughput"
  ADD CONSTRAINT "equipment_daily_throughput_meter_pair_complete"
  CHECK (("start_hours" IS NULL) = ("end_hours" IS NULL));

-- The machine never runs past midnight, so End is strictly GREATER than Start.
-- End <= Start is a keying error (a transposed pair, or yesterday's End typed
-- twice), never a short day. Enforced here as well as in the service because
-- ADR-0079's own D2 reasoning applies: a CHECK guards the table against a write
-- path nobody has written yet.
ALTER TABLE "equipment_daily_throughput"
  DROP CONSTRAINT IF EXISTS "equipment_daily_throughput_meter_end_after_start";
ALTER TABLE "equipment_daily_throughput"
  ADD CONSTRAINT "equipment_daily_throughput_meter_end_after_start"
  CHECK ("start_hours" IS NULL OR "end_hours" > "start_hours");

-- A meter reading is cumulative and cannot be negative.
ALTER TABLE "equipment_daily_throughput"
  DROP CONSTRAINT IF EXISTS "equipment_daily_throughput_meter_non_negative";
ALTER TABLE "equipment_daily_throughput"
  ADD CONSTRAINT "equipment_daily_throughput_meter_non_negative"
  CHECK ("start_hours" IS NULL OR "start_hours" >= 0);

-- The DERIVED difference must agree with the stored `run_hours` to the cent.
-- `run_hours` remains NOT NULL and remains the column every read path uses
-- (ADR-0079 D3); this constraint is what stops the two representations from
-- disagreeing once both are present. Rows with NULL start/end are exempt and
-- keep the hand-entered history exactly as recorded.
ALTER TABLE "equipment_daily_throughput"
  DROP CONSTRAINT IF EXISTS "equipment_daily_throughput_run_hours_is_the_difference";
ALTER TABLE "equipment_daily_throughput"
  ADD CONSTRAINT "equipment_daily_throughput_run_hours_is_the_difference"
  CHECK ("start_hours" IS NULL OR "run_hours" = "end_hours" - "start_hours");

COMMENT ON COLUMN "equipment_daily_throughput"."start_hours" IS
  'ADR-0107 — cumulative hour-METER reading at shift start (not a clock time). NULL on pre-ADR-0107 rows; never backfilled.';
COMMENT ON COLUMN "equipment_daily_throughput"."end_hours" IS
  'ADR-0107 — cumulative hour-METER reading at shift end. run_hours = end_hours - start_hours, enforced by CHECK when both are present.';
