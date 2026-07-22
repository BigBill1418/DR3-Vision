#!/usr/bin/env bash
# DR3-Vision quarterly RESTORE DRILL — proves the OFF-HOST backup leg is actually
# restorable, not merely present. Pulls the newest dr3-vision dump from the
# dedicated encrypted restic repo in Cloudflare R2 (the copy that matters in a
# real disaster — see scripts/dr3-pg-backup.sh), restores it into a throwaway
# database on the live Postgres container, sanity-checks row counts against the
# live database, then drops the throwaway DB.
#
# Modeled EXACTLY on the proven DroneOps template (droneops/scripts/restore-drill.sh),
# adapted from aws-cli/gzip to the DR3-Vision restic/R2 lane.
#
# Scheduled by systemd (dr3-vision-restore-drill.timer, quarterly on the 16th of
# Jan/Apr/Jul/Oct at 18:13 UTC, Persistent=true). Unit files live in
# scripts/systemd/; install with:
#   sudo cp scripts/systemd/dr3-vision-restore-drill.{service,timer} /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now dr3-vision-restore-drill.timer
#
# On FULL success writes the node-exporter textfile metric
# dr3_vision_restore_drill_last_success_timestamp_seconds; a Grafana staleness
# rule can then page (infrawatch-alerts) if the drill hasn't succeeded in >100
# days or the metric is absent — so a silently-dead timer cannot recreate the
# "someone has to remember quarterly" gap. ntfy is FAILURE-ONLY (ADR-0037): a
# healthy quarterly drill is silent; any failure publishes `high` and exits 1.
set -euo pipefail

PG_CONTAINER="${DR3_PG_CONTAINER:-dr3-vision-postgres}"
DRILL_DB="dr3_vision_restore_drill"     # NEVER derived from input — cleanup guard relies on this being constant
LIVE_DB="${DR3_DB_NAME:-dr3_vision}"
DB_USER="${DR3_DB_USER:-dr3}"

RESTIC_ENV="${RESTIC_ENV:-${HOME}/.dr3-vision-secrets/restic-dr3.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
RESTIC_IMAGE_FALLBACK="${RESTIC_IMAGE_FALLBACK:-restic/restic:latest}"
DUMP_PATH_IN_SNAPSHOT="/dr3_vision.dump"

NTFY_TOPIC="${NTFY_TOPIC:-infrawatch-alerts}"
NTFY_HELPER="${NTFY_HELPER:-${HOME}/.local/bin/ntfy-publish.sh}"
NTFY_CLICK="${NTFY_CLICK:-https://noc-mastercontrol.barnardhq.com/status/dr3-vision}"

TEXTFILE_DIR="${TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
TEXTFILE_METRIC="dr3_vision_restore_drill_last_success_timestamp_seconds"
TEXTFILE_PATH="${TEXTFILE_DIR}/dr3_vision_restore_drill.prom"

# The largest live table must restore to at least this fraction of its live count.
# The dump is nightly so it can trail live slightly, but a near-empty restore that
# "succeeds" is exactly the failure mode this drill exists to catch.
MIN_LARGEST_RATIO_PCT=90
# Largest live table (audit_log) drives the ratio gate; these must all be non-empty.
KEY_TABLES=(audit_log bonus_daily_entries bonus_employees)
LARGEST_TABLE="audit_log"

fail() {
  local msg="$1"
  echo "[restore-drill] FAIL: ${msg}" >&2
  if [[ -x "${NTFY_HELPER}" ]]; then
    "${NTFY_HELPER}" --topic "${NTFY_TOPIC}" --priority high \
      --title "[DR3-Vision] quarterly restore drill FAILED" \
      --tags "backup,error" --dedup-key dr3-vision-restore-drill --cooldown 21600 \
      --click "${NTFY_CLICK}" -- "restore-drill.sh failed: ${msg}" || true
  fi
  exit 1
}

cleanup() {
  # Best-effort: never leave the scratch DB behind, even on failure paths.
  # Guard: only ever the exact constant scratch name is dropped.
  docker exec "${PG_CONTAINER}" psql -U "${DB_USER}" -d "${LIVE_DB}" -qAtc \
    "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

emit_freshness_metric() {
  local now tmp
  now="$(date -u +%s)"
  if ! tmp="$(mktemp "${TEXTFILE_DIR}/.dr3_vision_restore_drill.prom.XXXXXX" 2>/dev/null)"; then
    echo "[restore-drill] WARN: could not create temp file in ${TEXTFILE_DIR}; freshness metric not updated" >&2
    return 0
  fi
  {
    echo "# HELP ${TEXTFILE_METRIC} Unix epoch of the last successful dr3-vision R2 restore drill."
    echo "# TYPE ${TEXTFILE_METRIC} gauge"
    echo "${TEXTFILE_METRIC} ${now}"
  } > "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
  chmod 0644 "${tmp}" 2>/dev/null || true
  mv -f "${tmp}" "${TEXTFILE_PATH}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
  echo "[restore-drill] freshness metric updated: ${TEXTFILE_METRIC}=${now}"
}

docker ps --format '{{.Names}}' | grep -qx "${PG_CONTAINER}" \
  || fail "container ${PG_CONTAINER} is not running"

# --- 1. Source restic creds, build repository -------------------------------
[[ -r "${RESTIC_ENV}" ]] || fail "restic env file not readable: ${RESTIC_ENV}"
set -a; # shellcheck disable=SC1090
source "${RESTIC_ENV}"; set +a
: "${R2_ENDPOINT:?R2_ENDPOINT unset}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID unset}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY unset}"
: "${R2_BUCKET:?R2_BUCKET unset}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD unset}"

export AWS_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID}"
export AWS_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY}"
export RESTIC_REPOSITORY="s3:${R2_ENDPOINT%/}/${R2_BUCKET}/dr3-vision"
export RESTIC_PASSWORD

RESTIC_TAG="restic/restic:0.17.3"   # image actually used, for reporting
restic_run() {
  docker run --rm -i \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    "${RESTIC_IMAGE}" "$@"
}

# --- 2. Locate the newest snapshot, enforce the 48h freshness gate ----------
SNAP_JSON="$(restic_run snapshots --tag dr3-vision --latest 1 --json 2>/dev/null || true)"
if [[ -z "${SNAP_JSON}" || "${SNAP_JSON}" == "[]" ]]; then
  # Fallback: repo format may be newer than 0.17.3 can read; retry on :latest.
  echo "[restore-drill] WARN: 0.17.3 returned no snapshots; retrying on ${RESTIC_IMAGE_FALLBACK}" >&2
  RESTIC_IMAGE="${RESTIC_IMAGE_FALLBACK}"; RESTIC_TAG="${RESTIC_IMAGE_FALLBACK} (fallback: 0.17.3 could not read repo)"
  SNAP_JSON="$(restic_run snapshots --tag dr3-vision --latest 1 --json 2>/dev/null || true)"
fi
[[ -n "${SNAP_JSON}" && "${SNAP_JSON}" != "[]" ]] || fail "no dr3-vision snapshots found in ${RESTIC_REPOSITORY}"

SNAP_ID="$(printf '%s' "${SNAP_JSON}" | grep -o '"id":"[a-f0-9]*"' | head -1 | cut -d'"' -f4)"
SNAP_TIME="$(printf '%s' "${SNAP_JSON}" | grep -o '"time":"[^"]*"' | head -1 | cut -d'"' -f4)"
[[ -n "${SNAP_ID}" && -n "${SNAP_TIME}" ]] || fail "could not parse newest snapshot id/time from restic output"

SNAP_EPOCH="$(date -u -d "${SNAP_TIME}" +%s 2>/dev/null || echo 0)"
AGE_H=$(( ( $(date -u +%s) - SNAP_EPOCH ) / 3600 ))
[[ "${SNAP_EPOCH}" -gt 0 && "${AGE_H}" -lt 48 ]] \
  || fail "newest dr3-vision snapshot is ${AGE_H}h old (>48h) — nightly off-host push is broken"
echo "[restore-drill] $(date -u +%FT%TZ) newest snapshot: ${SNAP_ID:0:8} (${SNAP_TIME}, ${AGE_H}h old)"

# --- 3. Restore into a throwaway database -----------------------------------
docker exec "${PG_CONTAINER}" psql -U "${DB_USER}" -d "${LIVE_DB}" -qAtc \
  "DROP DATABASE IF EXISTS ${DRILL_DB} WITH (FORCE)" >/dev/null
docker exec "${PG_CONTAINER}" psql -U "${DB_USER}" -d "${LIVE_DB}" -qAtc \
  "CREATE DATABASE ${DRILL_DB}" >/dev/null

echo "[restore-drill] restoring ${DUMP_PATH_IN_SNAPSHOT} from ${SNAP_ID:0:8} into ${DRILL_DB}"
# restic dump streams the pg_dump -Fc archive to stdout -> pg_restore stdin.
# pg_restore exits non-zero on ignorable warnings (missing role/owner), so it is
# NOT a hard gate; the row-count checks below are. A restic-side failure IS fatal
# and is caught via PIPESTATUS[0].
set +e
restic_run dump "${SNAP_ID}" "${DUMP_PATH_IN_SNAPSHOT}" \
  | docker exec -i "${PG_CONTAINER}" pg_restore -U "${DB_USER}" -d "${DRILL_DB}" --no-owner
PIPES=("${PIPESTATUS[@]}")
set -e
RESTIC_RC="${PIPES[0]}"; PGR_RC="${PIPES[1]}"
[[ "${RESTIC_RC}" -eq 0 ]] || fail "restic dump of snapshot ${SNAP_ID:0:8} failed (rc=${RESTIC_RC})"
[[ "${PGR_RC}" -eq 0 ]] || echo "[restore-drill] note: pg_restore exited ${PGR_RC} (ignorable warnings); gating on row counts"

# --- 4. Sanity-check restored data vs live ----------------------------------
count() { # count <db> <table>
  docker exec "${PG_CONTAINER}" psql -U "${DB_USER}" -d "$1" -qAtc "SELECT count(*) FROM $2"
}
REPORT=""
for t in "${KEY_TABLES[@]}"; do
  n="$(count "${DRILL_DB}" "${t}")" || fail "table ${t} missing in restored DB"
  [[ "${n}" -gt 0 ]] || fail "restored table ${t} is empty"
  REPORT="${REPORT}${t}=${n} "
done

DRILL_LARGEST="$(count "${DRILL_DB}" "${LARGEST_TABLE}")" || fail "largest table ${LARGEST_TABLE} missing in restored DB"
LIVE_LARGEST="$(count "${LIVE_DB}" "${LARGEST_TABLE}")"   || fail "largest table ${LARGEST_TABLE} missing in live DB"
[[ "${LIVE_LARGEST}" -gt 0 ]] || fail "live ${LARGEST_TABLE} count is 0 — cannot compute ratio"
[[ $(( DRILL_LARGEST * 100 )) -ge $(( LIVE_LARGEST * MIN_LARGEST_RATIO_PCT )) ]] \
  || fail "restored ${LARGEST_TABLE}=${DRILL_LARGEST} < ${MIN_LARGEST_RATIO_PCT}% of live=${LIVE_LARGEST}"

echo "[restore-drill] verified: ${REPORT}${LARGEST_TABLE}=${DRILL_LARGEST}/${LIVE_LARGEST} (>=${MIN_LARGEST_RATIO_PCT}%) [image=${RESTIC_TAG}]"

# --- 5. Success: stamp metric (cleanup trap drops the scratch DB) ------------
emit_freshness_metric
echo "[restore-drill] done. snapshot=${SNAP_ID:0:8} ${LARGEST_TABLE}=${DRILL_LARGEST}/${LIVE_LARGEST} age=${AGE_H}h"
