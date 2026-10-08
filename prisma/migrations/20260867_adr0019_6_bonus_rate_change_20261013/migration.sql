-- ADR-0019.6: processor bonus rate change, BOTH sites, effective 2026-10-13
-- (approved by Bill Barnard 2026-10-07). New rule, identical for woodland and eugene:
--
--   daily_bonus = MAX(units - 60, 0) * $1.00 + MAX(units - 100, 0) * $0.25
--
-- Pricing is by each entry's OWN entry_date (src/lib/bonus/rule-book.ts), so a
-- day on or before 2026-10-12 keeps the old rule forever, including when an old
-- period is amended and re-locked after 10/13. Rates on historical rows are NOT
-- edited; the open rule is windowed (end_date = 2026-10-12) and a new row opens
-- on 2026-10-13 with no end date. The seed CSV carries the same four rows.
--
-- One DO block, so it applies atomically and can be executed as one statement
-- by the real-DB test (processor-bonus-rate-change.db.test.ts).
--
-- Idempotent: the close only touches an OPEN rule that started before 10/13,
-- and the insert is skipped when the site already has a 2026-10-13 row. On a
-- clean replay (empty DB, ADR-0035) there are no sites, so both are no-ops and
-- the seed CSV supplies the rows.
--
-- Fails closed: if, after the change, any day is covered by two rows for one
-- site, the whole migration aborts (the resolver would refuse to price it).
DO $$
DECLARE
  offenders text;
BEGIN
  UPDATE "processor_bonus_rules" r
     SET "end_date" = DATE '2026-10-12',
         "notes" = COALESCE(r."notes" || ' ', '') ||
                   'Closed 2026-10-12 by ADR-0019.6 (new rule from 2026-10-13).'
    FROM "sites" s
   WHERE s."id" = r."site_id"
     AND s."code" IN ('woodland', 'eugene')
     AND r."end_date" IS NULL
     AND r."effective_date" < DATE '2026-10-13';

  INSERT INTO "processor_bonus_rules"
    ("id", "site_id", "threshold_low", "rate_low", "threshold_high", "rate_high",
     "effective_date", "end_date", "notes")
  SELECT gen_random_uuid()::text, s."id", 60, 1.0000, 100, 0.2500, DATE '2026-10-13', NULL,
         'Daily bonus = MAX(units - 60, 0) * $1.00 + MAX(units - 100, 0) * $0.25 '
         '(units 61-100 earn $1.00, 101+ earn $1.25). ADR-0019.6, approved by Bill 2026-10-07.'
    FROM "sites" s
   WHERE s."code" IN ('woodland', 'eugene')
     AND NOT EXISTS (
       SELECT 1 FROM "processor_bonus_rules" p
        WHERE p."site_id" = s."id" AND p."effective_date" = DATE '2026-10-13'
     );

  SELECT string_agg(DISTINCT s."code", ', ') INTO offenders
    FROM "processor_bonus_rules" a
    JOIN "processor_bonus_rules" b
      ON a."site_id" = b."site_id" AND a."id" < b."id"
     AND daterange(a."effective_date", a."end_date", '[]')
      && daterange(b."effective_date", b."end_date", '[]')
    JOIN "sites" s ON s."id" = a."site_id";
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'ADR-0019.6: overlapping processor_bonus_rules windows at site(s): %', offenders;
  END IF;
END $$;
