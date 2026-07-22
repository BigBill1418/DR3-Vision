# MyMRC scrape setup — DR3-Vision operator runbook

**This is Vision's FIRST-EVER MyMRC sync.** Despite the pipeline shipping under
ADR-0009/ADR-0038, Vision has never pulled a single record from MyMRC — the DR3
service accounts the old env-var scheme referenced were never created, so the
worker ran its fail-soft "creds not configured, skipping" path every hour and
exited 0. ADR-0057 fixes the auth model (single admin identity) and the failure
posture (fail loud, no silent skip). Follow this runbook to make the first pull
happen.

Per ADR-0009, DR3-Vision pulls from MyMRC by browser automation (Playwright) —
there is no API path until MRC enables one. The `mymrc-scrape` cron container in
`docker-compose.yml` runs a scrape once on boot and once at the top of every UTC
hour.

## What changed (ADR-0057)

- **Single admin identity (D1).** The scrape logs into MyMRC **once** as Bill's
  admin user — not per-site, no service accounts. Site scoping happens on the
  data (records carry `Recycler__c` = "DR3 Woodland" / "DR3 Eugene"), not on the
  login. The retired `MYMRC_{EUGENE,WOODLAND,OR,CA}_*` env vars are gone.
- **Credentials live in the database, entered via the UI — NEVER a `.env`.**
  Bill types his MyMRC admin login into the **`/admin/mrc-scrape`** admin surface;
  it is stored **AES-256-GCM encrypted** in Postgres. There is no credentials file
  to drop on the host.
- **Fail loud (D9).** When no admin credential is configured (or it can't be
  decrypted), the worker **pages `dr3-vision-system` and exits non-zero**, and the
  container healthcheck reports **unhealthy**. The months-of-zero-pulls silent
  path is deleted.

## 1. Provision the encryption key (one-time, per fleet host)

The only MyMRC-related **secret on the host** is the encryption **key** —
`MYMRC_CRED_KEY` — NOT the MyMRC login (that lives in the DB). It is a dedicated
32-byte random secret, deliberately separate from `NEXTAUTH_SECRET` (the scrape
container is stripped of `NEXTAUTH_SECRET` per the ADR-0053 addendum so a
compromised Chromium cron can't mint admin JWTs; deriving the cred key from it
would reverse that hardening).

Generate it once and drop it into a mode-600 file that **both** the `app` and
`mymrc-scrape` services mount:

```bash
ssh 10.99.0.2   # CHAD-HQ
umask 077
printf 'MYMRC_CRED_KEY=%s\n' "$(openssl rand -hex 32)" \
  > ~/.dr3-vision-secrets/mymrc-cred-key.env
chmod 600 ~/.dr3-vision-secrets/mymrc-cred-key.env
```

- `mymrc-scrape` mounts this file already (see `docker-compose.yml`, the
  `mymrc-cred-key.env` env_file entry — the reader/decrypt side).
- The **`app` service must mount the SAME file** (the writer/status side — it
  encrypts on save and reads status for `/admin/mrc-scrape`). If it isn't mounted
  on `app`, saving credentials in the UI fails. Confirm both services carry
  `MYMRC_CRED_KEY`.

Losing this key makes the stored credential undecryptable — the scrape will fail
loud (exit 4) until the key is restored or Bill re-enters the login under a new
key. Back it up in the 1Password Fleet vault.

## 2. Enter the MyMRC admin credentials in the UI

There is **no file to edit**. Bill (or whoever holds the admin login):

1. Open **`https://dr3-vision.barnardhq.com/admin/mrc-scrape`**.
2. Enter the MyMRC **admin** username + password (the account with visibility
   into both DR3 Woodland and DR3 Eugene — no MFA on this account, so plain
   Playwright login works).
3. Save. The password is encrypted immediately and never leaves the server as
   plaintext again.

**No trailing whitespace on the password** — MyMRC's login form rejects a
password with a stray space appended and returns only "Invalid username or
password" with no further detail. The UI stores exactly what is typed (no
trimming of the password body), so paste carefully.

## 3. Activate the worker

The `mymrc-scrape` service is **profile-gated** (`mymrc`) — it is not started by a
plain `docker compose up -d` or the deployer. Activation is a deliberate action:

```bash
cd /home/bbarnard065/DR3-Vision
# Ensure the auth-state volume is owned by the container uid (first activation):
docker run --rm -v dr3-vision_mymrc-auth-state:/v alpine chown -R 1001:1001 /v
docker compose --profile mymrc up -d mymrc-scrape
```

Then re-add `mymrc-scrape` to the noc-master service-registry `containers[]` so
NOC watches its health.

**Order matters.** If you activate the worker *before* entering credentials in the
UI, that is fine and expected under D9 — the worker will page
`dr3-vision-system` ("MyMRC admin credentials not configured — enter them at
/admin/mrc-scrape") each tick and report unhealthy until the credential lands.
That interim noise is the intended, self-limiting nudge, not a bug. (See the
note in Troubleshooting on page frequency.)

## 4. Verify

Watch the boot scrape:

```bash
docker logs -f dr3-vision-mymrc-scrape
```

Configured + healthy looks like (single admin login, then per-site feeds):

```
[mymrc-cron ...] cron host started
[mymrc-cron ...] spawning .../mymrc-scrape.mjs
mymrc-sync[...]: mymrc: login required (admin)
mymrc-sync[...]: mymrc: login submitted (admin)
mymrc-sync[...]: eugene done — hauls=ok(listed:14,detail:14) processed=ok(...) outbound=ok(...)
mymrc-sync[...]: woodland done — hauls=ok(listed:22,detail:22) processed=ok(...) outbound=ok(...)
[mymrc-cron ...] scrape exit code 0
[mymrc-cron ...] next scrape in 814s
```

Confirm the container is healthy and the admin session was persisted:

```bash
docker inspect --format '{{.State.Health.Status}}' dr3-vision-mymrc-scrape   # → healthy
docker exec dr3-vision-mymrc-scrape ls -la /var/lib/dr3-vision/mymrc-auth/mymrc-admin/
```

You should see a non-zero `auth.json` under `mymrc-admin/` (single admin context —
no per-site directories). Subsequent scrapes reuse this session and skip the
re-login round-trip.

## 5. Force a one-shot scrape (no need to wait for the cron tick)

```bash
docker exec dr3-vision-mymrc-scrape node scripts/mymrc-scrape.mjs
```

Same code path as the hourly cron. Exit codes: `0` success · `1` admin session
failed to start · `2` no `DATABASE_URL` · `3` credentials not configured (D9) ·
`4` credentials present but undecryptable (bad/missing `MYMRC_CRED_KEY` or a
tampered row).

## 6. Rotation

When the MyMRC admin password changes:

1. Reset it in MyMRC.
2. **Re-enter the new password at `/admin/mrc-scrape`.** That's the whole
   rotation — no host file to edit, no container recreate.
3. Wipe the cached admin session so the next tick re-logs in cleanly:

   ```bash
   docker exec dr3-vision-mymrc-scrape rm -rf /var/lib/dr3-vision/mymrc-auth/mymrc-admin
   ```

There's no overlap window — the new password takes effect on the next scrape.

Rotating the **encryption key** (`MYMRC_CRED_KEY`) is a different, rarer
operation: it invalidates the stored ciphertext, so update the key file on both
`app` and `mymrc-scrape`, recreate both, then re-enter the login in the UI (which
re-encrypts under the new key).

## Troubleshooting

### `[DR3-Vision] MyMRC sync error — admin` pages saying "credentials not configured"

Working as intended (D9). The store has no admin credential yet — enter it at
`/admin/mrc-scrape`. **Page frequency:** the worker is spawned fresh per tick, so
the ntfy publisher's in-process cooldown does not dedup across ticks — expect
roughly one page per hour (priority `high`, buffered into the 07:00 digest during
quiet hours) until the credential is entered. It is self-limiting (stops the moment
creds land) and backed by the always-visible container healthcheck. If you need to
silence it before entering creds, `docker compose stop mymrc-scrape`.

### Container is `unhealthy`

The healthcheck (`scripts/mymrc-healthcheck.mjs`) reports unhealthy whenever no
admin credential row exists. Enter creds at `/admin/mrc-scrape`; health flips
green on the next probe (5-minute interval).

### Login redirect loop / "still logged out after re-auth (admin)"

The credentials are wrong. Re-check the login at `/admin/mrc-scrape` (no trailing
whitespace on the password) and wipe the cached session (§6 step 3).

### Exit code 4 / "could not be loaded/decrypted"

`MYMRC_CRED_KEY` is missing or does not match the key the credential was stored
under. Restore the correct key on the container (§1), or re-enter the login in the
UI to re-encrypt under the current key.

### `MRC redesigned the portal` / selectors broke

Selectors live at `src/lib/mymrc/selectors.ts` with a `SELECTOR_VERSION`
constant — the most fragile file in the codebase. On a major MRC UI change these
need updating. A wrong selector degrades to a loud `PortalContractDriftError` /
`AuthFailedError` page, never a silent empty.

Real-portal facts (verified live 2026-07-22, `SELECTOR_VERSION` `2026-07-22`):
login is by **placeholder** ("Username"/"Password") + a **"Log In"** button
(the fields have no `name` and dynamic ids); the authenticated landing is
**`/s/`** (title "Home", "Switch Account" banner) — **`/s/home` is a 404 for
everyone**; objects are enumerated from the **nav → per-object `/s/<slug>`
pages** (`hauls`, `illegal-dump-cip-`, `processed-materials`,
`outbound-materials`, `availability`, `outbound-vendors`, `records-review`).
The admin account views **one recycler at a time** (DR3 Woodland ↔ DR3 Eugene,
"Switch Account"); records carry `Recycler__c`.

### One-shot Phase 0 discovery (writable output dir)

`node scripts/mymrc-discovery.mjs` enumerates every visible object and writes the
report + per-object fixtures. In the container (`/app` is read-only for uid 1001)
point it at a writable mounted volume:

```bash
MYMRC_DISCOVERY_OUT_DIR=/data/mymrc-discovery node scripts/mymrc-discovery.mjs
```

The repo layout (`docs/mymrc-discovery-<date>.md` + `src/lib/mymrc/__fixtures__/<object>/`)
is preserved under the override, so the artifacts copy straight back into the repo.
Defaults to the repo root when unset (local dev).

### How to disable the cron temporarily

```bash
docker compose stop mymrc-scrape
```

The `unless-stopped` policy honors a manual `stop` across daemon restarts.
Operator queue rows already in the DB stay visible; they just won't refresh.
