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
>
> **The worker is now ALWAYS-ON (un-gated).** As of ADR-0057, the `mymrc-scrape`
> service no longer carries `profiles: ['mymrc']` — it joins the default
> `docker compose up -d` set and the swarmpilot deployer starts and keeps it up
> (`restart: unless-stopped`). The "Enabling the service" section below (which describes
> the old profile-gated `--profile mymrc` start) is therefore obsolete: nothing has to be
> manually started once the admin credential is provisioned at `/admin/mrc-scrape`. The
> credential-state healthcheck reports UNHEALTHY-until-provisioned; the mid-run session
> drop is self-healed by a hardened re-auth (rebuild-clean-context + re-login), and a
> genuinely dead session pages on `dr3-vision-system`. Historical backfill is a separate
> one-shot runner (`scripts/mymrc-backfill.mjs` / `mymrc-enrich-details.mjs`), not the
> hourly worker.

The ADR-0038 rebuild replaces the old DOM scraper (ADR-0009 / `mymrc-setup.md`).
DR3-Vision now pulls the four MyMRC feeds — **Hauls** and **Hauls (completed)**
(inbound; two status-scoped views over the same mirror), **Processed**,
and **Outbound** — from the Salesforce portal's own **Aura/JSON** endpoints over
an authenticated browser session, and mirrors them into audit-evidence tables.
There is no MyMRC API (formally denied: `401 INVALID_SESSION_ID`), so ingestion
rides the logged-in session.

The `mymrc-scrape` container runs once on boot and once at the top of every UTC
hour. Each tick logs into both sites (Eugene + Woodland) sequentially and, per
site, runs all four feeds. **A healthy run is silent.** Failures page Bill on
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
- **`inbound_loads`** — Delivered `type='General'` hauls are also bridged to the
  floor's inbound leg, aggregated per (site, delivery day). **The delivery day is
  `recycler_reported_delivery_date`, falling back to `docking_appointment_date` only
  when the recycler-reported date is absent** (ADR-0089 D2). The appointment date is
  a SCHEDULING field: null on every route-collection haul (886/886 carrying a
  `Collection_Source__c`) and off by up to 9 days when present. The bridge writes only
  rows it owns (`load_source_type='mymrc_haul'`) and never a day the office
  (`paper_bulk`) or the floor (`ipad_floor`) already confirmed.
- **`mymrc_sync_runs`** — one ledger row per site per feed per tick (see queries).

## What the pages mean (`dr3-vision-system`, Bill-only)

| Title                                            | Meaning                                                                                                                                                                                                                                                                                              | Action                                                                                                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MyMRC auth failed — <site>`                     | Login/session invalid; re-login failed.                                                                                                                                                                                                                                                              | Re-enter the MyMRC admin login at `/admin/mrc-scrape` (expired? password change? MFA turned on?).                                                                                                                   |
| `MyMRC portal contract drift — <site> [feed]`    | The expected Aura action/shape was missing (likely a Salesforce release changed the `fwuid`/envelope, or a feed/URL moved).                                                                                                                                                                          | Re-run discovery + update `portal-client.ts` / `selectors.ts`; bump `SELECTOR_VERSION`.                                                                                                                             |
| `MyMRC zero-row anomaly — <site> [feed]`         | Listed 0 rows where the last successful run listed >0.                                                                                                                                                                                                                                               | Verify the feed in the portal by hand; a real emptying is possible but rare.                                                                                                                                        |
| `MyMRC sync deadman — <site> [feed]`             | No successful run in >26h (wedged/stopped container).                                                                                                                                                                                                                                                | Check the container is running and the host is healthy.                                                                                                                                                             |
| `MyMRC mirror stopped advancing — <site> [feed]` | The scrape is running fine, but the newest record we HOLD for that feed is >96h old (ADR-0070).                                                                                                                                                                                                      | Run the bounded catch-up below. If it does not clear, check the feed by hand in the portal — a genuinely quiet feed is possible.                                                                                    |
| `MyMRC Delivered haul(s) with no delivery date`  | A haul is `Delivered` and its detail has been fetched, but BOTH `recycler_reported_delivery_date` and `docking_appointment_date` are null, so the bridge cannot place it on a day (ADR-0089 D2). It is counted, skipped and **named** — never silently dropped, which was the whole ADR-0089 defect. | Ask MRC to date the named hauls in the portal, then re-run the bridge for the affected days. After the 2026-08-10 recovery this residual is **0/7,314**, so any fire is a genuinely new record rather than backlog. |

Paging is deduped: a persisting failure pages on its leading edge and then at most
every 6h (deadman is the >26h backstop). The staleness page is deduped separately:
at most **one per site+feed per day**. Cooldowns fail-soft when
`NTFY_PUBLISHER_TOKEN` is unset.

## When the mirror stops advancing (ADR-0070)

Runs reporting `ok` do **not** mean the mirror is current — that was exactly the
2026-07-22→31 failure, where 216 consecutive `ok` runs sat over a mirror that had
not gained a row in nine days. A run whose feed has fallen behind now records
`stale_mirror` on the ledger instead of `ok`, and the amber **Mirror stale** pill
shows on `/admin/mrc-scrape`.

Check what we actually hold (times are UTC in the DB; the admin surface renders PT):

```sql
SELECT 'processed' AS feed, max(entry_date) AS newest FROM mymrc_processed_mirror
UNION ALL SELECT 'outbound', max(entry_date) FROM mymrc_outbound_mirror
UNION ALL SELECT 'hauls',
       max(COALESCE(recycler_reported_delivery_date, docking_appointment_date))
  FROM mymrc_hauls_mirror WHERE status = 'Delivered';
```

> The hauls row must match the guard in `src/lib/mymrc/freshness.ts` **exactly**, or
> you get a healthier answer than the guard would give. Two things are load-bearing:
> the COALESCE stays **inside** `max()` (not `GREATEST(max(a), max(b))`), and only
> **`Delivered`** rows count — a scheduled appointment is dated into the future and
> will report a frozen delivered feed as fresh. Keying on
> `docking_appointment_date` alone is the ADR-0089 defect: it is a SCHEDULING field,
> null on every route-collection haul and up to 9 days off the true delivery when
> present.

### Bounded catch-up

The hourly walk covers the 800 most-recently-created records per feed. To reach
further back **once**, widen the walk for a single run — this is bounded by
construction, not an unbounded re-scrape:

```bash
# on svdp-dev, in ~/DR3-Vision
docker compose run --rm \
  -e MYMRC_LIST_PAGE_SIZE=2000 \
  -e MYMRC_LIST_MAX_PAGES=2 \
  mymrc-scrape node scripts/mymrc-scrape.mjs
```

`2000 × 2` reaches the 4000 most-recently-created records per feed. The portal caps
`pageSize` at 2000 and the `OFFSET` clause at 2000, so that is the deepest a
newest-first walk can go; the walk refuses to plan a request past the ceiling and
warns when the budget is clipped.

**Cost of a catch-up.** It upserts every id it lists (cheap, one row each) but
fetches detail only for rows still lacking it, so the expensive work is
proportional to what is genuinely _new_, not to the page budget. Measured at full
depth on 2026-07-31: 7 new processed, 69 new outbound, 0 new hauls.

For pulling **history** (records older than the newest 4000), the catch-up is the
wrong tool — use the sort-flip backfill (`scripts/mymrc-backfill.mjs`, ADR-0057 D3),
whose cursors must be reset first because a drained cursor is a no-op.

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
