# ADR-0009: MyMRC integration via Playwright

**Date:** 2026-05-04
**Status:** Accepted (with deferred reconsideration on API access)

## Context

MyMRC is the Mattress Recycling Council's vendor portal, built on Salesforce Experience Cloud. DR3 must:
- See scheduled hauls coming in (so operators know what to expect)
- Submit completed hauls back (so MRC can pay us)
- Reconcile our records against MRC's records monthly

Two paths were considered:
1. **REST API** — Salesforce supports `/services/data/vXX.0/sobjects/` endpoints
2. **Browser automation (Playwright)** — log in, navigate, scrape

We tested the API path on 2026-05-04. Both cookie auth and bearer-from-cookie returned `401 INVALID_SESSION_ID`. The DR3 user lacks the "API Enabled" permission. We have asked MRC to enable it via email but have no commitment.

We need to ship integration before MRC's response, if any.

## Decision

Use **Playwright** for both directions of the MyMRC integration in MVP.

### Architecture
- Two Playwright contexts, one per site (Eugene + Woodland), with separate credentials stored in environment variables
- Hourly cron job: log into MyMRC for each site, navigate to "My Hauls", scrape the next 7 days of scheduled hauls, upsert into the `expected_loads` table
- For V2.1 write-path (push completed loads back into MyMRC): an event-triggered job that opens MyMRC, navigates to the haul, and updates the recycler-reported fields

### Reliability strategy
- Each scrape session is wrapped in retry-with-exponential-backoff
- Failures fire ntfy `dr3-vision-system` to Bill (this is one of the two ntfy-eligible event types)
- The Playwright code logs every navigation step to Loki for debugging
- Scrapes are idempotent — re-scraping the same window doesn't duplicate

### Auth state
- Storage state persists between scrape runs (so we don't re-login every hour)
- Auth refresh: detect login redirect, re-authenticate, retry
- Credentials are rotated per fleet conventions

### Failure modes
- **MRC changes the page structure:** scrape selectors live in a separate, well-commented file (`src/integrations/mymrc/selectors.ts`) for fast updating
- **MRC adds CAPTCHA / 2FA:** would block this approach entirely; fallback is the manual CSV reconciliation path (T-016 in Sprint 1)
- **MRC enables API access** (deferred): Sprint 2+ migrates to REST API, supersedes this ADR

### Manual fallback
The CSV reconciliation upload (T-016) does not depend on Playwright. It accepts MyMRC's manual CSV export and reconciles. If Playwright breaks for an extended period, this is the bridge.

## Alternatives considered

- **REST API path** — preferred long-term, blocked on API access permission. Will reconsider on MRC response.
- **Manual data entry only** — defeats the purpose of integration; operators would type the same haul twice (once into MyMRC, once into DR3-Vision)
- **Email-based scraping** — MRC sends haul confirmations via email; could parse those. Rejected as fragile (subject-line changes break it) and one-directional (read-only).

## Consequences

- Sprint 1 includes Playwright runtime in the production container, ~300MB of browser binaries. Container size impact is acceptable.
- Playwright runs server-side, never in the browser. No iPad-side scraping.
- This integration breaks if MRC redesigns their portal. We have committed to fast detection (ntfy alerts) and fast response (selectors in one file) but not zero downtime.
- The selectors file is the most fragile part of the codebase. Treat changes to it with extra review.

## References

- Charter §6.5 (MyMRC integration), §11 (Open decisions, deferred section)
- `docs/MYMRC-INTEGRATION.md` for the operational runbook
- 2026-05-04 API test result (in transcript): both auth methods returned 401
