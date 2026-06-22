# MyMRC Portal Redesign — 2026-06-22 (scraper rediscovery)

MRC redesigned the Salesforce Experience Cloud partner portal sometime after the
2026-05-06 SELECTOR_VERSION. The old scraper **silently failed** against it
(landed logged-out on a 404, parsed 0, reported "ok"). This documents the current
portal as re-discovered with a live session, so the scraper rebuild + the
loads/inventory build can proceed.

## Login (FIXED — committed in `selectors.ts`, SELECTOR_VERSION 2026-06-22)

- Login URL unchanged: `https://mrc-us.my.site.com/s/login/`
- The Lightning login form lost its `name` attributes. Working selectors:
  - username: `input[placeholder="Username"]`
  - password: `input[type="password"]`
  - submit:   `button:has-text("Log in")`  (it is `type=button`, not submit)
- **No MFA.** Credentials in `~/.dr3-vision-secrets/mymrc.env` are valid (verified
  login as "Bill Barnard, viewing as DR3 Woodland", 2026-06-22).
- `isLoginPage()` still needs hardening: it must also treat a 404 / logged-out
  error page (title "Error", body "404 Error… Log in") as not-authenticated, or
  silent failure can recur.

## Account model change

Old: one URL per recycler via `?recycler=DR3+Woodland`. New: the recycler account
is scoped by the **logged-in credentials** (the page shows "viewing as DR3
Woodland" + a "Switch Account" control). Per-site service accounts
(`MYMRC_WOODLAND_*` / `MYMRC_EUGENE_*`) each log into their own account. The
`?recycler=` query param is gone.

## Data pages moved + expanded (was just `/s/scheduled-hauls`)

| Nav | URL | Shape (Lightning datatable) |
|---|---|---|
| Hauls | `/s/hauls` | Haul ID, Status, Rate ID, Docking Appointment (date/time/door), Recycler. Tabs: All / Docking Appointments / Completed. ~15 rows. |
| Processed | `/s/processed-materials` | Materials ID, BOL ID, Entry Date, Processed Date, Recycler. 50+ rows. |
| Outbound | `/s/outbound-materials` | Materials ID, Entry Date, BOL ID, Outbound Vendor, Recycler. 50+ rows. |
| Availability | `/s/availability` | capacity |
| Reports | `/s/report/Report/Recent` | native Salesforce reports |
| Build a Haul | `/s/request-haul` | request inbound haul |

These three (Hauls = inbound, Processed, Outbound = out) are the inventory feed:
**on-hand = inbound − outbound/processed**, reconciled to periodic physical counts
(operator-chosen inventory model).

## Recommended ingestion approach

The data pages are **Lightning datatables (Aura-loaded)**. DOM scraping is fragile
(this redesign is the second break). Prefer hitting the **Salesforce Aura / UI-API
endpoints with the authenticated session** (capture the XHR the datatable issues to
`/s/sfsites/aura` or the list-view UI-API) — far more durable across redesigns, and
gives clean JSON instead of scraped cells. The per-record detail (weights / unit
counts that feed inventory) is on each Haul/Materials record, not the list view.

## Parser status

`parser.ts` (`parseScheduledHaulsHtml`) targets the OLD table and will not parse the
new datatables — needs a rebuild as part of the loads/inventory implementation.
