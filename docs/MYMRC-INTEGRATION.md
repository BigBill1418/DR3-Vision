# MyMRC integration runbook

This is the operational reference for the MyMRC integration. ADR-0009 is the architecture decision; this document is the working-knowledge runbook.

## What MyMRC is

MyMRC is the [Mattress Recycling Council](https://mattressrecyclingcouncil.org)'s vendor portal, accessible at `https://mrc-us.my.site.com`. It is built on Salesforce Experience Cloud. DR3 has separate accounts for the California program (Woodland) and the Oregon program (Eugene), administered separately because they are distinct regulatory programs run by separate MRC subsidiary entities (MRC California LLC and MRC Oregon LLC).

## Credentials

Stored in environment variables, **separately per site**:

- `MYMRC_CA_USERNAME` / `MYMRC_CA_PASSWORD` — Woodland account
- `MYMRC_OR_USERNAME` / `MYMRC_OR_PASSWORD` — Eugene account

These are SVdP service accounts, not personal accounts. Do not commit them. Rotate per fleet conventions (90-day rotation; see FLEET-PRIMER).

## Two-direction integration

### Read path (MVP — T-015 in Sprint 1)

**Purpose:** populate the operator's expected-loads queue with hauls already scheduled in MyMRC.

**Cadence:** hourly cron job per site

**Flow:**
1. Restore Playwright storage state from `~/.dr3-vision/mymrc-{site}/auth.json`
2. Navigate to `https://mrc-us.my.site.com/s/scheduled-hauls?recycler=DR3+{site}`
3. Detect login redirect; if present, re-authenticate and re-save storage state
4. Scrape the table of next 7 days of scheduled hauls
5. For each row, upsert an `expected_loads` record matched by `external_mymrc_haul_id`
6. Flag and remove any local rows that no longer appear in MyMRC (haul cancelled)
7. Log success or failure to Loki; on failure, fire ntfy `dr3-vision-system` to Bill

**Output schema:**
```
expected_loads
  id, site_id, external_mymrc_haul_id, expected_arrival_at,
  source_id (FK sources, matched by name), transporter_id (FK transporters),
  expected_unit_count, bol_number,
  scheduled_at_mymrc, last_synced_at,
  cancelled_at (nullable; set if disappears from MyMRC)
```

### Write path (V2.1 — backlog)

**Purpose:** push completed loads back into MyMRC so MRC can bill us correctly.

**Status:** deferred until either MRC enables API access or Sprint 2 explicitly chooses to build the Playwright write-path.

**If Playwright write-path:** event-triggered job, opens MyMRC, navigates to the haul record, updates Recycler Reported fields. See `src/integrations/mymrc/write.ts` (to be built).

### CSV reconciliation upload (MVP — T-016 in Sprint 1)

**Purpose:** monthly bulk reconciliation against MyMRC's CSV export.

**Flow:**
1. Manager downloads the monthly CSV from MyMRC manually
2. Manager uploads to `/portal/reconciliation/upload`
3. System parses and matches each row against DR3-Vision loads by `(external_mymrc_haul_id, date, source)`
4. Discrepancies surface as a flagged list with action affordances
5. Manager resolves each row; resolution decisions persist in `mymrc_reconciliation_items`

## MyMRC data shape (as observed)

The MyMRC haul export has these columns (from the 2026-05-04 export):

```
Recycler                              # "DR3 Woodland" or "DR3 Eugene"
Haul: Haul ID                         # e.g., "H-126152"
Recycler Reported Delivery Date       # MM/DD/YYYY
Collection Site                       # the source name (matches our sources.csv)
Unit Count at Unload                  # what MRC sees
Recycler Program Unit Count           # what we report as program-eligible
Recycler Non-Program Unit Count       # what we report as non-program
Other Collection Site                 # rarely populated
Pickup Address                        # parsed into street/city/state/zip in our seed
Transporter                           # the carrier name (matches our transporters.csv)
Reference Number                      # MRC's internal reference
Recycler Weight                       # integer pounds
Status                                # "Delivered" or pending
Commodity                             # "Whole Mattresses and Foundations"
# of Attached Files                   # count of photos attached
```

The exports come in three formats:
- **HTML-as-XLS** (`report*.xls` files) — actually HTML tables; parse with an HTML parser, not openpyxl
- **CSV** (`report*.csv`) — daily aggregate per site, used for processed-units reconciliation
- **PDF** — billing artifacts, not for ingestion

The address field uses HTML-encoded `&lt;br&gt;` between street and city. After HTML decoding, split on literal `<br>`.

## Selectors

All Playwright selectors live in `src/integrations/mymrc/selectors.ts`. Treat changes there with extra care; this is the most fragile file in the codebase.

```ts
// src/integrations/mymrc/selectors.ts
export const SELECTORS = {
  loginEmailField: 'input[name="username"]',
  loginPasswordField: 'input[name="password"]',
  loginSubmitButton: 'button[type="submit"]',
  scheduledHaulsTable: 'table[data-purpose="scheduled-hauls"]',
  // ... rest of the selectors
} as const;
```

When MRC redesigns the portal:
1. Confirm via manual inspection that the page changed
2. Update selectors with new identifiers
3. Bump the integration version comment at the top of `selectors.ts`
4. Note the change in this runbook

## Failure modes and recovery

| Failure | Detection | Recovery |
|---|---|---|
| Login redirect (auth expired) | Playwright sees `/login` instead of `/scheduled-hauls` | Re-authenticate, re-save storage state, retry |
| Selectors broken (page redesign) | Element not found errors in Playwright | Manual inspection, update `selectors.ts`, redeploy |
| MRC adds CAPTCHA / 2FA | Login flow fails with new challenge | Pause Playwright job, fall back to manual CSV reconciliation, escalate to MRC contact |
| MyMRC site outage | All requests return 5xx or timeout | Backoff and retry; ntfy if outage > 1 hour |
| Network outage on CHAD-HQ | Playwright cannot reach MyMRC | Job retries on next cron tick; no alert needed |

## Pending work

- **API access request** — email sent to MRC contact 2026-05-04 requesting "API Enabled" permission on the DR3 user. If granted, supersede ADR-0009 with a new ADR for REST API integration.
- **Selector versioning** — once Sprint 2 starts, version the selectors file with a date-of-last-verified header.

## References

- ADR-0009 (Playwright integration architecture)
- Charter §6.5 (MyMRC integration), §11 (Open decisions, deferred section)
- 2026-05-04 API test result (in transcript)
