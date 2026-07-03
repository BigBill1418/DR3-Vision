# ADR-0041 — Invoice generation (the six-invoice set, offset-line math, events capture, Rick's approval gate, GP export boundary)

**Status:** PROPOSED — awaiting operator review (Bill)
**Date:** 2026-07-03
**Relates to:** mission record §3/§3.1/§4/§6-P2; Addendum B §B5 (rate constants), §B8 (two-artifact duplication this kills); ADR-0037 (operational data), ADR-0039 (billing trust gate), ADR-0040 (rates); survey build-inputs §C (Rick's flow + mid-month cutoff + trust bar)
**Series:** second of three P2 ADRs — 0040 rates (accepted, built), **0041 invoices (this)**, 0042 COR generator

## Context

Workstream A's core: Vision generates what Rick assembles by hand today from
"several spreadsheets" — and what the workbook silently under-reports through
sum-range drift (§4.1). Kelsey validates line-by-line against her parallel July
workbook (§7-c); Rick approves nothing he can't verify (survey Q9). Six invoices
per month: **CA** mid-month processing, EOM processing (with the explicit offset
line — the "$118,239 trade discount" artifact becomes an honest subtraction), EOM
transportation; **OR** EOM processing, EOM transportation, collection-site count.

## Decisions

### D1 — Invoice model: immutable versions, line-level provenance

```
invoices(id, site_id, kind enum(ca_processing_mid_month, ca_processing_eom,
         ca_transportation_eom, or_processing_eom, or_transportation_eom,
         or_collection_site_count), billing_month @db.Date, window_start,
         window_end, version Int, supersedes_id?, status enum(draft, approved,
         void), total_cents Int, generated_by, generated_at, approved_by?,
         approved_at?, …audit)
invoice_lines(id, invoice_id FK, line_code (e.g. 'B6','B7','B8','B20','B22',
         'B16.freight','B16.fuel','B16.rentals'), description, quantity
         Decimal?, rate_ref jsonb (which rule/tier/override row priced it),
         amount_cents Int, source jsonb (the query window + row ids/counts
         that produced the number), position)
```

Draft invoices regenerate freely (new version, prior draft voided);
**approved invoices are immutable** — corrections are a new version with
`supersedes_id`, both retained (the audit trail IS the point). Totals are
derived from lines at read; never hand-entered (Summary tab is "generated —
never hand-entered", mission §4).

### D2 — The math, §3.1 verbatim, all inputs already data

- **B6** processing = window's `processed_units_daily.stripped_program` ×
  effective `processing_rate` (program units ONLY — Rick's rule; NP never bills).
- **B7** = Σ `consumer_dropoffs.incentive_cents` (kind=incentive, paid in window).
- **B8** event misc = Σ per-event (driver hours × driver_hourly + labor hours ×
  general_labor_hourly + mileage + per diem + misc) — see D3.
- **B15** = B6+B7+B8. **B20** mid-month = stripped_program **1st–15th regardless
  of weekday** (Rick Q2, closes the open-register item) × rate. **B22 EOM =
  B15 − B20**, rendered as an explicit labeled offset line.
- **B16** transportation (separate invoice) = Σ `resolveFreightCents` over
  transport-charged inbound loads (provenance ref per load) + event freight +
  fuel surcharge (ADR-0040 `fuel.ts`: weekly EIA price, $5.05 trigger, per-load
  miles = `Source.canonical_mileage`) + Σ active `container_rental_sites`
  monthly rates.
- **OR**: EOM processing only (no mid-month structurally — kind enum has no OR
  mid-month value); transportation without fuel (structurally disallowed,
  already guarded); collection-site count = $2.25 × site counts. ⚠ OR
  collection-site count DATA has no capture surface yet (counts come from MRC's
  remote sites) — ships as a manual-entry line set with provenance
  `source=manual` until a feed exists; flagged in the open register.

### D3 — `collection_events` capture (the workbook Events tab, minimal)

```
collection_events(id, site_id, event_date, customer, county?, slip_number?,
    units Int?, freight_cents Int?, driver_hours Decimal?, driver_wages_cents?,
    labor_hours Decimal?, labor_wages_cents?, mileage Int?, per_diem_cents?,
    misc_cents?, retrac_id?, notes?, …audit)
```

Manager-scoped entry (site-scoped; same CRUD-lite pattern as outbound). Wage
fields default from the B5 rules (driver $125/hr, labor $90/hr, per diem $275)
but are stored as entered — events are irregular and the workbook stores actuals.
Kelsey's role in events was "provide the worker" (Janette Q5) — entry lands with
whoever runs the event; open register: confirm the owner.

### D4 — Generation gate + Rick's approval flow

Generating a non-draft (approvable) invoice for a window REQUIRES the ADR-0039
billing trust gate clean for that window (open findings above threshold →
generation refuses with the finding list; super-admin override with justification,
audited — ADR-0033 tripwire philosophy at month scale). The approval surface
renders every line with **drill-down to its source rows** (the D1 `source` jsonb
→ records), diff-vs-prior-version, and the window's audit findings inline.
Approval = `can_manage_rates` NOT sufficient — approver is manager-of-site or
admin, recorded with audit row. Approved invoices render to **xlsx** (exceljs —
already a dependency) matching the workbook Summary/parity structure, plus a
neutral **`invoice_export` JSON** (stable shape documented in the ADR) as the
Great-Plains boundary — the GP adapter itself stays blocked on Mary's packet
(open register), but the boundary ships now so the adapter is a consumer, not a
refactor.

### D5 — Parity acceptance (§7-c) and what "parity" means now

Acceptance = the §4 checklist line-by-line against Kelsey's July workbook for
the processing + transportation invoices and the Paid-Unpaid/Inbound tabs.
Commodities-block rendering is EXCLUDED from this ADR (the daily-log-9 →
billing-11 mapping is still pending Kelsey/Janette, B10-5) — the invoice set
doesn't need it; it joins the workbook-export surface when the mapping lands.

### D6 — Observability (standing directive)

Every line carries rate_ref + source provenance; generation writes one
structured log per invoice (window, line count, total, gate verdict) and one per
refused generation (finding count, codes); approval/void/supersede each audit +
log. A generated total of 0¢ for a window with nonzero processed units is a
typed error, never a silent zero (the ADR-0033 lesson at invoice scale).

## Out of scope

GP adapter (blocked on Mary — boundary ships here) · commodity→block workbook
export (B10-5) · COR (**ADR-0042**) · TONU handling (open register; Rick
mentioned it — needs a definition before it can bill) · rate/recovery alerts
(P3) · Re-TRAC/MyMRC submission of any invoice data (Vision feeds GP and MRC
paper flows; MyMRC entry stays the existing manual/1-day-deadline process).

## Consequences

- Three new tables (invoices, invoice_lines, collection_events), all additive.
- The two-artifact duplication (§B8) dies: the daily log IS the input; the
  invoice IS the output; nothing is maintained twice.
- Rick's typo class (survey Q8: "a typo in load number can delay payment") dies
  at the root — every number on an invoice is a query result with provenance.
- Two honest manual islands remain, both flagged: OR collection-site counts
  (no feed) and event actuals (irregular by nature).

## Test plan (summary)

Line-math matrix per invoice kind on fixture data (incl. B22 = B15−B20 exactness,
mid-month boundary Jun 15/16, program-only billing with NP present, zero-window
typed error) · freight/fuel/rentals composition with provenance refs asserted ·
gate refusal + override paths · version/supersede immutability (approved rows
reject mutation at service layer + audit) · xlsx snapshot vs parity fixture ·
export-JSON shape contract test · migration clean-replay (CI).
