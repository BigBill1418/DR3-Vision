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



---

## 3. MRC billing architecture (locked)

Billing basis is **processed units, not inbound** — the workbook's Summary bills `D9 (Program Units Processed) × rate`; inbound totals are reference context. In Vision, processed counts come from the daily-close processed-materials data (office desktop entry, super-admin gated; iPad flow untouched by billing). Rates and program rules live in `state_program_rules`, never in code or formulas: CA processing **$16.50/unit** (mid-month + end-of-month invoices); OR processing **$17.00/unit** (end-of-month only); OR satellite collection **$2.25/unit**; CA collector incentive **$3.00/unit** (currently hardcoded `=E×3` in the workbook — migrate to rules); **OR fuel surcharge structurally disallowed** via `state_program_rules`; CA fuel surcharge allowed (formula pending Kelsey capture). Six invoices/month across CA+OR. Transportation bundles invoice **separately** from processing per state. Vision feeds **Great Plains** (integration path pending Mary); the QuickBooks "$118,239 Trade Discount" on prior Woodland invoices is **not a discount** — it is the end-of-month invoice's subtraction of the already-billed mid-month amount (`EOM = month total − mid-month`), a template artifact Vision renders as an explicit offset line.

### 3.1 Invoice math decoded (Summary tab, generated by Vision going forward)

- Processing (monthly): `B6 = ProcessedUnits × 16.50` · `B7 = Σ collector incentive payments` · `B8 = event misc (driver wages + labor wages + mileage + per diem + misc)` · `B15 = B6+B7+B8`
- Mid-month: `B20 = midMonthProcessed × 16.50` · EOM processing: `B22 = B15 − B20` (the offset line)
- Transportation (invoiced separately): `B16 = freight + event freight + fuel surcharge + container rentals`
- Container rentals: flat monthly site rate table, ~40 CA collection sites at $300/$400/$500/$600/$1,200, currently totaling **$10,500/mo** — implement as `container_rental_sites(site, description, monthly_rate, active)`, Rick-maintained (manager-scoped write)

## 4. Workbook parity checklist — `MRC_Woodland_July_2026.xlsx` → Vision

Acceptance for Workstream A: every cell class below reproducible from Vision data. Kelsey validates line-by-line during July.

| Tab | Columns | Vision source |
|---|---|---|
| Inbound Trans (hauls w/ transport charge) | Date, Customer, Slip #, Units, Re-TRAC ID, Freight, Fuel | `inbound_loads` where transport_charged; freight/fuel as load-level charges |
| Inbound (no transport charge) | Date, Customer, Slip #, Units, Re-TRAC ID | `inbound_loads` where not transport_charged |
| Paid-Unpaid (left block) | Date, Dropped-off-by, Slip #, Check #, Units, Incentive $ | public drop-off loads, `incentive = units × rules.incentive_rate`, ≤5 units/day/person program cap |
| Paid-Unpaid (right block) | Date, Customer, Slip #, Units | unpaid public drop-off loads |
| Events | Date, Customer, County, Slip, Units, Freight, Driver Hrs/Wages, Labor Hrs/Wages, Mileage, Per Diem, Misc, Re-TRAC ID, Notes, Fuel | events module (new): collection-event records with cost components |
| Container Rentals | Location, Trailers, Trailer Size, Monthly $ | `container_rental_sites` rate table |
| Summary | all | **generated** — never hand-entered |
| Commodities (11 horizontal blocks) | per block: Date, Lbs, Ticket #, Re-TRAC ID; +`%` on Steel/Biomass/WTE; +Bale Count & avg/bale on Toppers/Foam; Landfilled Units block: Date, Unit, Qty, Slip # (bed bug / soiled / water-logged / other) | `outbound_materials` + `ticket_number`, `retrac_id`, `bale_count`; commodity taxonomy: Landfill, Steel, Biomass, WTE, Wood, Toppers, Foam, Cardboard, Plastic, Cotton, Landfilled-Units; `%` semantics pending (2.2 #2) |
| Inbound Non Program Units | Date, Customer, Units, Slip, Re-TRAC ID | segregation ledger — program/non-program split is compliance-critical for Woodland co-processing post-Stockton |
| Out Bound To Renovators | Date, Buyer, DR3 #, Re-TRAC ID, Whole Units, Wood/Steel/Foam lbs | distinct renovator channel (≠ commodity load); include in recovery-rate math per MRC rules |

**Re-TRAC ID appears on every record type in the workbook — treat as universal external join key.**

### 4.1 Template defects this build eliminates (motivation, verbatim into module docs)

The live workbook silently under-reports through sum-range drift: fuel totals only rows 4–70 while freight/units total through row 130 (**fuel entered in rows 71–130 vanishes from the transportation invoice**); paid drop-off units sum to row 47 but incentive payments to row 48; the Non-Program tab totals rows 2–21 of a 46-row sheet. Nobody erred — this is inherent spreadsheet fragility. DB-backed generation eliminates the defect class; the retro-audit (P1) should also check *historical* workbooks for money already dropped.

## 5. COR generator (Exhibit 5 — Certificate of Recycling, Employment and Inventory)

Monthly, per CA facility, currently hand-written. Vision pre-fills: month covered; **unprocessed units in inventory at month close** from `site_inventory_snapshots` (anchor: June 2026 Woodland = **4,062 units** — Vision's Pool-A snapshot must reproduce this number at close); **FT/PT headcount** from the daily total-facility-headcount field (June's handwritten count is ambiguous — reads 15 or 18 — precisely the defect generation eliminates); signer block standardized to **Rick Albritton** (title TBC with MRC). Certificate is signed **under penalty of perjury — Vision pre-fills and renders; a human always reviews and signs; Vision never auto-certifies.** Daily close remains a button click with an audit row; inventory cap warnings stay warn-only at 90%/100%, never blocking.



---

## 6. Build plan & sequencing

**Phase 0 (Bill, ops — not Claude Code):** deploy pending P0 payroll guardrails after verifying Eugene P13 signature state; iPad rollout per §8. Deploy precedes new schema work landing in prod.

**P1 — 3-way audit + foundations.** Finish the loads/inventory/reporting buildout **CA-first** per the readiness checklist in the 2026-06-22/23 handoffs, including the MyMRC ingestion rebuild (portal is now Salesforce-based; login solved, ingestion pending). Then the reconciliation layer: daily logs ↔ MyMRC ↔ billing data, auto-flagged mismatches with a discrepancy review surface. **Hard requirement: retro-audit** — the module must run over any historical window (the accepted 8/1→ship coverage gap, and prior months' workbooks per §4.1). This is P1 because Bill accepted the audit gap on the explicit condition the module ships ASAP.

**P2 — Billing generation.** Invoice set (§3.1: CA mid-month, CA EOM with offset line, CA EOM transportation; OR EOM equivalents), container-rental table + Rick's manager-scoped write, COR generator (§5), billing-ready Great Plains export (adapter design blocked on integration-path answer; build the export boundary now, adapter later). Acceptance = §4 parity checklist.

**P3 — Alerts.** Recycling rate (exists on compliance dashboard), recovery rate (include renovator channel per MRC rules), missing-record detection; configurable thresholds; alert CA team in-app + email digest. ntfy remains Bill-only.

**P4 — Terex module.** Throughput derived from processed-materials; cost entry surface; trend view for equipment strategy.

**P5 — Task ledger + Updates digest + contact-form routing.** Meeting notes, assigned tasks, auto-reminders; digest generation (Morena sends); website contact-form intake with tours→Rick routing.

**P6 — CalRecycle + DTSC report generation.** Blocked on data specs (Kelsey capture / open register). Build when specs land.

**P7 — Manager self-serve operator creation.** Site-scoped, operator-role-only carve-out from ADR-0017's admin-only gate; reuses `setPin()` and the audit pattern; every other admin surface stays 403. Follow-up from the 07-03 RBAC finding.

**Vendor-invoice approval workflow** (any phase after P1): Morena + Janette, first-action-wins atomic transition, reuse existing approval machinery, full audit.

## 7. Acceptance — anchored to Kelsey's validation window (~07-09 → 08-01)

(a) Woodland iPad inbound data matches Kelsey's manual audit for the overlap period — every discrepancy she flags is triaged as bug or business rule and resolved or documented. (b) July COR generates with inventory tying to the Pool-A snapshot and headcount from the daily field. (c) Parity checklist (§4) validated line-by-line against the July workbook she keeps in parallel. (d) Retro-audit reproduces her known June/July findings. Her sign-off is the acceptance test; after 08-01, acceptance falls back to parity-checklist + retro-audit evidence.

## 8. iPad rollout runbook (Bill-owned ops; recorded for context)

Woodland go-live **~07-08/09**: Bill seeds operator accounts from Janette's roster (name, locale en/es/ur, processor role) via `/admin/users` (admin-only per ADR-0017); mounts, PWA install, per-device iPadOS language; **straight cutover after one supervised test load including the offline ride-out test** (wifi off mid-load → complete → sync verify; no paper fallback exists by design). Interim procedure until MyMRC ingestion rebuild: Janette manually enters expected hauls each morning via "Schedule a load" (`source=manual`, scrape-overwrite-protected); program/non-program split entered at verify (shipped fallback; verify gate enforces the math — doubles as the MRC segregation documentation for co-processed Stockton-redirect volume). Eugene follows ~week of 07-20, same runbook, Rick's roster.

## 9. Survey ingestion (follow-up input, not a gate)

Campaign `dr3-intel-2026-06` closes **Monday 2026-07-06** after Mary Scott submits; Leisha Wallace unsubmitted-by-design (export includes submitted invites only). Export lands at `docs/operations-intel/dr3-intel-2026-06/` via ClaudeSync draft PR — **merge required before findings are readable.** Fold into open items: CA mid-month cutoff rule (Rick), DR3#/Material# sequences (Janette), fee schedules + Re-TRAC cadence (Kelsey), GP path (Mary), floor-level insights (Juan, Patrick), plus every "What are we missing?" answer. Amendments to this document from survey findings arrive as follow-up commits/appends.

## 10. Constraints (non-negotiable, from charter + ADRs)

Decimal boundary rules at every money/weight edge · migration ordering + clean-replay invariant (ADR-0035) · audit-log invariants: rows never deleted, secrets never serialized (ADR-0007/0017) · no `<form>` — `onClick` handlers (hard rule #10) · rates/program rules in `state_program_rules`, never code · OR fuel surcharge structurally impossible · i18n via ADR-0015 loader pattern; operator surfaces en/es/ur · new schema/architecture decisions get their own numbered ADRs (0037+); this document is the mission record, not a substitute for ADR discipline · readiness-checklist gates from the 2026-06-23 handoff apply before any loads-feature activation beyond what is already shipped.

**End of mission record. Claude Code: read §6 order, propose the P1 implementation plan as ADR drafts before writing code, and treat §7 as the definition of done.**
