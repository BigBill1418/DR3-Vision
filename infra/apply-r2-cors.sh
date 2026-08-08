#!/usr/bin/env bash
#
# Apply the checked-in R2 CORS policy for the DR3-Vision photo bucket.
#
# ## Why this file exists
#
# `load_photos` held ZERO rows from the day the photo feature shipped until
# 2026-08-07. The bucket had no CORS rule at all, so every browser upload died at
# the preflight — before any request reached the server, which is why nothing
# anywhere logged a failure and why one iPad quietly accumulated 97 unsent
# photos. A blocked preflight surfaces to JavaScript as an opaque `TypeError`,
# byte-identical to the one a genuinely offline device throws, so the queue
# classified it as "offline" and retried patiently for months.
#
# It was repaired by hand, through the Cloudflare API, from a shell that has
# since closed. THAT is the defect this script fixes: the configuration existed
# only as somebody's scrollback. ADR-0085 adds a second writer to the same bucket
# (walk-up drop-off photos), which makes "the bucket's CORS policy is whatever it
# currently happens to be" an unacceptable answer — a bucket reset, a migration,
# or a new bucket for a third site would silently reproduce the original outage
# on two features instead of one.
#
# The policy now lives in `infra/r2-cors.dr3-vision-photos.json`, in git, and
# this script applies it. Idempotent by construction: `PutBucketCors` REPLACES
# the whole configuration, so running it twice is indistinguishable from running
# it once, and running it after a hand-edit restores the declared state.
#
# ## Env contract — NO TOKEN IS EMBEDDED HERE
#
# Required:
#   R2_ACCOUNT_ID   Cloudflare account id.
#   R2_BUCKET       Bucket name (default: dr3-vision-photos).
#
# Exactly one credential path, in this order of preference:
#
#   1. S3 credentials — R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY.
#      Already provisioned on the app hosts at `~/.dr3-vision-secrets/r2.env`,
#      which is the same file `src/lib/r2.ts` reads. Preferred: it is the least
#      privileged thing that can do this job.
#
#   2. CF_ACCOUNT_TOKEN — a Cloudflare ACCOUNT-scoped API token (`cfat_…`) with
#      R2 admin. Fleet convention: this is `integrations.cloudflare.account_token`
#      in `noc-master/data/config.yml`. It is NOT the same credential as
#      `integrations.cloudflare.api_token` (`cfut_…`), which is zone-scoped and
#      returns 403 on every R2 admin call — a distinction that has cost time
#      before on this fleet.
#
# Per the fleet git-credential convention, no token is read from a repo file and
# none is written to one. Pass it in the environment:
#
#   R2_ACCOUNT_ID=… CF_ACCOUNT_TOKEN=$(…) ./infra/apply-r2-cors.sh
#   # or, on an app host:
#   set -a; . ~/.dr3-vision-secrets/r2.env; set +a; ./infra/apply-r2-cors.sh
#
# `--check` prints the LIVE policy and diffs it against the declared one without
# writing anything. Use it before assuming the bucket is configured — "it worked
# last month" is exactly the belief that hid the original outage.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY="${HERE}/r2-cors.dr3-vision-photos.json"
BUCKET="${R2_BUCKET:-dr3-vision-photos}"
MODE="${1:-apply}"

die() { printf 'apply-r2-cors: %s\n' "$*" >&2; exit 1; }

[ -f "$POLICY" ] || die "policy file not found: $POLICY"
[ -n "${R2_ACCOUNT_ID:-}" ] || die 'R2_ACCOUNT_ID is required (see the env contract in this file)'

ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

# ── Path 1: S3 credentials via aws-cli ──────────────────────────────────────
if [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
  command -v aws >/dev/null 2>&1 || die 'aws cli not found (needed for the S3 credential path)'
  export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
  export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
  export AWS_DEFAULT_REGION=auto

  if [ "$MODE" = '--check' ]; then
    echo "live CORS for ${BUCKET}:"
    # A bucket with NO rule 404s here rather than returning an empty list. That
    # is the exact state the 2026-08-07 outage was in, so it is reported as a
    # finding and not as an error.
    aws s3api get-bucket-cors --endpoint-url "$ENDPOINT" --bucket "$BUCKET" \
      || echo '  (no CORS configuration on this bucket — uploads WILL fail at the preflight)'
    echo "declared:"
    cat "$POLICY"
    exit 0
  fi

  aws s3api put-bucket-cors \
    --endpoint-url "$ENDPOINT" \
    --bucket "$BUCKET" \
    --cors-configuration "{\"CORSRules\": $(cat "$POLICY")}"
  echo "applied ${POLICY} to ${BUCKET}"
  exit 0
fi

# ── Path 2: Cloudflare account token via the REST API ───────────────────────
[ -n "${CF_ACCOUNT_TOKEN:-}" ] || die \
  'no credential: set R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_TOKEN'
command -v curl >/dev/null 2>&1 || die 'curl not found'

API="https://api.cloudflare.com/client/v4/accounts/${R2_ACCOUNT_ID}/r2/buckets/${BUCKET}/cors"

if [ "$MODE" = '--check' ]; then
  curl -sS -X GET "$API" -H "Authorization: Bearer ${CF_ACCOUNT_TOKEN}"
  echo
  echo "declared:"
  cat "$POLICY"
  exit 0
fi

# The REST shape wraps the same rules under `rules`. Kept in ONE file rather than
# two so the two credential paths can never drift into applying different
# policies — which would make "the bucket is configured" depend on which machine
# ran the script.
BODY="$(printf '{"rules": %s}' "$(cat "$POLICY")")"
RESP="$(curl -sS -X PUT "$API" \
  -H "Authorization: Bearer ${CF_ACCOUNT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data "$BODY")"

# `curl` exits 0 on an HTTP 4xx with a JSON error body, so the exit code is not
# evidence. Check what Cloudflare actually said.
case "$RESP" in
  *'"success":true'*) echo "applied ${POLICY} to ${BUCKET}" ;;
  *) die "Cloudflare refused the CORS update: ${RESP}" ;;
esac
