#!/usr/bin/env bash
# =============================================================================
# DR3-Vision — nightly pg_dump -> restic -> Cloudflare R2 (encrypted).
# Modeled on the fleet VLM pg-backup pattern (VLM ADR-0009). The dump holds
# bonus/payroll/PII, so it rides the ENCRYPTED restic backup; RESTIC_PASSWORD is
# the at-rest encryption key — it MUST live in 1Password, not only on this host
# (lose it and the backups are unrecoverable).
#
# Retention: 7 daily / 4 weekly / 12 monthly / 5 yearly.
# Fail-soft: if the restic env is absent/incomplete, log + exit 0 (timer stays
# clean) rather than failing.
# =============================================================================
set -euo pipefail

RESTIC_ENV="${RESTIC_ENV:-$HOME/.dr3-vision-secrets/restic-dr3.env}"
RESTIC_IMAGE="${RESTIC_IMAGE:-restic/restic:0.17.3}"
PG_CONTAINER="${PG_CONTAINER:-dr3-vision-postgres}"
PG_DB="${PG_DB:-dr3_vision}"
PG_USER="${PG_USER:-dr3}"
STDIN_FILENAME="dr3_vision.dump"
NTFY_PUBLISH="${NTFY_PUBLISH:-$HOME/.local/bin/ntfy-publish.sh}"
NTFY_TOPIC="dr3-vision-backup"
KEEP_DAILY=7; KEEP_WEEKLY=4; KEEP_MONTHLY=12; KEEP_YEARLY=5

log()  { echo "[dr3-pg-backup $(date -u +%FT%TZ)] $*"; }
ntfy() { [ -x "$NTFY_PUBLISH" ] && "$NTFY_PUBLISH" "$NTFY_TOPIC" "$1" "${2:-default}" >/dev/null 2>&1 || true; }

[ -r "$RESTIC_ENV" ] || { log "restic env $RESTIC_ENV missing — skipping (non-fatal)"; exit 0; }
set -a; . "$RESTIC_ENV"; set +a

MISSING=()
for v in R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET RESTIC_PASSWORD; do
  [ -z "${!v:-}" ] && MISSING+=("$v")
done
[ "${#MISSING[@]}" -gt 0 ] && { log "R2 not configured (missing: ${MISSING[*]}) — skipping"; exit 0; }

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
    log "restic init FAILED: $(printf '%s' "$OUT" | head -1)"; ntfy "[DR3-Vision] backup FAILED — restic init" high; exit 1
  fi
fi

# 2. pg_dump -Fc | restic backup --stdin  (custom format; pg_restore-able)
log "pg_dump $PG_DB | restic backup --stdin -> $RESTIC_REPOSITORY"
if ! docker exec "$PG_CONTAINER" pg_dump -Fc -U "$PG_USER" "$PG_DB" \
     | restic_run backup --stdin --stdin-filename "$STDIN_FILENAME" \
         --tag dr3-vision --tag "$(date -u +%F)" --host dr3-vision; then
  log "restic backup FAILED"; ntfy "[DR3-Vision] backup FAILED — dump/push" high; exit 1
fi
log "restic backup ok"

# 3. forget --prune
restic_run forget --prune \
  --keep-daily "$KEEP_DAILY" --keep-weekly "$KEEP_WEEKLY" \
  --keep-monthly "$KEEP_MONTHLY" --keep-yearly "$KEEP_YEARLY" \
  || { log "forget/prune failed (non-fatal — snapshot already pushed)"; ntfy "[DR3-Vision] backup prune failed" default; }

ntfy "[DR3-Vision] PG backup OK" default
log "done"; exit 0
