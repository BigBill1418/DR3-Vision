# MyMRC ingestion — operator runbook (ADR-0038)

> **SUPERSEDED by ADR-0057 — read [`docs/operator/mymrc-setup.md`](./mymrc-setup.md) instead.**
>
> The credential model in the "Enabling the service" section below is **out of date**.
> As of ADR-0057 (+ the Wave-1 credential surface) there is **no `~/.dr3-vision-secrets/mymrc.env`
> file and no per-site service accounts**. The scrape logs in **once** as a single admin
> identity whose login is entered in the UI at **`/admin/mrc-scrape`** and stored **AES-256-GCM
> encrypted in Postgres**. The only MyMRC secret on the host is the encryption key
> `MYMRC_CRED_KEY` (see `mymrc-setup.md`). The "What lands where", paging table, and run-ledger
> query sections below remain accurate.

The ADR-0038 rebuild replaces the old DOM scraper (ADR-0009 / `mymrc-setup.md`).
DR3-Vision now pulls the three MyMRC feeds — **Hauls** (inbound), **Processed**,
and **Outbound** — from the Salesforce portal's own **Aura/JSON** endpoints over
an authenticated browser session, and mirrors them into audit-evidence tables.
There is no MyMRC API (formally denied: `401 INVALID_SESSION_ID`), so ingestion
rides the logged-in session.

The `mymrc-scrape` container runs once on boot and once at the top of every UTC
hour. Each tick logs into both sites (Eugene + Woodland) sequentially and, per
site, runs all three feeds. **A healthy run is silent.** Failures page Bill on
`dr3-vision-system` (see "What the pages mean").

## Enabling the service (deliberate operator action)

The service is **profile-gated** (`mymrc`): it is never started by
`docker compose up -d` or the swarmpilot deployer. To turn it on (ADR-0057 model —
see `mymrc-setup.md` for the authoritative, step-by-step version):

1. **Provision the encryption key** `MYMRC_CRED_KEY` (a dedicated 32-byte random
   secret) into a mode-`600` file on the fleet host (e.g.
   `~/.dr3-vision-secrets/mymrc-cred-key.env`), sourced by **both** the `app` and
   `mymrc-scrape` containers via `env_file`. This is the ONLY MyMRC secret on the
   host — the MyMRC login itself is NOT a file.
   Then **enter the MyMRC admin login** in the UI at **`/admin/mrc-scrape`**; it is
   stored AES-256-GCM encrypted in Postgres. There are no per-site service accounts
   and no `mymrc.env`. Fail-loud (D9): with no admin credential configured, the
   worker **pages `dr3-vision-system` and exits non-zero** and the healthcheck goes
   unhealthy — the old silent "creds not configured, skipping" path is deleted.
2. **Fix the auth-state volume owner** (the runner runs as uid 1001 `nextjs`):
   ```
   docker run --rm -v dr3-vision_mymrc-auth-state:/v alpine chown -R 1001:1001 /v
   ```
3. **Start it:** `docker compose --profile mymrc up -d`
4. **Re-add to NOC:** add `mymrc-scrape` back to the noc-master
   service-registry `containers[]` so it is monitored.

To stop: `docker stop dr3-vision-mymrc-scrape` (or drop the profile).

## What lands where

- **Mirror tables** (`mymrc_hauls_mirror`, `mymrc_processed_mirror`,
  `mymrc_outbound_mirror`) — the raw, per-record mirror. Keyed by the Salesforce
  record `id`; `external_*_id` holds the human number (Haul `H-…` / Materials
  `M-…`), filled in on the detail pass. `payload` keeps the full raw record.
  `disappeared_at` is stamped when a record drops off the feed; `detail_fetched_at`
  when its per-record detail has been pulled. These are **audit evidence** for the
  3-way audit (ADR-0039) and dashboards — not operational tables.
- **`expected_loads`** — Hauls (only) also feed the operator queue here, via the
  existing upsert. Manually-entered rows (any id not starting with `H-`) are
  **never** auto-cancelled by the sync.
- **`mymrc_sync_runs`** — one ledger row per site per feed per tick (see queries).

## What the pages mean (`dr3-vision-system`, Bill-only)

| Title | Meaning | Action |
|---|---|---|
| `MyMRC auth failed — <site>` | Login/session invalid; re-login failed. | Re-enter the MyMRC admin login at `/admin/mrc-scrape` (expired? password change? MFA turned on?). |
| `MyMRC portal contract drift — <site> [feed]` | The expected Aura action/shape was missing (likely a Salesforce release changed the `fwuid`/envelope, or a feed/URL moved). | Re-run discovery + update `portal-client.ts` / `selectors.ts`; bump `SELECTOR_VERSION`. |
| `MyMRC zero-row anomaly — <site> [feed]` | Listed 0 rows where the last successful run listed >0. | Verify the feed in the portal by hand; a real emptying is possible but rare. |
| `MyMRC sync deadman — <site> [feed]` | No successful run in >26h (wedged/stopped container). | Check the container is running and the host is healthy. |

Paging is deduped: a persisting failure pages on its leading edge and then at most
every 6h (deadman is the >26h backstop). Cooldowns fail-soft when
`NTFY_PUBLISHER_TOKEN` is unset.

## Run-ledger queries

Feed freshness / last outcomes per site+feed:
```sql
SELECT s.code AS site, r.feed, r.status, r.rows_listed, r.details_fetched,
       r.started_at, r.error
FROM mymrc_sync_runs r
JOIN sites s ON s.id = r.site_id
WHERE (r.site_id, r.feed, r.started_at) IN (
  SELECT site_id, feed, max(started_at) FROM mymrc_sync_runs GROUP BY site_id, feed
)
ORDER BY site, feed;
```

Recent failures (last 24h):
```sql
SELECT s.code, r.feed, r.status, r.error, r.started_at
FROM mymrc_sync_runs r JOIN sites s ON s.id = r.site_id
WHERE r.status <> 'ok' AND r.started_at > now() - interval '24 hours'
ORDER BY r.started_at DESC;
```

Records still awaiting a detail fetch (retry next tick automatically):
```sql
SELECT count(*) FROM mymrc_processed_mirror
WHERE detail_fetched_at IS NULL AND disappeared_at IS NULL;
```

## When the portal redesigns

The transport is isolated in `src/lib/mymrc/portal-client.ts` and the login
selectors in `selectors.ts`. A redesign surfaces as `contract_drift` / `auth`
pages (never a silent empty). Re-run the discovery capture, refresh the fixtures
under `src/lib/mymrc/__fixtures__/`, update the transport, and bump
`SELECTOR_VERSION` + a CHANGELOG "Selectors" entry.
