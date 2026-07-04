# Operator Runbook — Rate Alerts & Missing-Record Detection

**ADR:** ADR-0043 (P3)
**Built:** 2026-07-04

## What this is

Early warning **before MRC computes the official numbers.** Vision now watches
the two contract rates and two required-record cadences nightly, on the same
audit engine as the C1–C7 checks (ADR-0039). Breaches surface in three places:

1. **The audit findings queue** — `/dashboard/<site>/audit` (the existing review
   surface; the four new checks are filterable there).
2. **Two rate tiles** on the site dashboard — `/dashboard/<site>`.
3. **One daily digest email** to a small recipient roster, only on days with open
   findings.

This is *early warning*, not the official calculation. MRC computes the billed
rate on their own schedule from MyMRC; Vision's job is to give you a head start.

## The four checks

| Code | Watches | Fires when |
|---|---|---|
| **R1** `r1_recycling_rate` | Recycling rate (by weight) | Rolling ~9-month rate below `floor + margin` |
| **R2** `r2_recovery_rate` | Recovery rate (by units, renovation-inclusive) | same pattern |
| **M1** `m1_missing_close` | Daily close | A business day with inbound activity but no `processed_units_daily` row past a 1-business-day grace |
| **M2** `m2_missing_snapshot` | Physical inventory count | No `physical` snapshot within 35 days |

- **Floors are per-jurisdiction:** CA (Woodland) 75%, OR (Eugene) 70%.
- **Margins:** a rate below `floor + 3 pts` warns (medium severity); below
  `floor + 1 pt` escalates to high. So Woodland warns under 78% and goes high
  under 76%.
- **M1 is calendar-aware:** weekends and each site's `site_holidays` are skipped,
  both for "is this a business day?" and for the grace deadline.
- **Explain-don't-flag:** if a low rate coincides with an open missing-record
  finding (M1/M2), the R-finding's detail links those M-finding ids — a low rate
  over a data gap is likely a data problem, not an operational breach. Open the
  finding to see the linked cause.

## What the tiles mean

Each site dashboard shows two tiles: **Recycling rate (by weight)** and
**Recovery rate (by units)**.

- The big number is the **current rolling rate** over the ~9-month window.
- **Floor** is the contract floor for that site's jurisdiction.
- The trend line compares the current window to the **prior equal-length
  window** (▲ improving / ▼ declining, in percentage points).
- Status dot: green *On track* (at/above `floor + 3`), amber *Near floor*
  (between the margins), red *Below floor* (under `floor + 1`), grey *No data
  yet* (nothing to rate).
- Clicking a tile opens the audit queue filtered to that check.

### The `estimated` badge (important caveat)

The recycling rate is by **weight**. Landfilled whole units have no scale weight,
so they are counted at a **55-lb-per-unit estimate** (Addendum B, *estimate
only*). Whenever that estimate contributed to the number, the tile shows an
`estimated` badge and the finding detail carries `estimated: true`. Also note:
`trash` outbound is currently counted **disposed** even where its vendor is
waste-to-energy (pending the Addendum B10-5 destination mapping) — this
**under-counts** the rate, so the alert fires *early, never late*. Both improve
automatically (no redesign) when the destination mapping and Kelsey's `%`-column
semantics land.

## Editing thresholds (no deploy)

Thresholds are **data** in `audit_check_config`, not code. A global row
(`site_id = NULL`) is the default; a per-site row overrides it field-by-field.
The R1/R2 tuning knobs live in the row's `params` JSON:

| Param | Default | Meaning |
|---|---|---|
| `ca_floor_pct` | 75 | California (Woodland) contract floor |
| `or_floor_pct` | 70 | Oregon (Eugene) contract floor |
| `warn_margin_pts` | 3 | Points above floor at/under which a rate warns (medium) |
| `high_margin_pts` | 1 | Points above floor under which a rate is high |
| `rate_window_days` | 273 | Rolling window length (~9 months) |

M1 grace is the row's `grace_business_days` (default 1). M2 cadence is
`params.snapshot_cadence_days` (default 35).

Example — raise Woodland's recycling floor to 78% without touching Oregon
(replace the connection string / db name for your environment):

```sql
INSERT INTO audit_check_config
  (id, site_id, check_code, enabled, severity, unit_tolerance,
   weight_tolerance_lbs, grace_business_days, open_window_days, blocks_billing, params)
VALUES
  (gen_random_uuid(), '<woodland-site-id>', 'r1_recycling_rate', true, 'medium',
   0, 0, 0, NULL, false,
   '{"ca_floor_pct":78,"or_floor_pct":70,"warn_margin_pts":3,"high_margin_pts":1,"rate_window_days":273}'::jsonb)
ON CONFLICT (site_id, check_code) DO UPDATE SET params = EXCLUDED.params;
```

To temporarily silence a check, set `enabled = false` on its row. The change
takes effect on the next nightly sweep — no redeploy.

## Editing digest recipients (no deploy)

Recipients live in `alert_recipients` (one row per site + email; `active`
toggles a recipient without deleting the row). Seeded roster:

- **Woodland:** `morena.gomez@svdp.us`, `janette.tomas@svdp.us`
- **Eugene:** `rick.albritton@svdp.us`

Add a recipient:

```sql
INSERT INTO alert_recipients (id, site_id, email, active, updated_at)
VALUES (gen_random_uuid(), '<site-id>', 'someone@svdp.us', true, now())
ON CONFLICT (site_id, email) DO UPDATE SET active = true;
```

Deactivate one (keeps the audit trail):

```sql
UPDATE alert_recipients SET active = false, updated_at = now()
WHERE site_id = '<site-id>' AND email = 'someone@svdp.us';
```

## The digest email

- **When:** it rides the existing daily-report cron tick. Today that fires at
  each site's `send_time_pt` (**18:00 PT**), so the digest goes out then — not
  07:00 PT (the ADR's original target). One email per site per day, guaranteed by
  the `alert_digest_logs` `(site, digest_date)` ledger even if the tick re-fires.
- **Only when there is something to say:** no open R/M findings → no email (no
  "all clear" spam).
- **From** `dr3-vision@svdp.us`, SVdP-shell branding, listing each open finding
  with a link into `/dashboard/<site>/audit`.
- **On total delivery failure** it pages `dr3-vision-system` on ntfy (fingerprint
  `alert-digest-failed:<site>`, 6-hour cooldown) — the alert channel itself
  failing is a system event. A healthy send is silent. Operational findings never
  push (hard rule #5); ntfy is otherwise untouched by this feature.
- **If M365 isn't configured** the digest is a fail-open no-op (logs, no page, no
  ledger row) — it retries on the next tick once mail is configured.

## Deploy & verify

```
git checkout main && git pull
docker compose up -d   # applies 20260709_alert_recipients, runs the seed
```

1. Migration applied:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision \
     -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;"
   ```

2. Recipients seeded:

   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision \
     -c "SELECT s.code, r.email, r.active FROM alert_recipients r JOIN sites s ON s.id = r.site_id ORDER BY 1,2;"
   ```

3. Tiles: open `/dashboard/woodland` and `/dashboard/eugene` — the two rate tiles
   render (grey *No data yet* until there is outbound/landfill/processed history
   in the window).

4. Checks run: the nightly sweep (`/api/internal/audit/sweep`, 02:30 PT) now
   includes R1/R2/M1/M2 in `audit_runs.checks_run`. To test on demand, run the
   audit for a site from `/dashboard/<site>/audit`.
