-- ADR-0138 — Woodland's 2026-09-14 hard count (885 indoor, snapshot 04cb7ae2) was counted by
-- Juan. Source: Bill, 2026-09-24 8:57 PM PDT, in session ("Juan counted it"), answering the
-- open question the ADR-0138 backfill left (that row had no named counter anywhere).
--
-- SAFETY: one transaction; hard-stops unless the row is exactly the documented live 885
-- physical count and still unattributed. Audit row, system actor.
-- EXECUTED 2026-09-24 8:58 PM PDT. Backup: the attempted row CSV failed on shell quoting; prior value NULL is in
-- svdp-dev:~/backups-adhoc/dr3-site_inventory_snapshots-pre-adr0138-backfill-20260924-072713-PT.dump).
--
-- RUN on svdp-dev:
--   docker exec -i dr3-vision-postgres sh -c 'psql -v ON_ERROR_STOP=1 -U $POSTGRES_USER -d $POSTGRES_DB' \
--     < scripts/one-off/2026-09-24-adr0138-woodland-counted-by-juan.sql

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT id, units_indoor, snapshot_kind, voided_at, counted_by
    INTO r
    FROM site_inventory_snapshots
   WHERE id = '04cb7ae2-06e7-47b4-b8bf-3d7a6e140a61'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'snapshot 04cb7ae2 not found'; END IF;
  IF r.snapshot_kind <> 'physical' OR r.voided_at IS NOT NULL OR r.units_indoor <> 885 THEN
    RAISE EXCEPTION 'snapshot 04cb7ae2 is not the documented live 885 physical count';
  END IF;
  IF r.counted_by IS NOT NULL THEN
    RAISE EXCEPTION 'snapshot 04cb7ae2 already attributed (counted_by = %)', r.counted_by;
  END IF;

  UPDATE site_inventory_snapshots SET counted_by = 'Juan' WHERE id = r.id;

  INSERT INTO audit_log (id, actor_user_id, actor_label, action, table_name, row_id, before, after)
  VALUES (
    gen_random_uuid()::text, NULL,
    'system:adr0138-counted-by-backfill (executed by Claude Code at Bill''s direction 2026-09-24)',
    'update', 'site_inventory_snapshots', r.id,
    jsonb_build_object('counted_by', NULL),
    jsonb_build_object(
      'counted_by', 'Juan',
      'source', 'Bill, 2026-09-24 8:57 PM PDT: "Juan counted it" (Woodland 2026-09-14 hard count, 885)',
      'adr', 'ADR-0138'
    )
  );
END $$;

SELECT id, counted_by, confirmed_by FROM site_inventory_snapshots
 WHERE id = '04cb7ae2-06e7-47b4-b8bf-3d7a6e140a61';

COMMIT;
