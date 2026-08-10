#!/usr/bin/env bash
# ADR-0089 D4 step 3 — the re-key delta report. READ-ONLY, run after the
# re-detail sweep + enrich pass, BEFORE any re-bridge. Bill reads this.
#
# WHAT IT ANSWERS (Am.1 §3): re-keying inbound on
# COALESCE(recycler_reported_delivery_date, docking_appointment_date) does two
# distinct things, and this report separates them per Pacific day:
#   1. ADDS the collection-network hauls the old key dropped entirely
#      (dock date null — the 35 post-anchor hauls / 2,429 units);
#   2. RE-ATTRIBUTES already-bridged hauls whose true delivery differs from
#      their appointment (H-136583 dock 08-12 / delivered 08-06 class) —
#      units MOVE between floor days managers have already seen.
# The re-bridge (fix-woodland-inbound.sh --apply) is refused until this report
# has been read and the movement accepted — that is the Am.1 §3 decision.
#
# Window: post-anchor only (>= 2026-07-22), matching ADR-0059 D5 — pre-anchor
# history stays out of the live floor regardless of its recovered dates.
set -euo pipefail

SITE_CODE='woodland'
WINDOW_START='2026-07-22'
PG_CONTAINER='dr3-vision-postgres'
PSQL=(docker exec -i "$PG_CONTAINER" psql -U dr3 -d dr3_vision -v ON_ERROR_STOP=1)

docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" >/dev/null 2>&1 \
  || { echo "container $PG_CONTAINER not found — run this on the prod host" >&2; exit 2; }

echo '=== readiness: Am.1 field coverage (re-detail must be complete first) ==='
"${PSQL[@]}" <<'SQL'
SELECT count(*)                                                        AS delivered_total,
       count(*) FILTER (WHERE recycler_reported_delivery_date IS NOT NULL) AS with_delivery_date,
       count(*) FILTER (WHERE detail_fetched_at IS NULL)               AS awaiting_redetail
  FROM mymrc_hauls_mirror WHERE status = 'Delivered';
SQL

echo '=== per-day delta: OLD key (appointment) vs NEW key (COALESCE) ==='
"${PSQL[@]}" <<SQL
WITH s AS (SELECT id FROM sites WHERE code='${SITE_CODE}'),
old_key AS (
  SELECT docking_appointment_date::date AS day,
         count(*) AS hauls,
         coalesce(sum(program_unit_count),0)     AS prog,
         coalesce(sum(non_program_unit_count),0) AS nonprog
    FROM mymrc_hauls_mirror
   WHERE status='Delivered' AND type='General' AND site_id=(SELECT id FROM s)
     AND docking_appointment_date >= '${WINDOW_START}'
   GROUP BY 1),
new_key AS (
  SELECT COALESCE(recycler_reported_delivery_date, docking_appointment_date)::date AS day,
         count(*) AS hauls,
         coalesce(sum(program_unit_count),0)     AS prog,
         coalesce(sum(non_program_unit_count),0) AS nonprog
    FROM mymrc_hauls_mirror
   WHERE status='Delivered' AND type='General' AND site_id=(SELECT id FROM s)
     AND COALESCE(recycler_reported_delivery_date, docking_appointment_date) >= '${WINDOW_START}'
   GROUP BY 1)
SELECT coalesce(o.day, n.day)                    AS day,
       coalesce(o.hauls, 0)                      AS old_hauls,
       coalesce(n.hauls, 0)                      AS new_hauls,
       coalesce(o.prog, 0)                       AS old_prog,
       coalesce(n.prog, 0)                       AS new_prog,
       coalesce(n.prog, 0) - coalesce(o.prog, 0) AS prog_delta,
       coalesce(n.nonprog, 0) - coalesce(o.nonprog, 0) AS nonprog_delta,
       CASE WHEN o.day IS NULL THEN 'NEW DAY (was invisible)'
            WHEN n.prog IS DISTINCT FROM o.prog
              OR n.nonprog IS DISTINCT FROM o.nonprog THEN 'CHANGED'
            ELSE 'unchanged' END                 AS verdict
  FROM old_key o FULL OUTER JOIN new_key n USING (day)
 ORDER BY day;
SQL

echo '=== movement summary ==='
"${PSQL[@]}" <<SQL
WITH s AS (SELECT id FROM sites WHERE code='${SITE_CODE}'),
m AS (
  SELECT docking_appointment_date::date AS old_day,
         COALESCE(recycler_reported_delivery_date, docking_appointment_date)::date AS new_day,
         program_unit_count, non_program_unit_count
    FROM mymrc_hauls_mirror
   WHERE status='Delivered' AND type='General' AND site_id=(SELECT id FROM s)
     AND COALESCE(recycler_reported_delivery_date, docking_appointment_date) >= '${WINDOW_START}')
SELECT count(*) FILTER (WHERE old_day IS NULL)                          AS hauls_added,
       coalesce(sum(program_unit_count)    FILTER (WHERE old_day IS NULL),0) AS prog_added,
       coalesce(sum(non_program_unit_count) FILTER (WHERE old_day IS NULL),0) AS nonprog_added,
       count(*) FILTER (WHERE old_day IS NOT NULL AND old_day <> new_day)     AS hauls_moved,
       coalesce(sum(program_unit_count) FILTER (WHERE old_day IS NOT NULL AND old_day <> new_day),0)
                                                                        AS prog_moved,
       max(old_day - new_day) FILTER (WHERE old_day IS NOT NULL)        AS max_days_earlier
  FROM m;
SQL

echo 'Read the deltas above. If accepted, the re-bridge is:'
echo '  ~/DR3-Vision/scripts/fix-woodland-inbound.sh --dry-run   # cross-check'
echo '  ~/DR3-Vision/scripts/fix-woodland-inbound.sh --apply     # gated, audited'
