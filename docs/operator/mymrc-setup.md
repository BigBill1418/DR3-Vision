# MyMRC scrape setup — DR3-Vision operator runbook

Per ADR-0009, DR3-Vision pulls scheduled hauls from MyMRC by browser
automation (Playwright) — there is no API path until MRC enables one.
The `mymrc-scrape` cron container in `docker-compose.yml` runs a scrape
once on boot and once at the top of every UTC hour. Each tick logs into
both MyMRC accounts (Eugene + Woodland), extracts the next 7 days of
scheduled hauls, and upserts them into the `expected_loads` table. The
operator iPad queue (T-005) reflects new hauls within an hour of MRC
scheduling them.

The wiring is **fail-soft**: when neither
`MYMRC_EUGENE_USERNAME`/`MYMRC_EUGENE_PASSWORD` nor
`MYMRC_WOODLAND_USERNAME`/`MYMRC_WOODLAND_PASSWORD` are set, the worker
logs `creds not configured, skipping` for each tick and exits 0. No
ntfy alert fires — that's an operator state, not a system failure.
Until the credentials below are dropped, the operator queue is empty
(or shows only manually-created loads) but nothing breaks.

This is a one-time setup per fleet host.

## 1. Credentials

The DR3 service accounts on MyMRC are managed by Bill / SVdP. They are
**SVdP service accounts**, not personal accounts — never paste your
own MyMRC login here. Two distinct accounts:

- **Eugene (Oregon program)** — administered by MRC Oregon LLC.
- **Woodland (California program)** — administered by MRC California LLC.

If you don't have both pairs of credentials yet, ask Bill. Until both
are dropped, the corresponding site's scrape is a fail-soft no-op.

## 2. Drop the env_file on CHAD-HQ

```bash
ssh 10.99.0.2
mkdir -p ~/.dr3-vision-secrets
tee ~/.dr3-vision-secrets/mymrc.env <<'EOF'
# DR3-Vision — MyMRC scrape credentials (T-015 / ADR-0009)
# Sourced by the `mymrc-scrape` service in docker-compose.yml.
# The legacy MYMRC_OR_* / MYMRC_CA_* names are also accepted for
# compatibility with `docs/MYMRC-INTEGRATION.md`.

# Eugene (Oregon) — DR3 service account
MYMRC_EUGENE_USERNAME=<eugene service account email>
MYMRC_EUGENE_PASSWORD=<eugene service account password>

# Woodland (California) — DR3 service account
MYMRC_WOODLAND_USERNAME=<woodland service account email>
MYMRC_WOODLAND_PASSWORD=<woodland service account password>
EOF
chmod 600 ~/.dr3-vision-secrets/mymrc.env
```

Mode 600 is non-negotiable. The file holds two production
service-account passwords; a leaked file gives full read/write on the
DR3 MyMRC tenant for both jurisdictions.

**No trailing slash, no extra whitespace** on the values — env_file
parsing preserves trailing whitespace into the password literally,
which MyMRC's login form will then reject. Same lesson as the Entra
ID setup (`docs/operator/entra-id-setup.md` §2 issuer note): MyMRC
returns "Invalid username or password" with no further detail when
the password has a stray space appended.

## 3. Recreate the cron container

A plain `docker compose restart` will NOT pick up the new env_file —
Compose bakes env_file values into the container at create time, so a
stop/start cycle keeps the old (empty) env. Use
`up -d --force-recreate` instead (same lesson as the Entra and ntfy
setups):

```bash
cd /home/bbarnard065/DR3-Vision
docker compose up -d --force-recreate --no-deps mymrc-scrape
```

Within ~5 s the cron host logs `cron host started`, then within
another ~10 s the boot scrape begins. Watch live:

```bash
docker logs -f dr3-vision-mymrc-scrape
```

You should see (per site, sequentially):

```
[mymrc-cron 2026-05-06T23:45:01.000Z] cron host started
[mymrc-cron 2026-05-06T23:45:06.000Z] spawning .../mymrc-scrape.mjs
mymrc-scrape: login required for eugene
mymrc-scrape: login submitted for eugene
mymrc-scrape: parsed 14 hauls for eugene
mymrc-scrape: eugene ok — hauls=14 inserted=14 updated=0 cancelled=0 unmatchedSources=0
mymrc-scrape: login required for woodland
mymrc-scrape: login submitted for woodland
mymrc-scrape: parsed 22 hauls for woodland
mymrc-scrape: woodland ok — hauls=22 inserted=22 updated=0 cancelled=0 unmatchedSources=0
[mymrc-cron 2026-05-06T23:45:51.000Z] scrape exit code 0
[mymrc-cron 2026-05-06T23:45:51.000Z] next scrape in 814s
```

The next-scrape timer counts down to the top of the next UTC hour. If
your `inserted` totals are `0` after the first run, either no hauls
were scheduled in the next 7-day window or the source-name match fell
through to nulls — see Troubleshooting below.

## 4. Verify

```bash
docker exec dr3-vision-mymrc-scrape env | grep ^MYMRC_
```

Expect (passwords redacted in the output for safety):

```
MYMRC_EUGENE_USERNAME=eugene-service@svdp.us
MYMRC_EUGENE_PASSWORD=...
MYMRC_WOODLAND_USERNAME=woodland-service@svdp.us
MYMRC_WOODLAND_PASSWORD=...
MYMRC_HEADLESS=true
MYMRC_AUTH_STATE_DIR=/var/lib/dr3-vision/mymrc-auth
```

Confirm the auth state files were written after the first successful
login:

```bash
docker exec dr3-vision-mymrc-scrape ls -la /var/lib/dr3-vision/mymrc-auth/
```

You should see `mymrc-eugene/auth.json` and `mymrc-woodland/auth.json`
with non-zero size. Subsequent scrapes reuse this state and skip the
re-login round-trip — `login required` lines disappear from the logs
on the second tick onward.

Confirm the operator queue picks up the rows:

```bash
docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c \
  "SELECT site_id, count(*) FROM expected_loads
   WHERE cancelled_at IS NULL
     AND expected_arrival_at >= now() - interval '1 day'
   GROUP BY site_id;"
```

Counts should match (or be close to) the per-site `parsed N hauls`
lines in the cron log.

## 5. Force a one-shot scrape (no need to wait for the cron tick)

```bash
docker exec dr3-vision-mymrc-scrape node scripts/mymrc-scrape.mjs
```

This runs the same code path as the hourly cron, exits when both
sites complete (or all configured sites failed), and respects the
same fail-soft contract.

## 6. Rotation

When the MyMRC service-account password rotates (per fleet 90-day
policy):

1. Reset the password in the MyMRC UI (Bill or whoever holds the
   account-recovery email).
2. Update the value in `~/.dr3-vision-secrets/mymrc.env` on CHAD-HQ.
3. Wipe the cached auth state so the next tick re-logs in cleanly:

   ```bash
   docker exec dr3-vision-mymrc-scrape rm -rf /var/lib/dr3-vision/mymrc-auth/mymrc-*
   ```

4. Recreate the container:

   ```bash
   docker compose up -d --force-recreate --no-deps mymrc-scrape
   ```

There's no overlap window — the new password takes effect on the
next scrape attempt. If MyMRC ever locks the account out from too
many bad attempts during rotation, the worker will fire a
`MyMRC scrape failed — <site>` ntfy with a 30-min cooldown until
the lockout clears.

## Troubleshooting

### No notification fires but the queue stays empty

Most common causes (in descending order of likelihood):

1. **No hauls scheduled in the next 7 days.** This is the normal state
   over weekends and the first week of a new contract period. Confirm
   by logging into MyMRC manually as the service account and visiting
   the Scheduled Hauls page — if you see `(empty)` there, the scrape
   is correctly reflecting reality.
2. **Source-name mismatch.** When a haul row's Collection Site value
   doesn't match any row in our `sources` table for the site, the
   row still inserts but with `source_id = null` + the raw name in
   `source_name_at_sync`. The operator queue still shows it (using
   the synced name), but it can't be linked to a downstream load
   workflow until the source is added to the seed. Look for a
   non-zero `unmatchedSources=N` in the cron log; query the affected
   row to see the raw name:

   ```sql
   SELECT external_mymrc_haul_id, source_name_at_sync
   FROM expected_loads
   WHERE site_id = '<id>'
     AND source_id IS NULL
     AND cancelled_at IS NULL
   ORDER BY last_synced_at DESC LIMIT 5;
   ```

   Then add the new source via the seed (the V2.1 admin Sources page
   is on the backlog).
3. **Login redirect on the boot scrape (cold container).** The first
   scrape after a fresh deploy logs `login required for eugene` /
   `login submitted for eugene`. If the scrape then logs
   `still on login page after re-auth for eugene`, the credentials
   are wrong. Re-check the env_file contents (no trailing whitespace,
   no quotes around values) and recreate the container.

### `MyMRC scrape failed — <site>` ntfy alerts

Each per-site failure publishes once per 30-min window (per ADR-0037
+ the wrapper's per-site fingerprint). Possible causes:

- **MRC redesigned the portal.** Selectors live at
  `src/lib/mymrc/selectors.ts` with a `SELECTOR_VERSION` constant.
  This is the most fragile file in the codebase — when MRC ships a
  major UI change, these need to be updated and a new ADR-0009
  selectors-version note dropped in `docs/MYMRC-INTEGRATION.md`.
- **MRC added CAPTCHA / 2FA.** This blocks the Playwright path
  entirely. Fall back to manual CSV reconciliation (T-016) and
  escalate to MRC for an API-access response.
- **MyMRC outage.** Both sites fail simultaneously, errors mention
  network timeouts. The wrapper does not page on the first failure
  for an unconfigured site — only on a configured site that
  previously worked. If outage > 1 hour, fire `dr3-vision-system`
  manually with `[OPERATOR] MyMRC outage > 1h`.
- **Account lockout.** Failure body contains `Invalid username or
  password` — see Rotation, §6.

### "Unhandled error" alert mentions Playwright

Almost always one of:

- Playwright browser binaries missing — should never happen in the
  prod image (built on `mcr.microsoft.com/playwright:v1.48.0-jammy`)
  but can happen in a dev environment. Run
  `npx playwright install chromium` in the worker.
- Memory pressure on CHAD-HQ — the cron host process should idle at
  ~30MB and burn ~250MB during the chromium launch. If the host is
  under load, the scrape may OOM. Check with
  `docker stats dr3-vision-mymrc-scrape`.

### How to disable the cron temporarily

If MyMRC is undergoing a major change and the scrape is repeatedly
failing, you can stop the cron without changing code:

```bash
docker compose stop mymrc-scrape
```

A `docker compose up -d` from the same compose file will bring it
back. The `unless-stopped` restart policy means a manual `stop` is
honored across daemon restarts. Operator queue rows already in the
DB stay visible — they just won't refresh. Don't leave it stopped
for more than 24h or scheduled hauls will be invisible to operators.
