#!/usr/bin/env bash
# send-svdp-mail.sh — Send a Vision (SVdP) email FROM dr3-vision@svdp.us via
# Microsoft Graph, reusing the running dr3-vision-app container's Entra app
# credentials (the same identity the monthly payroll PDF mailer uses).
#
# WHY THIS EXISTS: DR3-Vision is the Society of St. Vincent de Paul — a SEPARATE
# org from BarnardHQ. Vision correspondence must originate from an @svdp.us
# identity, never a BarnardHQ one. This is the sanctioned channel for ad-hoc
# Vision mail (the in-app sendSystemEmail has no CC field). Do NOT use the
# operator's personal msmtp/Brevo for Vision mail.
#
# Usage:
#   send-svdp-mail.sh --to a@svdp.us [--cc b@svdp.us] --subject "Subject" --html body.html
#
# Credentials are read from the running app container (override by exporting
# AUTH_MICROSOFT_ENTRA_ID_TENANT_ID / _ID / _SECRET and M365_MAIL_FROM_ADDRESS).
# Container name override: SVDP_MAIL_CONTAINER (default dr3-vision-app).
set -euo pipefail

TO=""; CC=""; SUBJECT=""; HTML_FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --to) TO="$2"; shift 2;;
    --cc) CC="$2"; shift 2;;
    --subject) SUBJECT="$2"; shift 2;;
    --html) HTML_FILE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$TO" ] && [ -n "$SUBJECT" ] && [ -n "$HTML_FILE" ] || { echo "usage: --to <addr> [--cc <addr>] --subject <s> --html <file>" >&2; exit 2; }
[ -f "$HTML_FILE" ] || { echo "html file not found: $HTML_FILE" >&2; exit 2; }

CTR="${SVDP_MAIL_CONTAINER:-dr3-vision-app}"
TENANT="${AUTH_MICROSOFT_ENTRA_ID_TENANT_ID:-$(docker exec "$CTR" printenv AUTH_MICROSOFT_ENTRA_ID_TENANT_ID)}"
CLIENT="${AUTH_MICROSOFT_ENTRA_ID_ID:-$(docker exec "$CTR" printenv AUTH_MICROSOFT_ENTRA_ID_ID)}"
SECRET="${AUTH_MICROSOFT_ENTRA_ID_SECRET:-$(docker exec "$CTR" printenv AUTH_MICROSOFT_ENTRA_ID_SECRET)}"
FROM="${M365_MAIL_FROM_ADDRESS:-$(docker exec "$CTR" printenv M365_MAIL_FROM_ADDRESS)}"
[ -n "$TENANT" ] && [ -n "$CLIENT" ] && [ -n "$SECRET" ] && [ -n "$FROM" ] || { echo "M365 credentials unavailable (is $CTR running?)" >&2; exit 3; }

# 1) Token via client_credentials. Secret flows through a bash-builtin printf
#    (no separate process) into curl --data @- so it never appears in argv/ps.
TOKEN=$(printf 'client_id=%s&client_secret=%s&scope=%s&grant_type=client_credentials' \
  "$CLIENT" "$SECRET" 'https://graph.microsoft.com/.default' \
  | curl -fsS -X POST "https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token" \
      -H 'Content-Type: application/x-www-form-urlencoded' --data @- \
  | jq -r '.access_token // empty')
[ -n "$TOKEN" ] || { echo "token request failed" >&2; exit 4; }

# 2) Build payload — jq --rawfile safely JSON-escapes the HTML body.
CC_JSON='[]'
[ -n "$CC" ] && CC_JSON=$(jq -nc --arg a "$CC" '[{emailAddress:{address:$a}}]')
PAYLOAD=$(jq -nc --arg subj "$SUBJECT" --arg to "$TO" --rawfile body "$HTML_FILE" --argjson cc "$CC_JSON" \
  '{message:{subject:$subj, body:{contentType:"HTML", content:$body},
     toRecipients:[{emailAddress:{address:$to}}], ccRecipients:$cc}, saveToSentItems:true}')

# 3) Send.
RESP=/tmp/svdp-mail-resp.$$.txt
HTTP=$(printf '%s' "$PAYLOAD" | curl -sS -o "$RESP" -w '%{http_code}' -X POST \
  "https://graph.microsoft.com/v1.0/users/${FROM}/sendMail" \
  -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' --data-binary @-)
if [ "$HTTP" = "202" ]; then
  echo "SENT from ${FROM} -> to ${TO}${CC:+ , cc ${CC}}  (HTTP 202)"
  rm -f "$RESP"
else
  echo "SEND FAILED (HTTP ${HTTP}) from ${FROM} -> ${TO}:" >&2
  cat "$RESP" >&2; rm -f "$RESP"; exit 5
fi
