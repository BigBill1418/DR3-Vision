# ADR-0036 — Build Mission: Operations Continuity, MRC Billing Automation & iPad Inbound Rollout

**Date:** 2026-07-03
**Status:** Locked decision record + build mission (promote schema/architecture decisions to numbered ADRs during implementation; 0036 is reserved for this record)
**Decided by:** Bill Barnard, sessions 2026-07-02 → 2026-07-03
**Supplements:** PROJECT-CHARTER.md; ADR-0017 (admin user seeding); ADR-0028 (amendment workflow / separation of duties); ADR-0033 (payroll reconciliation guards); ADR-0034 (survey system); ADR-0035 (migration ordering); `docs/handoffs/2026-06-22-mymrc-sync-loads-inventory-reporting-buildout.md`; `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`

---

## 1. Mission

Kelsey Ruhland (Data & Compliance lead, MRC contract SME, Vision admin) transfers back to regular SVdP duties **2026-08-01**. This build absorbs every automatable function of her role into DR3-Vision and assigns the human residual to named owners, so her departure costs the organization nothing. Three workstreams:

- **A. MRC billing automation** — replace the monthly Woodland billing workbook (`MRC_Woodland_July_2026.xlsx` structure, §4 below) and generate the monthly Certificate of Recycling (Exhibit 5) from Vision data. Vision feeds Great Plains, not PDFs/QuickBooks.
- **B. Vision capability expansion** — 3-way audit reconciliation (P1), rate/recovery alerts, Terex module, CalRecycle/DTSC report generation, meeting task ledger, DR3 Updates digest, website contact-form routing.
- **C. iPad inbound activation** — Woodland go-live ~2026-07-08/09, Eugene ~week of 07-20 (ops actions owned by Bill; software is already shipped and in production).

Claude Code executes A and B from this document. Success is anchored to Kelsey's validation window (§7).

## 2. Locked decision record

### 2.1 Function dispositions (Kelsey's ~21 functions)

**Vision builds:** (1) CA 3-way audit: daily logs ↔ MyMRC ↔ billing, auto-flag mismatches — her single biggest time cost, **build priority P1**; (2) recycling rate / recovery rate / missing-records tracking with **auto-alert to CA team on threshold breach**; (3) Terex throughput + cost module — build now; (4) inbound/processed/outbound tracking **CA-first**, OR follows; (5) CalRecycle annual + CA DTSC reporting — Vision builds and creates it all; data specs pending (open register); (6) DR3 Updates digest auto-generated, **Morena owns the send**; (7) weekly meeting notes + task ledger + auto-reminders; (8) website contact-form auto-routing, **tours route to Rick**.

**Hybrid:** vendor-invoice approval (accounting's review/approve/reject emails) delegated to **Morena AND Janette, either approves, first action wins** — implement as an atomic state transition reusing the existing approval machinery; both attempts audited. Commodity-load payment-confirmation depth: define later (open register).

**Pure delegation (no build):** LEAN coordination w/ MRC → Morena. Fire code (Woodland) → Morena/Janette. CIP coordination → per-state: Rick (OR), Morena (CA); no Vision piece. Licenses/renewals cluster (business registry, city licenses, county assessments, CERS) → delegate whole to one person, owner TBD; **explicitly not a Vision calendar build**. Stockton weekly MRC report → Kelsey covers through Vendor Agreement expiration **2026-07-11**; expires with Stockton closure, no build. Prairie Road tours → Rick.

### 2.2 Decisions locked 2026-07-03 (one-by-one session)

| # | Decision | Call |
|---|----------|------|
| 1 | Survey close vs. Mary Scott's pending response | Campaign stays **open**; responses pulled via SQL now; **close Monday 2026-07-06 after Mary submits**; export lands complete |
| 2 | `%` column semantics on Steel/Biomass/WTE outbound blocks | **Kelsey July capture list** — do not schema until answered; carry nullable `allocation_pct` placeholder if blocking |
| 3 | Standing signer, Vision-generated Woodland COR | **Rick Albritton** — certification stays with MRC billing ownership; standardize name/title block (title TBC with MRC; June COR reads "Transportation Manager") |
| 4 | Interim manual 3-way audit owner, 8/1 → module ship | **None — gap accepted.** Module promoted to P1; must support **retro-audit over the gap window** (detection delay, not data loss) |
| 5 | CA vendor-invoice approver | **Both Morena and Janette, first action wins** (atomic) |
| 6 | Container-rental rate table maintenance | **Rick** — requires **manager-role write access scoped to Rick**, not super-admin-only |
| 7 | MRC point person (Sam, Justine, Amanda Wall, Darcy) + CA/OR data meetings | **Bill, interim; reassess after build lands** |

### 2.3 Vision access changes

Patrick Dills inherits Eugene bonus ops-signer + all-sites visibility **after Kelsey's 8/1 departure**. ⚠ **Documented conflict, acknowledged by Bill:** ADR-0028 deliberately carved Patrick out read-only for separation of duties — he is a bonus-earning Eugene processor and would counter-sign payroll he is paid from. Alternatives (Shannon Rockwell; Bill) were presented and declined. Implementation must log this override in the audit trail and the ADR that executes the role change. Kelsey's account deactivates per ADR-0017 flow after the validation window closes and her final Stockton report (07-11) is filed.

### 2.4 Open register (deliberately undecided; none block the build)

Accounting liaison / Mary Scott–Great Plains relationship (Bill: "more challenging" — TBD). Licenses/renewals cluster owner (capture renewal dates from Kelsey in July). Dispatch inbox (delegate vs. Vision queue). "Various admin" catch-all. Commodity-load payment-confirmation depth. CalRecycle/DTSC data specs (Kelsey). Great Plains integration path — eConnect vs SmartConnect vs Integration Manager (Mary's survey packet, Monday; backstop: Kelsey/Mary/controller conversation in July).

### 2.5 Kelsey July capture list (knowledge extraction before 8/1)

OR fee schedule detail · CA fuel-surcharge formula (not present anywhere in the workbook — entered as raw values; formula exists only in her head or a side sheet) · `%` column semantics (2.2 #2) · Re-TRAC and CalRecycle filing mechanics · MRC contact map (who to call for what) · 30-minute written description of **what her manual 3-way audit compares and the known failure points** — spec input for P1, not a human runbook · GP integration backstop if Mary's packet is thin.
