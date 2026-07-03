# ADR-0038 — MyMRC ingestion rebuild (Salesforce portal: JSON transport, mirror tables, loud failure)

**Status:** Accepted (2026-07-03, approved by Bill)
**Date:** 2026-07-03
**Relates to:** ADR-0009 (Playwright write path), ADR-0037 (foundations), mission record §6-P1/§8, `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`, 2026-06-23 readiness item P1-2
**Series:** second of three P1 ADRs — 0037 foundations (accepted), **0038 ingestion (this)**, 0039 3-way audit + retro-audit

## Context

The loads feature has 0 rows because the MyMRC feed never worked, and its one
prior parser broke **silently twice** — most recently landing logged-out on a 404,
parsing 0 hauls, and reporting "ok". MRC's redesign moved the portal to Salesforce
Experience Cloud with Lightning datatables on `/s/hauls`, `/s/processed-materials`,
`/s/outbound-materials`. Login is solved (SELECTOR_VERSION 2026-06-22, no MFA,
per-site service accounts — account scoping is by login now, not URL param).
API access was formally DENIED (charter v0.4: `401 INVALID_SESSION_ID`, profile
lacks "API Enabled") — so ingestion rides the authenticated browser session.
Readiness item P1-2 makes silent-empty elimination a **blocking gate**: the buildout
multiplies the silent-failure class across three feeds.

## Decisions

### D1 — Transport: session-authenticated JSON, never DOM cells

The ingestion contract is: **parsers consume JSON records; no code path ever parses
Lightning DOM**. Playwright's only jobs are (a) login + storage-state capture and
(b) carrying the session while we obtain the datatable's own JSON. Implementation
ladder, in preference order, decided empirically during the discovery task:

1. **Aura XHR replay** — capture the exact `POST /s/sfsites/aura` message the
   datatable issues (message/actions envelope + `fwuid` context), then replay it
   with the session cookies via plain `fetch` per sync run. Fastest, no browser
   per fetch after login.
2. **In-page response interception** — Playwright `waitForResponse`/`page.route`
   on the Aura endpoint while loading the list page; parse the intercepted JSON.
   Slower (real page loads) but immune to envelope drift.

Either way the transport is isolated in ONE module (`src/lib/mymrc/portal-client.ts`)
so the next redesign touches one file. A `fwuid`/envelope change throws a typed
`PortalContractDriftError` — loud, never a silent 0. The old HTML `parser.ts` is
deleted with its tests (replaced by JSON mappers with fixture tests captured from
the live portal during discovery).

### D2 — MyMRC data lands in MIRROR tables, not Vision's operational tables

The 3-way audit (ADR-0039) compares **daily logs ↔ MyMRC ↔ billing** — three
independent legs. If ingestion upserted MyMRC rows into ADR-0037's operational
tables, the audit would compare MyMRC to itself. So:

```
mymrc_hauls_mirror(id, site_id, external_haul_id UNIQUE, status, rate_id,
                   docking_appointment_at, door, payload jsonb, first_seen_at,
                   last_seen_at, disappeared_at?, detail_fetched_at?,
                   units?, weight_lbs?, retrac_id?, …)
mymrc_processed_mirror(id, site_id, external_materials_id UNIQUE, bol_id,
                   entry_date, processed_date, payload jsonb, …same lifecycle)
mymrc_outbound_mirror(id, site_id, external_materials_id UNIQUE, entry_date,
                   bol_id, vendor, payload jsonb, …same lifecycle)
```

Full raw `payload jsonb` retained (audit evidence + future-proof against column
needs). **One existing exception stays:** Hauls also feed `expected_loads` (the
operator queue — that is operational plumbing, not audit input), through the
existing upsert path with its **scrape-overwrite protection for `source=manual`**
rows (mission §8: Janette's manual morning entries must never be clobbered).
`processed`/`outbound` mirrors feed NOTHING operational — read only by the audit,
dashboards, and reconciliation surfaces.

### D3 — Idempotency, lifecycle, per-record detail

Upsert keyed on the portal's external ids. `first_seen_at`/`last_seen_at` maintained
every run; rows absent from a full list fetch get `disappeared_at` (the existing
`expected_loads.cancelled_at` pattern). **Detail fetch is a second pass**: weights /
unit counts / Re-TRAC ids live on record pages, not list views — fetch details only
for new-or-changed records (bounded concurrency ≤3), stamping `detail_fetched_at`.
A list row whose detail fetch fails stays visible with `detail_fetched_at NULL` and
retries next run — partial progress is never silently dropped.

### D4 — Silent-failure elimination (readiness gate P1-2; the point of this ADR)

- **`isLoginPage()` hardened**: also detects the 404/logged-out error page (title
  "Error", body "404 Error… Log in") and any response lacking the authenticated
  shell — treated as not-authenticated, triggering ONE re-login attempt, then a
  typed `AuthFailedError`.
- **Run ledger `mymrc_sync_runs`**(site, feed, started_at, finished_at, status
  enum(ok, auth_failed, contract_drift, error), rows_listed, rows_upserted,
  details_fetched, error text) — every run writes a row; dashboards and ADR-0039
  read feed freshness from it.
- **Zero-anomaly detection**: a run that lists 0 rows for a feed whose previous
  successful run listed >0 is `status=error` ("0 where N"), not ok.
- **Paging**: `AuthFailedError`, `PortalContractDriftError`, zero-anomaly, and
  no-successful-run-in->26h (deadman, catches a wedged/stopped container) each page
  ntfy `dr3-vision-system` (Bill-only — MyMRC sync failure is explicitly a
  system-level ntfy event per charter Q16) with per-fingerprint cooldowns per
  ADR-0037-fleet policy. A healthy run is silent.

### D5 — Scheduling & ops

Revive the paused `mymrc-scrape` compose service (profile `mymrc`), hourly cadence
(existing `scripts/mymrc-cron.mjs` shape), sites sequential (two service accounts,
one browser). Creds stay in `~/.dr3-vision-secrets/mymrc.env`. Ops follow-ups
recorded here: re-add the service to the noc-master service registry when
re-enabled; the container keeps `init: true` (chromium reaping).

### D6 — Discovery task is part of implementation, with a checkpoint

Step 1 of implementation is a live discovery session against the real portal
(Playwright, read-only pages): capture the Aura envelopes for the three list views
+ one record detail of each type, and commit them as **redacted fixtures** for the
JSON-mapper tests. If the Aura replay path (D1 ladder #1) proves unstable during
discovery, fall to ladder #2 without a new ADR — the transport module boundary and
everything above it are unchanged. Only if BOTH fail does this come back to the
operator.

## Out of scope

Reconciliation/diffing of mirror vs. operational data (**ADR-0039**) · any MyMRC
WRITE path (V2.1+, ADR-0009) · CSV/XLS manual reconciliation upload (exists,
T-016 — unchanged) · availability/capacity + native-report pages (not needed for P1).

## Consequences

- Three new mirror tables + one run-ledger table, all additive (ADR-0035 gate).
- The silent-empty failure class is structurally dead: every failure mode maps to a
  typed error, a ledger row, and (when it matters) a page — a green run with no
  data is impossible by construction.
- Fixture-based tests mean the suite never needs live portal access; live drift
  surfaces as `PortalContractDriftError` in production, not as a test gap.
- Hauls detail gives `expected_loads` real unit counts — the operator queue and the
  Q8 program-split pre-population (charter v0.10 primary path) start working.
- Two accepted risks: Aura envelope drift (mitigated: one module, typed error,
  ladder fallback) and portal-side throttling (mitigated: hourly cadence, ≤3
  concurrent detail fetches, sequential sites).

## Test plan (summary)

JSON mappers against captured fixtures (all three feeds + detail shapes) ·
`isLoginPage()` matrix incl. the 404 page fixture · upsert lifecycle (new / changed
/ disappeared / manual-row protection) · zero-anomaly + deadman + auth-fail paging
(mock ntfy, fingerprint + cooldown asserted) · run-ledger written on every path
incl. throw · detail-fetch retry on next run · migration clean-replay (CI gate).

## Post-acceptance note — survey finding (2026-07-03)

Rick Albritton (survey, dr3-intel-2026-06): "Re-Trac is the previous version of
MyMRC… A Re-TRAC ID simply refers to the unique Haul number or Material number
assigned to each inbound and outbound load through the MyMRC portal." So the
mirrors' `retrac_id` is expected to equal the portal's external Haul/Materials id
in current data — capture both fields anyway (nomenclature differs across the
workbook and the portal, and history may diverge), but ingestion maps them 1:1
unless the record detail shows otherwise.
