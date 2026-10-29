-- ADR-0143 — read-only diagnosis of a negative inventory pool.
--
-- Every figure in ADR-0143 and docs/plans/2026-10-29-inventory-negative-permanent-fix.md
-- came from these queries (run 2026-10-29 ~08:30 PDT against prod).
-- READ ONLY: the whole file runs inside BEGIN TRANSACTION READ ONLY and ends in ROLLBACK.
-- Output is aggregates only. Do not paste rows from this anywhere outside SVdP hosts.
--
-- Run (CHAD-HQ / svdp-dev):
--   ssh 10.99.0.2 'docker exec -i dr3-vision-postgres psql -U dr3 -d dr3_vision -X -q \
--     -v site=woodland' < docs/queries/2026-10-29-inventory-pool-diagnosis.sql
--
-- Mirrors computePoolBalance (src/lib/inventory/running-balance.ts:399): newest non-voided
-- physical anchor (snapshot_at DESC, created_at DESC); @db.Date legs strictly after the
-- anchor's Pacific day; inbound arrived_at from Pacific midnight of the day after; inbound
-- statuses verified|submitted_to_mymrc|processed; drop-offs all kinds -> program pool;
-- whole units sold = outbound sub_category 'renovation'. saved_units is NOT subtracted on
-- the live path.

BEGIN TRANSACTION READ ONLY;
\pset footer off

-- 1. Live balance by pool, per site.
WITH a AS (
  SELECT DISTINCT ON (site_id) site_id, snapshot_at, pool_attribution, program_units, non_program_units
  FROM site_inventory_snapshots
  WHERE voided_at IS NULL AND snapshot_kind = 'physical' AND snapshot_at <= now()
  ORDER BY site_id, snapshot_at DESC, created_at DESC),
b AS (SELECT a.*, (a.snapshot_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date aday FROM a)
SELECT s.code, b.aday AS anchor_day, b.pool_attribution, b.program_units AS anchor_p, b.non_program_units AS anchor_np,
  (SELECT coalesce(sum(program_unit_count),0) FROM inbound_loads i WHERE i.site_id=b.site_id
     AND status IN ('verified','submitted_to_mymrc','processed')
     AND arrived_at >= ((b.aday+1)::timestamp AT TIME ZONE 'America/Los_Angeles')) AS in_p,
  (SELECT coalesce(sum(non_program_unit_count),0) FROM inbound_loads i WHERE i.site_id=b.site_id
     AND status IN ('verified','submitted_to_mymrc','processed')
     AND arrived_at >= ((b.aday+1)::timestamp AT TIME ZONE 'America/Los_Angeles')) AS in_np,
  (SELECT coalesce(sum(units),0) FROM consumer_dropoffs c WHERE c.site_id=b.site_id AND dropoff_date > b.aday) AS drop_p,
  (SELECT coalesce(sum(stripped_program),0) FROM processed_units_daily p WHERE p.site_id=b.site_id AND production_date > b.aday) AS st_p,
  (SELECT coalesce(sum(stripped_non_program),0) FROM processed_units_daily p WHERE p.site_id=b.site_id AND production_date > b.aday) AS st_np
FROM b JOIN sites s ON s.id = b.site_id;

-- 2. Do the two independent processed sources agree? (workbook-sync rows vs MyMRC processed mirror)
SELECT date_trunc('week', p.production_date)::date AS wk,
  sum(p.stripped_program) AS workbook_p, sum(p.stripped_non_program) AS workbook_np,
  sum(m.program_unit_count) AS mymrc_p, sum(m.non_program_unit_count) AS mymrc_np
FROM processed_units_daily p
JOIN sites s ON s.id = p.site_id AND s.code = :'site'
LEFT JOIN (SELECT site_id, processed_date::date d, sum(program_unit_count) program_unit_count, sum(non_program_unit_count) non_program_unit_count
           FROM mymrc_processed_mirror WHERE disappeared_at IS NULL GROUP BY 1,2) m
  ON m.site_id = p.site_id AND m.d = p.production_date
WHERE p.production_date > now() - interval '60 days'
GROUP BY 1 ORDER BY 1;

-- 3. Daily pool-split behaviour, by period: how often processed-program equals
--    program intake (+ drop-offs) that day, and how often non-program processed is 0.
WITH s AS (SELECT id FROM sites WHERE code = :'site'),
inb AS (SELECT (arrived_at AT TIME ZONE 'America/Los_Angeles')::date dd, sum(program_unit_count) p, sum(non_program_unit_count) np
        FROM inbound_loads WHERE site_id=(SELECT id FROM s) AND status IN ('verified','submitted_to_mymrc','processed')
          AND arrived_at >= now() - interval '120 days' GROUP BY 1),
dr AS (SELECT dropoff_date dd, sum(units) u FROM consumer_dropoffs WHERE site_id=(SELECT id FROM s) GROUP BY 1),
j AS (SELECT p.production_date dd, p.stripped_program sp, p.stripped_non_program snp,
             coalesce(inb.p,0)+coalesce(dr.u,0) ip, coalesce(inb.np,0) inp
      FROM processed_units_daily p LEFT JOIN inb ON inb.dd=p.production_date LEFT JOIN dr ON dr.dd=p.production_date
      WHERE p.site_id=(SELECT id FROM s) AND p.production_date >= now() - interval '120 days')
SELECT date_trunc('month', dd)::date AS month, count(*) AS days,
  count(*) FILTER (WHERE sp = ip) AS program_eq_intake,
  count(*) FILTER (WHERE snp = 0) AS nonprogram_zero_days,
  sum(inp) AS nonprogram_in, sum(snp) AS nonprogram_processed
FROM j GROUP BY 1 ORDER BY 1;

-- 4. Ledger prediction vs the next physical count, per anchor interval (per pool).
WITH s AS (SELECT id FROM sites WHERE code = :'site'),
a AS (SELECT (snapshot_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Los_Angeles')::date d, program_units p, non_program_units np
      FROM site_inventory_snapshots WHERE site_id=(SELECT id FROM s) AND voided_at IS NULL AND snapshot_kind='physical'),
iv AS (SELECT d d0, p p0, np np0, lead(d) OVER w d1, lead(p) OVER w p1, lead(np) OVER w np1 FROM a WINDOW w AS (ORDER BY d))
SELECT d0, d1, p0, np0,
  p0 + (SELECT coalesce(sum(program_unit_count),0) FROM inbound_loads WHERE site_id=(SELECT id FROM s)
          AND status IN ('verified','submitted_to_mymrc','processed')
          AND arrived_at >= ((d0+1)::timestamp AT TIME ZONE 'America/Los_Angeles')
          AND arrived_at <  ((d1+1)::timestamp AT TIME ZONE 'America/Los_Angeles'))
     + (SELECT coalesce(sum(units),0) FROM consumer_dropoffs WHERE site_id=(SELECT id FROM s) AND dropoff_date > d0 AND dropoff_date <= d1)
     - (SELECT coalesce(sum(stripped_program),0) FROM processed_units_daily WHERE site_id=(SELECT id FROM s) AND production_date > d0 AND production_date <= d1)
     AS ledger_p_at_d1,
  p1 AS counted_p,
  np0 + (SELECT coalesce(sum(non_program_unit_count),0) FROM inbound_loads WHERE site_id=(SELECT id FROM s)
          AND status IN ('verified','submitted_to_mymrc','processed')
          AND arrived_at >= ((d0+1)::timestamp AT TIME ZONE 'America/Los_Angeles')
          AND arrived_at <  ((d1+1)::timestamp AT TIME ZONE 'America/Los_Angeles'))
     - (SELECT coalesce(sum(stripped_non_program),0) FROM processed_units_daily WHERE site_id=(SELECT id FROM s) AND production_date > d0 AND production_date <= d1)
     AS ledger_np_at_d1,
  np1 AS counted_np
FROM iv WHERE d1 IS NOT NULL ORDER BY d0;
-- (outbound renovation and landfilled were 0/0 in every Woodland interval through 2026-10-28;
--  add them here if that changes.)

ROLLBACK;
