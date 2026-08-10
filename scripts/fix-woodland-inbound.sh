#!/usr/bin/env bash
# fix-woodland-inbound.sh — Woodland frozen-intake remediation (diagnosis:
# docs/2026-07-30-negative-inventory-diagnosis.md; handoff: PR #196 /
# docs/handoffs/2026-08-03-layer-1-frozen-intake-remediation-and-freshness-gu.md).
#
# WHAT THIS IS. The inbound (delivered-hauls) feed froze on 2026-07-22 while
# processing kept landing, driving the Woodland floor negative. This script
# recovers the missing inbound WINDOW through the sanctioned ADR-0059 bridge —
# never through raw INSERTs — with a verify → dry-run → gate → apply → report
# ladder, and a clean rollback of exactly what apply writes.
#
# SCHEMA GROUND-TRUTH (verified against prod 2026-08-03; do not "correct" these
# back to the diagnosis-era guesses):
#   • table `mymrc_backfill_cursors` (NOT `ingest_cursors`) — key
#     (object_api_name='Haul_Request__c', list_view_api_name='completed_hauls').
#   • `inbound_loads` unit columns are `program_unit_count` /
#     `non_program_unit_count` (NOT `program_units`/`non_program_units` — those
#     live on `site_inventory_snapshots`/`landfilled_units`).
#   • There is NO per-haul `mymrc_haul` column and NO per-haul bridge rows: the
#     bridge writes ONE AGGREGATE row per (site, delivery day) with
#     `load_source_type='mymrc_haul'`, arbitrated by the partial unique index
#     `inbound_loads_aggregate_site_day_key` ON (site_id, arrived_at) WHERE
#     load_source_type IN ('paper_bulk','mymrc_haul','ipad_floor'). An
#     `ON CONFLICT (external_mymrc_haul_id)` per-haul writer would double-count
#     against that aggregate design — which is why this script delegates every
#     write to `dist/mymrc.bridgeInboundHaulsToInventory` (absolute-set,
#     precedence-guarded, audited) instead of shipping its own SQL.
#   • There is NO `source_note` column, and none is needed for rollback:
#     bridge-owned rows are structurally identified by
#     `load_source_type='mymrc_haul'`, and every write lands an `audit_log` row
#     (actor_label 'mymrc-inbound-bridge') in the same transaction.
#
# WHY NOT scripts/mymrc-inbound-bridge-backfill.mjs DIRECTLY for apply: that
# runner carries the ADR-0059 D5 floor-INVARIANCE gate (live floor must not
# move — correct for the pre-anchor historical backfill, inverted for a
# recovery whose whole point is to move the floor). It would exit 1 and page
# `inbound-bridge-floor-drift` on success. Its --dry-run is used as a
# cross-check; apply calls the same bridge library without the invariance gate.
#
# NOTE the hourly scrape auto-bridges delivery days within a trailing 10-day
# window (scripts/mymrc-scrape.mjs recentProcessedFloor). This script exists
# for the days MRC late-marks Delivered AFTER they slide out of that window —
# from 2026-08-02 onward that is every day of the frozen window.
#
# MODES (default --verify-only; every mode reports, only --apply/--rollback write):
#   --verify-only   four read-only blocks: floor, inbound freshness,
#                   delivered-vs-confirmed guard trap, backfill-cursor state.
#   --dry-run       day-by-day recovery plan from the mirror + falsification
#                   gate verdict. No writes.
#   --apply         dry-run + gate, then bridge the window and report the floor
#                   before/after. Refuses when the gate trips.
#   --allow-partial (with --apply) waive the >=GATE_MIN gate ONCE the upstream
#                   cause is understood — e.g. MRC marking deliveries in
#                   batches. Never the first resort: a small recoverable total
#                   on the FIRST run means upstream intake loss (handoff §2.2).
#   --rollback      delete bridge-owned (`mymrc_haul`) aggregate rows with
#                   arrived_at >= the post-anchor instant, with an audit row.
#                   WARNING: days inside the hourly scrape's trailing 10-day
#                   window will be re-bridged within the hour — rollback is only
#                   durable after correcting the mirror (or pausing the scrape).
#
# FALSIFICATION GATE (handoff §2.2): if recoverable program units < GATE_MIN
# (~5,000 ≈ seven production days at 500–1,400/day), the drained-cursor theory
# is falsified — the units were never recorded upstream — and apply REFUSES.
#
# Run on the prod host (CHAD-HQ) from anywhere: needs docker + the
# dr3-vision-postgres / dr3-vision-app containers.
set -euo pipefail

SITE_CODE='woodland'
WINDOW_START='2026-07-22'                     # first frozen delivery day
ANCHOR_INSTANT='2026-07-23 07:00:00+00'       # Pacific midnight after the 07-22 anchor (onHand inboundSince)
GATE_MIN=5000
PG_CONTAINER='dr3-vision-postgres'
APP_CONTAINER='dr3-vision-app'

PSQL=(docker exec -i "$PG_CONTAINER" psql -U dr3 -d dr3_vision -v ON_ERROR_STOP=1)

MODE='--verify-only'
ALLOW_PARTIAL=0
for a in "$@"; do
  case "$a" in
    --verify-only|--dry-run|--apply|--rollback) MODE="$a" ;;
    --allow-partial) ALLOW_PARTIAL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $a (see --help)" >&2; exit 2 ;;
  esac
done

for c in "$PG_CONTAINER" "$APP_CONTAINER"; do
  docker inspect -f '{{.State.Running}}' "$c" >/dev/null 2>&1 \
    || { echo "container $c not found — run this on the prod host" >&2; exit 2; }
done

floor_sql() {
  cat <<SQL
WITH s AS (SELECT id FROM sites WHERE code='${SITE_CODE}'),
-- ADR-0084: voided counts are NOT anchors. This hand-written SQL reproduces
-- onHand()'s anchor selection against the prod database, so it has to reproduce
-- its WHERE clause too — otherwise this verification script reports a floor
-- computed from a count the app has already stopped using, and the operator
-- reads the divergence as a bug in the app.
--
-- KNOWN, PRE-EXISTING DIVERGENCE from onHand() (reported in ADR-0084, NOT fixed
-- here — this script is a one-shot remediation tool and widening it is a
-- separate change): no `snapshot_kind='physical'` filter, so a `computed`
-- snapshot could be picked as the anchor, and no `created_at DESC` tiebreak
-- (ADR-0078 D1), so two same-day counts leave the choice to the planner.
a AS (SELECT snapshot_at, program_units, non_program_units
        FROM site_inventory_snapshots WHERE site_id=(SELECT id FROM s)
         AND voided_at IS NULL
       ORDER BY snapshot_at DESC LIMIT 1),
inb AS (SELECT coalesce(sum(program_unit_count),0) p, coalesce(sum(non_program_unit_count),0) n
          FROM inbound_loads WHERE site_id=(SELECT id FROM s)
           AND status IN ('verified','submitted_to_mymrc','processed')
           -- <= now(): onHand windows lte asOf, so a bridged FUTURE delivery day
           -- (MRC marks ahead) must not inflate the floor shown for today.
           AND arrived_at >= '${ANCHOR_INSTANT}' AND arrived_at <= now()),
dr AS (SELECT coalesce(sum(units),0) u FROM consumer_dropoffs
        WHERE site_id=(SELECT id FROM s) AND dropoff_date > '${WINDOW_START}'),
st AS (SELECT coalesce(sum(stripped_program),0) p, coalesce(sum(stripped_non_program),0) n
         FROM processed_units_daily
        WHERE site_id=(SELECT id FROM s) AND production_date > '${WINDOW_START}'),
ob AS (SELECT coalesce(sum(program_units),0) p, coalesce(sum(non_program_units),0) n
         FROM outbound_materials WHERE site_id=(SELECT id FROM s)
           AND sub_category='renovation' AND ship_date > '${WINDOW_START}'),
lf AS (SELECT coalesce(sum(program_units),0) p, coalesce(sum(non_program_units),0) n
         FROM landfilled_units WHERE site_id=(SELECT id FROM s) AND disposal_date > '${WINDOW_START}')
SELECT a.snapshot_at AS anchor_at, a.program_units AS anchor_p, a.non_program_units AS anchor_n,
       inb.p AS inbound_p, dr.u AS dropoffs, st.p AS stripped_p,
       (a.program_units + inb.p + dr.u - st.p - ob.p - lf.p)                    AS floor_program,
       (a.non_program_units + inb.n - st.n - ob.n - lf.n)                       AS floor_non_program,
       (a.program_units + inb.p + dr.u - st.p - ob.p - lf.p)
     + (a.non_program_units + inb.n - st.n - ob.n - lf.n)                       AS floor_total
FROM a, inb, dr, st, ob, lf;
SQL
}

# Recovery plan: what the ADR-0059 bridge would aggregate for the window, with
# the same exclusions it enforces at write time (paper_bulk/ipad_floor-owned
# day slots; days holding VERIFIED per-load rows — ADR-0060 D5).
plan_sql() {
  cat <<SQL
WITH s AS (SELECT id FROM sites WHERE code='${SITE_CODE}'),
mirror AS (
  -- ADR-0089 Am.1: the delivery-day key is COALESCE(recycler delivery, appointment)
  -- — MUST match dist/mymrc.bridgeInboundHaulsToInventory or this plan lies.
  SELECT COALESCE(recycler_reported_delivery_date, docking_appointment_date)::date AS day,
         count(*) AS hauls,
         coalesce(sum(program_unit_count),0)     AS prog,
         coalesce(sum(non_program_unit_count),0) AS nonprog
    FROM mymrc_hauls_mirror
   WHERE status='Delivered' AND type='General'
     AND site_id=(SELECT id FROM s)
     AND COALESCE(recycler_reported_delivery_date, docking_appointment_date) >= '${WINDOW_START}'
   GROUP BY 1),
guards AS (
  SELECT (arrived_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
         bool_or(load_source_type IN ('paper_bulk','ipad_floor'))  AS slot_owned,
         bool_or(load_source_type NOT IN ('paper_bulk','mymrc_haul','ipad_floor')
                 AND status IN ('verified','submitted_to_mymrc','processed')) AS per_load_verified
    FROM inbound_loads
   WHERE site_id=(SELECT id FROM s) AND arrived_at >= '${ANCHOR_INSTANT}'
   GROUP BY 1)
SELECT m.day, m.hauls, m.prog, m.nonprog,
       CASE WHEN g.slot_owned        THEN 'SKIP: day owned by paper_bulk/ipad_floor'
            WHEN g.per_load_verified THEN 'SKIP: verified per-load rows (ADR-0060 D5)'
            ELSE 'bridge' END AS action
  FROM mirror m LEFT JOIN guards g USING (day)
 ORDER BY m.day;
SQL
}

recoverable_sql() {
  cat <<SQL
COPY (
WITH s AS (SELECT id FROM sites WHERE code='${SITE_CODE}'),
guards AS (
  SELECT (arrived_at AT TIME ZONE 'America/Los_Angeles')::date AS day,
         bool_or(load_source_type IN ('paper_bulk','ipad_floor'))  AS slot_owned,
         bool_or(load_source_type NOT IN ('paper_bulk','mymrc_haul','ipad_floor')
                 AND status IN ('verified','submitted_to_mymrc','processed')) AS per_load_verified
    FROM inbound_loads
   WHERE site_id=(SELECT id FROM s) AND arrived_at >= '${ANCHOR_INSTANT}'
   GROUP BY 1)
SELECT coalesce(sum(m.program_unit_count),0)
  FROM mymrc_hauls_mirror m
  LEFT JOIN guards g
    ON g.day = COALESCE(m.recycler_reported_delivery_date, m.docking_appointment_date)::date
 WHERE m.status='Delivered' AND m.type='General'
   AND m.site_id=(SELECT id FROM s)
   AND COALESCE(m.recycler_reported_delivery_date, m.docking_appointment_date) >= '${WINDOW_START}'
   AND coalesce(g.slot_owned,false)=false
   AND coalesce(g.per_load_verified,false)=false
) TO STDOUT;
SQL
}

verify_only() {
  echo '=== BLOCK 1: current floor (onHand replication) ==='
  floor_sql | "${PSQL[@]}"
  echo '=== BLOCK 2: inbound freshness (delivered vs confirmed) ==='
  "${PSQL[@]}" <<'SQL'
SELECT status, count(*), max(last_seen_at) AS max_last_seen,
       max(docking_appointment_date) AS max_appt
  FROM mymrc_hauls_mirror GROUP BY status ORDER BY status;
SQL
  echo '=== BLOCK 3: guard trap — whole-table max vs delivered-only max ==='
  "${PSQL[@]}" <<'SQL'
SELECT max(docking_appointment_date) AS whole_table_max,
       max(docking_appointment_date) FILTER (WHERE status='Delivered') AS delivered_only_max
  FROM mymrc_hauls_mirror;
SQL
  echo '=== BLOCK 4: completed_hauls backfill cursor ==='
  "${PSQL[@]}" <<'SQL'
SELECT object_api_name, list_view_api_name, last_page_index, records_completed,
       total_records_estimated, started_at, completed_at, left(coalesce(error,''),80) AS err
  FROM mymrc_backfill_cursors
 WHERE object_api_name='Haul_Request__c' ORDER BY updated_at DESC;
SQL
}

dry_run() {
  echo '=== RECOVERY PLAN (mirror → bridge aggregation, write-time guards applied) ==='
  plan_sql | "${PSQL[@]}"
  RECOVERABLE=$(recoverable_sql | "${PSQL[@]}" -q -t | tr -d '[:space:]')
  RECOVERABLE=${RECOVERABLE:-0}
  echo "=== recoverable program units in window: ${RECOVERABLE} (gate: >= ${GATE_MIN}) ==="
  if [ "$RECOVERABLE" -lt "$GATE_MIN" ]; then
    echo "FALSIFICATION GATE TRIPPED: ${RECOVERABLE} < ${GATE_MIN}."
    echo "The drained-cursor theory is falsified — the missing units are NOT sitting"
    echo "in the mirror waiting to be bridged; they were never recorded as Delivered"
    echo "upstream (MRC). This is upstream intake loss / delivery-marking lag: an"
    echo "operational chase (OPEN-ITEMS O-3), not a database write."
    return 1
  fi
  echo 'gate PASSED.'
}

apply() {
  if dry_run; then :
  elif [ "$ALLOW_PARTIAL" -eq 1 ]; then
    echo '--allow-partial: proceeding despite the gate (operator override).'
  else
    echo 'REFUSING to apply (use --allow-partial only once the upstream cause is understood).'
    exit 1
  fi
  echo '=== floor BEFORE ==='
  floor_sql | "${PSQL[@]}"
  echo '=== bridging window via dist/mymrc (audited, idempotent, precedence-guarded) ==='
  docker exec -e SITE_CODE="$SITE_CODE" -e SINCE="$WINDOW_START" "$APP_CONTAINER" node -e '
    const { PrismaClient } = require("@prisma/client");
    const mymrc = require("/app/dist/mymrc");
    (async () => {
      const prisma = new PrismaClient();
      try {
        const site = await prisma.site.findFirst({ where: { code: process.env.SITE_CODE }, select: { id: true } });
        if (!site) throw new Error("site not found: " + process.env.SITE_CODE);
        const res = await mymrc.bridgeInboundHaulsToInventory({
          prisma,
          siteIds: [site.id],
          sinceDeliveryDate: new Date(process.env.SINCE + "T00:00:00.000Z"),
          log: (l, m) => console.log(`[bridge:${l}] ${m}`),
        });
        console.log("bridge result:", JSON.stringify(res));
      } finally { await prisma.$disconnect().catch(() => undefined); }
    })().catch((e) => { console.error(e); process.exit(1); });
  '
  echo '=== floor AFTER ==='
  floor_sql | "${PSQL[@]}"
  echo 'Done. Expected ≈ +1,500 program if the full window recovered (handoff §2.2).'
}

rollback() {
  echo '=== bridge-owned rows that will be deleted ==='
  "${PSQL[@]}" <<SQL
SELECT id, arrived_at, total_units, program_unit_count, non_program_unit_count
  FROM inbound_loads
 WHERE site_id=(SELECT id FROM sites WHERE code='${SITE_CODE}')
   AND load_source_type='mymrc_haul' AND arrived_at >= '${ANCHOR_INSTANT}'
 ORDER BY arrived_at;
SQL
  read -r -p "Delete these rows? Type 'rollback' to confirm: " ans
  [ "$ans" = 'rollback' ] || { echo 'aborted.'; exit 1; }
  "${PSQL[@]}" <<SQL
BEGIN;
WITH del AS (
  DELETE FROM inbound_loads
   WHERE site_id=(SELECT id FROM sites WHERE code='${SITE_CODE}')
     AND load_source_type='mymrc_haul' AND arrived_at >= '${ANCHOR_INSTANT}'
   RETURNING id, arrived_at, total_units, program_unit_count, non_program_unit_count)
INSERT INTO audit_log (id, actor_label, action, table_name, row_id, before, after)
SELECT gen_random_uuid(), 'system:fix-woodland-inbound-rollback', 'delete',
       'inbound_loads', del.id, to_jsonb(del) - 'id', NULL
  FROM del;
COMMIT;
SQL
  echo 'Rolled back. NOTE: the hourly scrape re-bridges delivery days inside its'
  echo 'trailing 10-day window within the hour — correct the mirror first if the'
  echo 'rollback must stick.'
}

case "$MODE" in
  --verify-only) verify_only ;;
  --dry-run)     dry_run ;;
  --apply)       apply ;;
  --rollback)    rollback ;;
esac
