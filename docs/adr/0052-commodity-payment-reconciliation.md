# ADR-0052 — Commodity Payment Reconciliation (v1, deliberately modest)

**Status:** Proposed — awaiting Bill's D1–D3 calls (presented 2026-07-16); build
starts on his answers
**Date:** 2026-07-16
**Directive:** `docs/handoffs/2026-07-16-personnel-wiring-daven-stetson-ap-approver-commodi.md`
§4, as corrected by §7 (production-state reconciliation of 2026-07-15)
**Owner (function):** Daven Stetson (`daven.stetson@svdp.us`), commodities, both sites
**Relates to:** ADR-0039 (audit engine — the aging check lands there), ADR-0043
(digest — the aging finding's notification path), ADR-0046 (Daven joins the AP
roster separately; explicitly NOT this ADR), ADR-0047 (rollout gate — the new
view is born `pilot`), ADR-0017 (admin-only account provisioning)

**Numbering note (handoff §7.4 rule):** the directive was written as "ADR-0049";
0049–0051 were consumed by the time of drafting (0049 workbook sync bridge, 0050
compliance admin ledger, 0051 office dark theme). Numbers are claimed at DRAFT
time against `docs/adr/` — 0052 was free there, so this ADR takes it. The two
registry rows that had penciled "ADR-0052" for undrafted docs (O-7
stewardship-fee, S-2 verbal capture) are corrected to "next free number at
draft time" in the same change that lands this file.

## Context

Outbound commodity loads (metal, foam, wood, …, both sites) are sold to buyers
(SA Recycling, Miller Waste Mills, …). `outbound_materials` captures the
operational fact of each shipment — but nothing tracks whether each load was
ever invoiced to the buyer or paid. Kelsey reconciled this by hand against
MyMRC/billing data; the function lapsed unowned at her transition and sits as
the parked "payment-confirmation depth: define later" register item. Bill has
assigned the function to Daven Stetson. This ADR resolves that register item.

## Decision (v1 scope)

1. **Payment-tracking companion table** — a separate table, FK per
   `outbound_materials` load. The operational capture row is NOT widened;
   operational capture and financial reconciliation stay separately owned
   facts. Columns: buyer invoice/reference #, expected amount
   (`Decimal` — optional at v1, see D2), payment-received date, status,
   notes, plus provenance (who/when) on every status change.
2. **Status state machine:** `awaiting_invoice → invoiced → paid`, with
   `disputed` reachable from `invoiced`/`paid`-pending states. Statuses are
   append-only in the audit log (house pattern); no deletes, corrections are
   forward transitions with provenance.
3. **Manual entry at v1.** Daven keys invoice references and payment receipts
   by hand. No bank feed, no OCR, no remittance parsing.
4. **Daven-facing reconciliation view:** commodity loads by payment status,
   both sites, with **aging** (days since ship; days since invoiced) and CSV
   export. Born `pilot` per ADR-0047; Bill flips it live after Daven validates
   it against his own records for one week.
5. **One new audit check** on the ADR-0039 engine: unpaid/uninvoiced beyond a
   configured threshold (see D1) emits a finding through the standard finding
   lifecycle. Born under leg-liveness bootstrap gating like every
   missing-counterpart check; notification rides the ADR-0043 digest — **no
   new email path**.
6. **Money edges:** `Decimal` boundary rules at every money edge (no float
   anywhere between DB and render).

**Out of scope v1 (candidate v2 once Daven has used it ~a month):** remittance
parsing, buyer portals, price-per-lb validation against contracts.

**Explicit non-scope:** Daven's AP-approver roster membership (ADR-0046 data
change, handled with his onboarding) and the MRC invoice approval gate (Rick's
billing trust gate is unchanged; Daven is not on it).

## D-items for Bill (answers finalize this ADR → Accepted)

| # | Question | Proposed |
|---|----------|----------|
| D1 | Aging thresholds for the audit check | **30 days** since ship without invoice; **45 days** since invoice without payment (both config, not code) |
| D2 | Is expected-amount required at `invoiced`? | **Optional** — don't block Daven's entry on a number he may not have; the check can flag `paid` rows with no amount later |
| D3 | Aging check emits per-load findings or per-buyer rollup? | **Per-buyer rollup** — one finding per buyer per run listing its aging loads; less digest noise, matches how Daven will actually chase payment (by buyer, not by load) |

## Consequences

- One additive migration (new table + enums; ADR-0035 clean-replay, lexical
  ordering after the latest migration at build time).
- `outbound_materials` remains untouched — buyers keep selling-side facts out
  of the operational row.
- The audit engine gains its first money-side liveness check; if v2 price
  validation arrives it slots in as more checks, not a new mechanism.
- Daven's view is the template for future single-owner reconciliation
  surfaces (small table + aging view + one engine check + digest).

## Sequencing (handoff §6 as corrected by §7.3)

Account seeding + E0 roster + AP roster membership: immediate (AP is LIVE —
roster addition = live traffic same day, onboarding note pairs same-day).
This build: after Bill's D1–D3 answers; does not preempt staged go-live work.
Ramp: Bill flip after Daven's one-week validation.
