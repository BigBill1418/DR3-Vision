-- DR3-Vision — Extract legacy employee numbers from bonus_employees.full_name (ADR-0026)
-- Migration: 20260615_bonus_employee_number
--
-- Context (verified against production 2026-06-15):
--   * 107 bonus_employees rows total.
--   * Exactly 21 rows (all site "DR3 Woodland") have a legacy employee number
--     appended to the display name as "<name> <4 digits>", e.g. "Jane Doe 9071".
--   * The pattern is uniform: a single space then exactly four ASCII digits at
--     the END of full_name. No 3/5-digit variance, no leading zeros, no embedded
--     numbers. All 21 extracted numbers are distinct.
--   * 1 of the 21 is soft-deleted/inactive and MUST still be backfilled.
--   * All 21 already have previous_names populated -> we APPEND, never overwrite.
--   * users.name is clean (0 digit-bearing rows) and is NOT touched here.
--   * previous_names column type confirmed `jsonb` (the || concat below is valid).
--
-- This migration is pure additive DDL + a one-time in-place backfill. It is fully
-- idempotent (IF NOT EXISTS DDL; pattern-and-null-guarded UPDATE). See ADR-0026.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Add the column (nullable; production rows have no number).
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "bonus_employees"
  ADD COLUMN IF NOT EXISTS "employee_number" TEXT;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Non-unique lookup index. Per-site uniqueness is enforced at the
--    application layer, NOT here (soft-delete + rehire + external legacy
--    ownership of the numbers -- see ADR-0026).
-- ─────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bonus_employees_site_id_employee_number_idx"
  ON "bonus_employees" ("site_id", "employee_number");

-- ─────────────────────────────────────────────────────────────────────
-- 3. Provenance: append a "name_normalized" entry to previous_names for
--    every row we are about to modify, recording the pre-strip full_name.
--    Runs BEFORE the strip so the recorded value still contains the number.
--    Guarded by employee_number IS NULL so a re-run does not append twice
--    (step 4 sets employee_number, so on re-run this WHERE is empty).
--    COALESCE handles the (non-occurring today) case of a NULL previous_names.
-- ─────────────────────────────────────────────────────────────────────
UPDATE "bonus_employees"
SET "previous_names" = COALESCE("previous_names", '[]'::jsonb)
    || jsonb_build_array(
         jsonb_build_object(
           'name', "full_name",
           'changed_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'reason', 'employee_number_extracted',
           'migration', '20260615_bonus_employee_number'
         )
       )
WHERE "full_name" ~ ' [0-9]{4}$'
  AND "employee_number" IS NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 4. Extract the number into employee_number, then strip it (and any
--    surrounding whitespace) out of full_name. Non-matching rows and rows
--    already backfilled (employee_number IS NOT NULL) are skipped.
-- ─────────────────────────────────────────────────────────────────────
UPDATE "bonus_employees"
SET "employee_number" = substring("full_name" from ' ([0-9]{4})$'),
    "full_name"       = btrim(regexp_replace("full_name", ' [0-9]{4}$', ''))
WHERE "full_name" ~ ' [0-9]{4}$'
  AND "employee_number" IS NULL;
