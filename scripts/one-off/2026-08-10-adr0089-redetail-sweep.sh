#!/usr/bin/env bash
# ADR-0089 D4 step 1 — re-detail the mirror so every row carries the Am.1 fields.
#
# WHY. The Am.1 deploy widens HAUL_OPTIONAL_FIELDS with
# Recycler_Reported_Delivery_Date__c (+ transporter date + unload count), but a
# detail is fetched ONCE per row (detail_fetched_at cursor): every pre-deploy row
# holds a detail captured WITHOUT the new fields, so its
# recycler_reported_delivery_date stays NULL until re-fetched. This script clears
# the cursor for exactly those rows; the existing one-shot enrichment runner then
# re-fetches them in ~100-record batched POSTs (≈74 batches for the full mirror,
# a few minutes).
#
# WRITES: only `detail_fetched_at = NULL` on mymrc_hauls_mirror — a SCRAPER
# CURSOR, not a business figure. The enrich pass re-stamps it with fresh detail
# data through the existing, tested write path. No inbound/floor table is
# touched; the re-bridge is a SEPARATE, Bill-gated step that runs only after the
# delta report (2026-08-10-adr0089-rekey-delta-report.sh) has been read.
#
# SEQUENCE (ADR-0089 Am.1 §3 / OPEN-ITEMS):
#   1. deploy the Am.1 build (migration adds the columns; bridge/freshness re-key)
#   2. THIS SCRIPT --apply, then the enrich run it prints
#   3. 2026-08-10-adr0089-rekey-delta-report.sh   (read-only; Bill reads it)
#   4. fix-woodland-inbound.sh --apply            (the gated re-bridge)
#
# MODES: --dry-run (default) counts; --apply clears the cursor + prints the
# enrich command. Run on CHAD-HQ.
set -euo pipefail

PG_CONTAINER='dr3-vision-postgres'
PSQL=(docker exec -i "$PG_CONTAINER" psql -U dr3 -d dr3_vision -v ON_ERROR_STOP=1)

MODE='--dry-run'
case "${1:---dry-run}" in
  --dry-run|--apply) MODE="${1:---dry-run}" ;;
  -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown flag: $1 (--dry-run | --apply)" >&2; exit 2 ;;
esac

docker inspect -f '{{.State.Running}}' "$PG_CONTAINER" >/dev/null 2>&1 \
  || { echo "container $PG_CONTAINER not found — run this on the prod host" >&2; exit 2; }

echo '=== rows still lacking the Am.1 delivery date (re-detail candidates) ==='
"${PSQL[@]}" <<'SQL'
SELECT count(*)                                        AS candidates,
       count(*) FILTER (WHERE status = 'Delivered')    AS delivered,
       count(*) FILTER (WHERE docking_appointment_date IS NULL) AS undated_by_dock
  FROM mymrc_hauls_mirror
 WHERE recycler_reported_delivery_date IS NULL
   AND detail_fetched_at IS NOT NULL;
SQL

if [ "$MODE" = '--dry-run' ]; then
  echo 'dry run — no cursor cleared. Re-run with --apply.'
  exit 0
fi

echo '=== clearing the detail cursor (scraper state only; audited) ==='
"${PSQL[@]}" <<'SQL'
BEGIN;
WITH cleared AS (
  UPDATE mymrc_hauls_mirror
     SET detail_fetched_at = NULL
   WHERE recycler_reported_delivery_date IS NULL
     AND detail_fetched_at IS NOT NULL
  RETURNING id)
INSERT INTO audit_log (id, actor_label, action, table_name, row_id, after)
SELECT gen_random_uuid(), 'system:adr0089-redetail-sweep', 'update',
       'mymrc_hauls_mirror', 'bulk:' || count(*), jsonb_build_object(
         'detail_fetched_at', NULL, 'rows', count(*),
         'reason', 'ADR-0089 D4 — re-fetch details with the Am.1 field set')
  FROM cleared;
COMMIT;
SQL

echo 'Cursor cleared. Now run the enrichment sweep (re-fetches in batched POSTs):'
echo '  cd ~/DR3-Vision && docker compose run --rm --no-deps mymrc-scrape node scripts/mymrc-enrich-details.mjs'
echo 'Then verify coverage:'
echo '  docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c \'
echo '    "SELECT count(*) FILTER (WHERE recycler_reported_delivery_date IS NOT NULL) AS dated, count(*) AS total FROM mymrc_hauls_mirror WHERE status='"'"'Delivered'"'"';"'
