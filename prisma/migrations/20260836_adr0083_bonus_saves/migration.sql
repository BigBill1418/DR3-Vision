-- ADR-0083 — a `saves` column beside `mattress_count` on the bonus daily entry.
--
-- JT: "add a space for saves — they also get paid for every mattress saved to
-- sell — a dedicated 'saves' field beside processed." Bill: same bonus entry,
-- same amendment rules, pays at the processing rate, and becomes resale stock.
--
-- Purely additive. One new column on one table, no backfill of a GUESSED value,
-- zero drops, zero type changes, zero rewrites of existing values. Safe to apply
-- to the live database with the app running, and safe to apply twice (every
-- statement is guarded).
--
-- ORDERING INVARIANT (ADR-0035): this directory name must sort lexically AFTER
-- the current chain tip `20260834_adr0078_am1_photo_uploaded_by`. It does.
-- `prisma migrate deploy` applies in directory-name order, not date order, and
-- the dates in this chain are sequence numbers rather than calendar facts.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why NOT NULL DEFAULT 0 is honest here, and not a not-recorded-as-zero
-- ─────────────────────────────────────────────────────────────────────────
--
-- This repo has been bitten by defaults that assert a fact nobody measured, so
-- the distinction is worth writing down rather than assuming.
--
-- Every pre-existing `bonus_daily_entries` row was keyed on a floor where saves
-- were NOT a captured quantity in the bonus entry at all. The true statement
-- about those rows is therefore "this employee's SAVES CONTRIBUTION TO BONUS on
-- that day was zero" — not "we don't know what it was". Nobody was paid for a
-- save before this column existed, so a real 0 is exactly what the payroll
-- record already means. A nullable column would model an uncertainty that does
-- not exist and would force every one of the ~9 pay read paths to carry a
-- `?? 0`, which is where a silent null-to-zero coercion bug lives.
--
-- That truthfulness is load-bearing, not cosmetic. ADR-0033's reconcile
-- tripwire (src/lib/bonus/reconcile-fetch.ts) independently RECOMPUTES every
-- period's grand total and pages URGENT + refuses the payroll PDF when the
-- recompute disagrees with the signed `total_payout_cents`. After this
-- migration that recompute includes saves. Because the backfill is a real zero,
-- `calculateDailyBonusCents(mattress_count + 0)` is byte-identical to
-- `calculateDailyBonusCents(mattress_count)` for every historical row — so every
-- already-signed period reconciles at ZERO drift and no page fires. A nullable
-- column, or any non-zero backfill, would have made every signed period in the
-- system report drifted on the next PDF render.
--
-- Pinned by `src/lib/bonus/__tests__/saves-historical-reconcile.test.ts`.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Why Decimal(5,1), matching mattress_count exactly
-- ─────────────────────────────────────────────────────────────────────────
--
-- `mattress_count` is `NUMERIC(5,1)` (ADR-0023: historical half-shift values and
-- a one-decimal UI). The bonus formula operates on `mattress_count + saves`, so
-- the two columns are summed on the pay path. Giving `saves` a different
-- precision would put a rounding seam inside a payroll addition. Same type, same
-- range (0..999), same one-decimal resolution, same validator
-- (`isValidMattressCount`).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name   = 'bonus_daily_entries'
           AND column_name  = 'saves'
    ) THEN
        ALTER TABLE "bonus_daily_entries"
            ADD COLUMN "saves" DECIMAL(5,1) NOT NULL DEFAULT 0;
    END IF;
END
$$;

-- No new index. `saves` is never a search key: it is read alongside
-- `mattress_count` on rows already located by
-- `bonus_daily_entries_bonus_employee_id_entry_date_key` or by the
-- `bonus_pay_period_id` / `entry_date` indexes. An index Postgres would not use
-- is ceremony, not performance (same reasoning ADR-0078 D1 recorded).
