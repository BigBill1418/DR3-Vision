# MyMRC JSON fixtures (ADR-0038)

These are **real** Salesforce Aura/UI-API payloads captured LIVE from the MyMRC
Experience Cloud portal on **2026-07-03** (account: **DR3 Woodland**), during the
ADR-0038 discovery task. They drive the JSON-mapper and transport-parse tests so
the suite never needs live portal access.

## Provenance & capture

- Captured inside `dr3-vision-app:local` (Playwright + chromium) on CHAD, logging
  in with the committed `selectors.ts` (SELECTOR_VERSION 2026-06-22) and
  intercepting the `/s/sfsites/aura` XHR the portal itself issues (read-only —
  list + record-detail navigation only; nothing was mutated).
- Transport actions the fixtures come from:
  - list feeds → `ListViewDataManagerController/ACTION$getItems`
  - record detail → `RecordUiController/ACTION$getRecordWithFields`

## Redaction

- **Person names removed.** Any `CreatedBy` / `LastModifiedBy` / `Owner` field and
  any nested `User` record had its `displayValue`/`value` replaced with
  `"[redacted]"`. No credentials, session tokens, or cookies appear in these
  payloads (they are datatable/record returnValues, not auth material).
- Business data retained (site names, vendor names, rate descriptors, dates,
  unit counts, material/haul numbers) — required for meaningful mapper tests and
  not PII.
- `recordIdActionsList` in the `getitems` fixtures was trimmed from the live 14–50
  rows to 5 for size.

## Files

| File | What |
|---|---|
| `aura-getrecord-haul.json` | `Haul_Request__c` record (H-133323) — hauls detail |
| `aura-getrecord-processed.json` | `Materials__c` Processing record (M-000300) |
| `aura-getrecord-outbound.json` | `Materials__c` Outbound record (M-000264) |
| `aura-getitems-{hauls,processed,outbound}.json` | list `getItems` returnValues (record ids + column metadata) |
| `aura-envelope-getitems-processed.json` | full intercepted Aura envelope (actions + context) for the transport-parse test |
| `login-404-page.html` | representative logged-out / 404 error page for the `looksLoggedOut()` (D4) test — hand-authored to the ADR-described shape, not a verbatim capture |
| `login-form-page.html` | the Lightning login form markup |
| `authed-shell.html` | minimal authenticated shell (negative case) |

When the portal redesigns, re-capture with a fresh discovery run and re-redact.
