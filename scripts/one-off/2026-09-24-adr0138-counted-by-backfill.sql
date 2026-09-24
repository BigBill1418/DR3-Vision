-- ADR-0138 — one-off backfill of `counted_by` / `confirmed_by` for the physical counts
-- whose real counters are DOCUMENTED. Every other physical row stays NULL (the report
-- then reads "Not recorded · entered by <actor>", which is true).
--
-- THE ONE DOCUMENTED ROW
--   7232d092-e02a-4487-8bc0-8a1ff62ee29b — Eugene, 751 (19 program / 732 non-program),
--   closing of 2026-09-16. Commit 3a315881 (2026-09-16 4:08 PM PDT) and OPEN-ITEMS
--   § 0.BT BT-6: "Counted by Chris R, confirmed by Patrick D; relayed by Bill 4:07 PM PT."
--
-- ROWS DELIBERATELY LEFT NULL (no named counter anywhere in OPEN-ITEMS / CHANGELOG /
-- commit messages): Woodland 04cb7ae2 (885, "Bill's 2026-09-14 hard count" — who
-- physically counted is not recorded), 855a23b1 / 6f8ae03b (923, "crew counted total
-- only"), 55654cd7 (2,483, floor entry by Janette Tomas), a07707ed (3,977, 06-30).
--
-- SAFETY: one transaction; hard-stops unless the row is exactly the documented count and
-- still unattributed; re-running after success is a no-op that raises. Audit row
-- (CLAUDE.md hard rule #6), system actor. Backup taken first (ADR-0138 § Backfill).
--
-- RUN on svdp-dev:
--   docker exec -i dr3-vision-postgres sh -c 'psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB' \
--     < scripts/one-off/2026-09-24-adr0138-counted-by-backfill.sql

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT id, units_total, program_units, non_program_units, snapshot_kind, voided_at, counted_by
    INTO r
    FROM site_inventory_snapshots
   WHERE id = '7232d092-e02a-4487-8bc0-8a1ff62ee29b'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot 7232d092 not found'; END IF;
  IF r.snapshot_kind <> 'physical' OR r.voided_at IS NOT NULL OR r.units_total <> 751
     OR r.program_units <> 19 OR r.non_program_units <> 732 THEN
    RAISE EXCEPTION 'snapshot 7232d092 is not the documented 751 = 19/732 live physical count';
  END IF;
  IF r.counted_by IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot 7232d092 already attributed (counted_by = %)', r.counted_by;
  END IF;

  UPDATE site_inventory_snapshots
     SET counted_by = 'Chris R', confirmed_by = 'Patrick D'
   WHERE id = r.id;

  INSERT INTO audit_log (id, actor_user_id, actor_label, action, table_name, row_id, before, after)
  VALUES (
    gen_random_uuid()::text, NULL,
    'system:adr0138-counted-by-backfill (executed by Claude Code at Bill''s direction 2026-09-24)',
    'update', 'site_inventory_snapshots', r.id,
    jsonb_build_object('counted_by', NULL, 'confirmed_by', NULL),
    jsonb_build_object(
      'counted_by', 'Chris R',
      'confirmed_by', 'Patrick D',
      'source', 'commit 3a315881 / OPEN-ITEMS 0.BT BT-6: Counted by Chris R, confirmed by Patrick D; relayed by Bill 4:07 PM PT (2026-09-16)',
      'adr', 'ADR-0138'
    )
  );
END $$;

SELECT id, counted_by, confirmed_by FROM site_inventory_snapshots
 WHERE id = '7232d092-e02a-4487-8bc0-8a1ff62ee29b';

COMMIT;
