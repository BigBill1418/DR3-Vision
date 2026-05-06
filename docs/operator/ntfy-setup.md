# ntfy setup — DR3-Vision system-level alerts

Per ADR-0036 (transport) + ADR-0037 (noise reduction policy) + the
DR3-Vision CLAUDE.md hard rule #5, this app publishes only **system-level
events** to ntfy:

- Container started (`dr3-vision-container`)
- Migration applied (`dr3-vision-system`)
- Unhandled error (`dr3-vision-system`)

Operational events — load rejections, long unloads, SLA breaches, PIN
lockouts — are in-app dashboard signals only. They never reach Bill's
phone. Do not add new ntfy publish call sites for those classes; route
them to Grafana or the `/admin/audit` view instead.

The wiring is **fail-soft**: when `NTFY_PUBLISHER_TOKEN` is unset, every
call resolves to a successful no-op and the app continues serving. That
means the steps below can be deferred without impact, but until they're
done Bill won't get notified about boots, migrations, or crashes.

This is a one-time setup per fleet host.

## 1. Look up the publisher token

The `dr3-vision-publisher` token was minted at fleet bootstrap and is
stored on HSH-HQ.

```bash
ssh 10.99.0.1
sudo grep -A3 'dr3-vision-publisher' /root/.ntfy-bootstrap-secrets.txt
```

The relevant row is:

```
service:        dr3-vision
user:           dr3-vision-publisher
token:          tk_…………………………………………
acl:            dr3-vision-* rw
```

Copy the `tk_…` value verbatim. It does NOT roundtrip through any other
file on disk; if the bootstrap secrets file is ever rotated, the token
must be reissued via `docker exec ntfy ntfy token add` on the BOS-HQ
ntfy container per the fleet ntfy cookbook.

## 2. Drop the env_file on CHAD-HQ

```bash
ssh 10.99.0.2
mkdir -p ~/.dr3-vision-secrets
tee ~/.dr3-vision-secrets/ntfy.env <<'EOF'
# DR3-Vision — system-level ntfy publisher (ADR-0036 + ADR-0037)
# This file is sourced by both `app` and `migrate` services in
# docker-compose.yml. The `app` service uses it for boot + unhandled-
# error alerts; the `migrate` service uses it for "Migration applied"
# alerts.
NTFY_BASE_URL=https://ntfy.barnardhq.com
NTFY_TOPIC_SYSTEM=dr3-vision-system
NTFY_TOPIC_CONTAINER=dr3-vision-container
NTFY_PUBLISHER_TOKEN=<paste tk_… token from §1>
EOF
chmod 600 ~/.dr3-vision-secrets/ntfy.env
```

Mode 600 is non-negotiable. The file holds a Bearer token with `rw` on
every `dr3-vision-*` topic; a leaked token lets anyone publish into the
operator's phone.

## 3. Recreate the container

A plain `docker compose restart` will NOT pick up the new env_file —
Compose bakes env_file values into the container at create time, so a
stop/start cycle keeps the old (empty) env. Use `up -d --force-recreate`
instead (same lesson as the Entra ID setup, §5):

```bash
cd /home/bbarnard065/DR3-Vision
docker compose up -d --force-recreate --no-deps app
```

Within 10–30 s of recreate, you should see `[DR3-Vision] Container
started` arrive on your `dr3-vision-container` subscription. If you
don't, see Troubleshooting below.

## 4. Verify

```bash
docker exec dr3-vision-app env | grep ^NTFY_
```

Expect four lines:

```
NTFY_BASE_URL=https://ntfy.barnardhq.com
NTFY_TOPIC_SYSTEM=dr3-vision-system
NTFY_TOPIC_CONTAINER=dr3-vision-container
NTFY_PUBLISHER_TOKEN=tk_xxxxxxxxxxxxxxxxxxxx
```

If `NTFY_PUBLISHER_TOKEN` is empty, the `ntfy.env` file isn't being
sourced — recheck §2 and re-run §3.

To force a second boot publish (cooldown is 30 min, so you may need to
wait or use a different fingerprint):

```bash
docker compose up -d --force-recreate --no-deps app
sleep 5
docker logs dr3-vision-app 2>&1 | head -20
```

Look for the absence of `ntfy skipped — not configured` debug lines.
Successful publish is silent at info level; the no-op path emits a
debug line.

## 5. Rotation

When the publisher token rotates (annual cadence per fleet policy):

1. Mint a new `dr3-vision-publisher` token on the BOS-HQ ntfy container.
2. Update `NTFY_PUBLISHER_TOKEN` in `~/.dr3-vision-secrets/ntfy.env` on
   CHAD-HQ.
3. Recreate both services that use the env_file:

   ```bash
   docker compose up -d --force-recreate --no-deps app migrate
   ```

   The migrate service exits immediately (one-shot) and won't actually
   re-run unless there are pending migrations — recreating it is just to
   clear the env-file cache for the next deploy.
4. Revoke the old token on the BOS-HQ ntfy container.

There's no overlap window required — both old and new tokens are valid
on the ntfy server until the old one is explicitly revoked, so this is
zero-downtime.

## Troubleshooting

### No notification on boot

1. Confirm the env_file dropped successfully (§4).
2. Confirm the container actually recreated, not just restarted:
   `docker ps --format '{{.Names}}\t{{.Status}}' | grep dr3-vision-app`
   should show `Up <minutes>` consistent with your recreate time.
3. Check the ntfy server is reachable from inside the container:
   `docker exec dr3-vision-app node -e "fetch('https://ntfy.barnardhq.com/v1/health').then(r => console.log(r.status))"`
   should print `200`.
4. If everything else is fine, the cooldown ledger may have caught your
   second recreate (`dr3-vision-container-start` fingerprint, 30-min
   window). Wait 30 minutes or recreate at a later time.

### Notification arrives but click-through 404s

The `/status/dr3-vision` route is served by NOC Master Control at
`https://noc-mastercontrol.barnardhq.com/status/dr3-vision` (NOT
`noc.barnardhq.com` — that's InfraWatch's display surface). If the
notification's click URL points at the wrong hostname, your subscription
config has a stale URL — delete and re-add it from the URL emitted by
the publish helper.

### Notification flood after a deploy

Per ADR-0037, container-start is fingerprinted with a 30-min cooldown
and unhandled errors are fingerprinted by error class + first stack
frame with a 30-min cooldown. If you're seeing more than one of the
same alert in a 30-minute window, either:

- The error class is genuinely rotating (different stack frames each
  time → different fingerprints → different cooldowns), in which case
  the alerts are correct and the underlying bug is real.
- The container is being killed and recreated by Compose's healthcheck
  retry (which can happen during a flaky deploy). Check
  `docker logs dr3-vision-app` for the actual error and address that.

If you ever need to silence a noisy alert, the only correct path is to
revisit the publish call site (or the cooldown window) — never to
hand-edit the ntfy server's ACL.
