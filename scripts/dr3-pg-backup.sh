#!/usr/bin/env bash
# =============================================================================
# DR3-Vision — nightly pg_dump -> restic -> Cloudflare R2 (encrypted).
# Modeled on the fleet VLM pg-backup pattern (VLM ADR-0009). The dump holds
# bonus/payroll/PII, so it rides the ENCRYPTED restic backup; RESTIC_PASSWORD is
# the at-rest encryption key — it MUST live in 1Password, not only on this host
# (lose it and the backups are unrecoverable).
#
# Retention: 7 daily / 4 weekly / 12 monthly / 5 yearly.
#
# FAIL-LOUD (2026-07-21 audit P1-3): a missing/incomplete restic env now PAGES
# high and exits 1 — the previous fail-soft "log + exit 0" left the systemd
# timer green while backups silently stopped. A snapshot-age deadman after the
# push independently asserts the newest snapshot is < MAX_SNAPSHOT_AGE_H old.
# ntfy calls use the ADR-0036 flag contract (positional args were silently
# rejected with exit 2 by the flags-only helper — dead alerting for a month).
# =============================================================================
set -euo pipefail

RESTIC_ENV="${RESTIC_ENV:-$HOME/.dr3-vision-secrets/restic-dr3.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
PG_CONTAINER="${PG_CONTAINER:-dr3-vision-postgres}"
PG_DB="${PG_DB:-dr3_vision}"
PG_USER="${PG_USER:-dr3}"
STDIN_FILENAME="dr3_vision.dump"
NTFY_PUBLISH="${NTFY_PUBLISH:-$HOME/.local/bin/ntfy-publish.sh}"
# This job runs on the CHAD-HQ *host*, whose ~/.ntfy-token is the chad-hq-publisher
# identity — scoped to chad-hq-* (NOT dr3-vision-*). Publishing the ADR-0036-
# convention topic `dr3-vision-backup` from here 403s (verified 2026-07-21). We
# route to the host-scoped `chad-hq-backup` — the same topic the sibling host
# backup driver (~/backups/pg-backup.sh) already aggregates onto. To use the
# per-service `dr3-vision-backup` topic instead, place the dr3-vision-publisher
# token on the host and override NTFY_TOPIC.
NTFY_TOPIC="${NTFY_TOPIC:-chad-hq-backup}"
KEEP_DAILY=7; KEEP_WEEKLY=4; KEEP_MONTHLY=12; KEEP_YEARLY=5
MAX_SNAPSHOT_AGE_H="${MAX_SNAPSHOT_AGE_H:-26}"

log()  { echo "[dr3-pg-backup $(date -u +%FT%TZ)] $*"; }

# ntfy <title> <priority> — ADR-0036 flag contract. A publish failure must
# never mask the backup result, but it is logged instead of swallowed.
ntfy() {
  if [ -x "$NTFY_PUBLISH" ]; then
    "$NTFY_PUBLISH" --topic "$NTFY_TOPIC" \
      --title "$1" --priority "${2:-default}" \
      "host CHAD-HQ — journalctl -u dr3-pg-backup / ~/backups/pg-backup.log" \
      >/dev/null 2>&1 || log "WARN: ntfy publish failed (title: $1)"
  else
    log "WARN: ntfy helper missing at $NTFY_PUBLISH"
  fi
}

fail() { # fail <log-msg> <ntfy-title>
  log "$1"
  ntfy "$2" high
  exit 1
}

[ -r "$RESTIC_ENV" ] || fail "restic env $RESTIC_ENV missing/unreadable — backups CANNOT run" \
  "[DR3-Vision] backup FAILED — restic env missing"
# shellcheck source=/dev/null  (RESTIC_ENV is host-provided; path known only at runtime)
set -a; . "$RESTIC_ENV"; set +a

MISSING=()
for v in R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET RESTIC_PASSWORD; do
  [ -z "${!v:-}" ] && MISSING+=("$v")
done
[ "${#MISSING[@]}" -gt 0 ] && fail "R2 not configured (missing: ${MISSING[*]})" \
  "[DR3-Vision] backup FAILED — restic env incomplete (${MISSING[*]})"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RESTIC_REPOSITORY="s3:${R2_ENDPOINT%/}/${R2_BUCKET}/dr3-vision"
export RESTIC_PASSWORD

restic_run() {
  docker run --rm -i \
    -e RESTIC_REPOSITORY -e RESTIC_PASSWORD -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    "$RESTIC_IMAGE" "$@"
}

# 1. init (idempotent)
if ! OUT="$(restic_run init 2>&1)"; then
  if printf '%s' "$OUT" | grep -Eq 'already (exists|initialized)|config file already'; then
    log "restic repo already initialized (ok)"
  else
    log "restic init FAILED: $(printf '%s' "$OUT" | head -1)"
    fail "restic init failed" "[DR3-Vision] backup FAILED — restic init"
  fi
fi

# 2. pg_dump -Fc | restic backup --stdin  (custom format; pg_restore-able)
log "pg_dump $PG_DB | restic backup --stdin -> $RESTIC_REPOSITORY"
if ! docker exec "$PG_CONTAINER" pg_dump -Fc -U "$PG_USER" "$PG_DB" \
     | restic_run backup --stdin --stdin-filename "$STDIN_FILENAME" \
         --tag dr3-vision --tag "$(date -u +%F)" --host dr3-vision; then
  fail "restic backup FAILED" "[DR3-Vision] backup FAILED — dump/push"
fi
log "restic backup ok"

# 3. forget --prune
restic_run forget --prune \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY" --keep-yearly "$KEEP_YEARLY" \
  || { log "forget/prune failed (non-fatal — snapshot already pushed)"; ntfy "[DR3-Vision] backup prune failed" default; }

# 4. snapshot-age deadman — independently assert the newest snapshot is fresh.
# Catches every silent-skip path (env drift, wrong repo, clock issues): if the
# push above didn't actually land, this fails the run loudly.
LATEST_TIME="$(restic_run snapshots --host dr3-vision --latest 1 --json 2>/dev/null \
  | grep -o '"time":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$LATEST_TIME" ]; then
  fail "deadman: could not read latest snapshot time" "[DR3-Vision] backup FAILED — deadman cannot see snapshots"
fi
NOW_EPOCH="$(date -u +%s)"
SNAP_EPOCH="$(date -u -d "$LATEST_TIME" +%s 2>/dev/null || echo 0)"
AGE_H=$(( (NOW_EPOCH - SNAP_EPOCH) / 3600 ))
if [ "$SNAP_EPOCH" -eq 0 ] || [ "$AGE_H" -ge "$MAX_SNAPSHOT_AGE_H" ]; then
  fail "deadman: latest snapshot is ${AGE_H}h old (max ${MAX_SNAPSHOT_AGE_H}h)" \
    "[DR3-Vision] backup STALE — latest snapshot ${AGE_H}h old"
fi
log "deadman ok: latest snapshot ${AGE_H}h old"

ntfy "[DR3-Vision] PG backup OK" default
log "done"; exit 0
