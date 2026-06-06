# DR3-Vision — Project Charter

**Project name:** DR3-Vision
**Service code:** `dr3-vision`
**Public domain:** `dr3-vision.svdp.us` (CF Access for staff; PWA installable on iPad)
**Tenant:** SVdP (`*.svdp.us`)
**Fleet host:** CHAD-HQ (joins SVDP-Guardian, SVDP-Intranet, SVDP-Site)
**Repo:** `BigBill1418/DR3-Vision` (existing — V1 PHP code archives to `legacy/`; V2 scaffolds at root)
**Operator:** Bill Barnard — Director of Operations, DR3 / SVdP Lane County
**Charter version:** 0.30 — living document
**Last reviewed:** 2026-05-04
**Build target:** Claude Code (this charter is the briefing doc; implementation happens in a Claude Code session against `BigBill1418/DR3-Vision`)

### Changelog

- **v0.30 (2026-05-04)** — Three secondary build questions resolved. **Q22 (weight ticket precision):** integer pounds, US trucking standard, validated > 0 and ≤ 100,000 (DOT max gross is 80,000; values outside surface a soft warning requiring manager confirmation). `weight_lbs` typed as `INTEGER`. **Q23 (audit log retention):** retained indefinitely, no pruning. Independent of contract retention rules (CA 4yr / OR 5yr apply to load records and photos only). **Q24 (deployment rollout):** both sites simultaneous on day 1, no staggered launch — affirms the v0.2 decision. With these answered, all 21 primary build questions plus 3 secondary questions are banked. Charter is ready as briefing doc for Claude Code; pivoting to deliverables.
- **v0.29 (2026-05-04)** — Q21 resolved: **4-digit PIN** (not 6), 5 attempts → 15-min auto-unlock lockout, disallow obvious patterns (sequential, all-same, repeated-pair), unique within site / reusable across sites, manager-resettable, admin-resettable, audit-logged. Repeat-lockout indicator on Compliance dashboard for training-signal detection. **WiFi confirmed good at both Eugene and Woodland docks; iPads also have built-in cellular service** as automatic two-path fallback — open decision #3 closed. Q20's no-paper-fallback decision is significantly de-risked: the iPad has two independent network paths, so realistic offline windows are short. §5.8 updated. Open decisions section renumbered.
- **v0.28 (2026-05-04)** — Q20 resolved: **offline queue only, no paper fallback**. Pattern C (IndexedDB + Workbox Background Sync) is the sole outage strategy. No printed paper-form binders, no paper-recovery flow in the manager portal, no `recovery_source=paper` audit field. Trade-off: simpler operations and no paper-data-sync risk, but higher dependence on cache durability and offline-queue robustness — these become MVP-day-1 quality gates rather than nice-to-haves. New §5.8 documents the strategy. New risk row added: PWA cache unrecoverable.
- **v0.27 (2026-05-04)** — Q19 resolved: **Woodland holidays = same six as Eugene** (New Year's, Memorial, Independence, Labor, Thanksgiving, Christmas). `site_holidays` seeded identically for both sites at deployment. **Bonus formulas captured for ADR-0011** (V2.1 Processor Form workflow): Eugene daily bonus = `MAX(units−50, 0) × $1.00 + MAX(units−100, 0) × $0.25`; Woodland daily bonus = `MAX(units−50, 0) × $0.50 + MAX(units−75, 0) × $0.25`. Same formula shape (two-threshold, two-rate, additive) but materially different parameters per site. `processor_bonus_rules` table sketched. Eugene tracks processor roles (Lead, Processor, Machine Operator, Stryo, Floater); California tracks bare names. Eugene reports monthly bonus dollars only; California reports both bonus dollars and monthly processed total.
- **v0.26 (2026-05-04)** — Q18 resolved: **no mid-load shift handoff at the dock**. Pattern A confirmed — operator who starts a load owns it through completion; staff stay until the truck is done. No partial-session schema, no stack-count handoff UI, no split-credit logic. Manager-portal reassignment (Q10) exists only as an exception escape hatch. §4.3 timing instrumentation updated to reflect this. Note: the V2.1 deconstruction-line workflow does support shift-spanning by design (per the Processor Form's "leftover" carry-over) — but inbound dock unloads do not.
- **v0.25 (2026-05-04)** — **Daily Processor Form discovered as a major V2.1 workflow.** Bill provided the current paper form (one per processor per shift per day) used to track deconstruction-line activity. Captures stack ledger, per-unit material tally (foam/fiber/steel/wood/fabric/disposed), saved-for-reuse counts, leftover carry-over, and lead verification. Critical because: (1) feeds the **1-business-day MyMRC processed-units deadline** — the tightest contract reporting requirement; (2) drives **processor bonus pay calculation** — payroll-adjacent; (3) generates the data behind the 75%/70% recycling rate and 97% inbound/outbound reconciliation. Promoted from a single bullet to a full V2.1 workflow with dedicated ADR-0011. MVP scope unchanged (still inbound-only) but schema design must support the eventual reconciliation between inbound `total_units` and downstream `processed + saved + leftover`.
- **v0.24 (2026-05-04)** — Q17 resolved: **no additional users for MVP**. Five named users only (Bill, Kelsey, Morena, Rick, Janette). Three roles only — `read_only` is not added. **Sacramento replaces Woodland, not adds to it** — when consolidation completes, Woodland closes and Sacramento inherits Woodland's California program/contract/manager. DR3-Vision has at most two active sites at any time. Site lifecycle managed via `sites.is_active`; closed-site historical data remains accessible read-only per 4-year CA retention requirement.
- **v0.23 (2026-05-04)** — **ntfy routing tightened: Bill only.** Kelsey, Morena, and site managers (Rick, Janette) do NOT receive ntfy push. Operational events are dashboard-driven exclusively. Only system events (`dr3-vision-system`) and container events (`dr3-vision-container`) trigger ntfy, and those go only to Bill. Updated rejection branch alert routing, storage-limit risk, Kelsey persona, and open decision #9. This is a refinement of the Q16 policy from v0.21.
- **v0.22 (2026-05-04)** — **Kelsey Ruhland** (kelsey.ruhland@svdp.us) added as named admin persona — DR3 Data & Compliance lead, MRC contract SME for all locations. Co-primary user of the Compliance dashboard alongside Morena (operations lens vs. data/contract lens). Routes for any contract-interpretation, CPI/rate change, or reporting-requirement question. Two admin users now: Kelsey + Bill.
- **v0.21 (2026-05-04)** — Three things at once: (1) **Oregon contract reviewed and integrated.** Open decision #2 resolved. Eugene operates under MRC Oregon LLC, Oregon DEQ regulator, SB 1576 (2022). Material differences from California: 70% recycling rate (vs 75%), 6,000 total on-site storage (vs 3,500/5,000 split), off-site storage prohibited, 60-day processing deadline (vs 45), 5-year records retention (vs 4), $17 flat 2025-2027 (vs CA's $16/$16.50/$17 progression), customer service hours 8:00am–4:00pm (vs CA 8:30am–4:30pm), no Consumer Incentive Program in Oregon. Same SLAs apply: 60-min dock, 97% reconciliation, 3-business-day inbound, 1-business-day processed-units, 10% withhold for breaches. ADR-0005 and ADR-0007 retention updated to per-program (CA 4yr / OR 5yr). Risk table updated with both jurisdictions. (2) **Q16 — alert routing corrected.** ntfy is reserved for **system + container events only** (`dr3-vision-system`, `dr3-vision-container`). Operational events (rejections, long unloads, dock SLA breaches, concerns, PIN lockouts) are **in-app dashboard signals only**, not phone push. Updated throughout: rejection branch, dock SLA tracking, Compliance dashboard, MVP scope, fleet checklist, risk table. (3) **Site facility managers named:** Rick Albritton (Eugene), Janette Thomas (Woodland). §3 Users updated. Open decision #9 added for their contact info / preferred system-alert channels (deployment-time detail, not blocking).
- **v0.20 (2026-05-04)** — Q15 resolved: polling-based manager portal for MVP. 5-second refresh on live dock view; 30-second on load list; on-demand elsewhere. Per-site polling (consistent with v0.19 separation principle). New §5.7 documents the refresh strategy. Architecture allows future swap to SSE/WebSockets without API contract changes — likely upgrade trigger is V2.1 cast view on an office TV.
- **v0.19 (2026-05-04)** — **Critical correction:** Eugene and Woodland are **fully separate** — separate contracts, separate programs, separate MyMRC portal sections, separate billing cycles, separate rate cards, separate regulatory regimes. Strict-separation principle now enforced as foundational architecture: every query, list, export, alert, and dashboard metric is per-site by default. Cross-site roll-ups exist only for admin role. MyMRC integration is per-site (two Playwright login contexts, two credential sets). California contract clauses **no longer assumed to apply to Eugene** — Oregon-specific values default to "pending" until contract is reviewed. Two new billing artifacts captured: (1) standalone MRC Transportation Invoice (CA shown — Transportation $52,775 + Container Rental $9,600 + Fuel Surcharge $4,002.07 = $66,377.07), (2) **Oregon Collection Site Count Invoice** — new revenue stream where Eugene gets paid $2.25/unit for counts at Oregon collection sites (Salem, Albany, Cottage Grove, Florence). Added to V2.2 roadmap as separate workflow.
- **v0.18 (2026-05-04)** — Q14 partially resolved + **major scope clarification**: DR3-Vision operates under **two parallel state programs** — California (Woodland, $16.50/unit, mid+end-month billing) and Oregon (Eugene, $17.00/unit, end-month-only billing). Both administered by MRC but separate contracts. §1.5 restructured to acknowledge two-program reality. Per-site jurisdiction config added to `sites` schema (jurisdiction, mrc_program_code, per_unit_rate_usd_current, billing_cadence). New table `site_billing_rates` for historical rate tracking. Manager portal exports specified concretely: (1) MRC Monthly Invoice Report (Article 10.4 contract format, matching observed billing-summary structure), (2) SVdP Internal Billing Export (CSV, format pending Glenn DePrater conversation), (3) Custom Date Range Export. Two new open decisions: Oregon MRC contract review (#2) and Glenn billing format conversation (#3). California contract clauses assumed to apply to Eugene as defaults until Oregon contract validates them.
- **v0.17 (2026-05-04)** — Q13 resolved: **in-app photo annotation** approved for MVP. Tools: circle, arrow, freehand draw, text label; red/yellow color toggle. Available on concern and rejection photos (not BOL/door-open — those are evidentiary by composition). **Both versions stored** in R2: raw original (forensic integrity) + annotated overlay (manager-portal default view). HTML5 canvas overlay; finger and Apple Pencil compatible; no native dependencies. Schema: `load_photos.annotation_storage_key` (nullable) + `has_annotation` boolean.
- **v0.16 (2026-05-04)** — Q12 resolved: native iPadOS voice-to-text included in MVP (zero cost, friction win for note entry); subtle "Tap the mic" tip on first concern; no custom recording or transcription API. **Architecture explicitly browser-only confirmed**: PWA via Safari "Add to Home Screen," no native iOS app, no App Store, no Apple Developer Program. Major addition: **i18n required from MVP day 1** for English / Spanish / Urdu (operator workforce includes all three). Urdu is RTL — chrome mirrors via `dir="rtl"`. New schema: `users.locale`, `load_concerns.note_locale`, `rejection_note_locale`. Operator-entered notes preserved in original language; MyMRC submission layer translates to English before push (contract requires English reporting). Manager portal can ship English-only at MVP, add Spanish/Urdu in V2.1 if useful. Translation pipeline: AI drafts (Claude/DeepL) + bilingual SVdP team review.
- **v0.15 (2026-05-04)** — Q11 resolved: concern + rejection category enums finalized. **Bedbugs split out** as its own category per Contract Exhibit C §6 (source-tracking requirement). `concerns.category` enum: damaged|wet|bedbugs|contamination|short|mislabeled|other. `rejection_category` enum: wet|unsafe|wrong_product|bedbugs|contamination|wrong_site|documentation_problem|capacity|short|mislabeled|damaged|other. Wrong_site, documentation_problem, capacity, unsafe, and wrong_product are rejection-only (can't be discovered mid-unload).
- **v0.14 (2026-05-04)** — Personas refined with named individuals: **Morena Gomez (DR3 Operations Manager)** is the primary day-to-day stakeholder for DR3-Vision and primary user of the Compliance dashboard; **Bill Barnard (DoO)** is org-level admin and escalation tier. Per-site facility managers below Morena. Rejection ntfy alerts now route to site manager + Morena + Bill. Compliance dashboard ownership noted. CIP confirmed as V2.2-only — no MVP or V2.1 touchpoint (already roadmap, just explicitly affirmed).
- **v0.13 (2026-05-04)** — **MRC Recycling Services Agreement reviewed and integrated.** New §1.5 captures contract context: 2025-2027 initial term, $16-17/unit compensation, 75% recycling rate requirement, 97% inbound/outbound weight reconciliation requirement, 60-min dock SLA, 3,500/5,000 storage limits, 4-year records retention. New schema fields: `dock_appointment_at`, `arrived_at`, `time_to_unload_start_seconds`, `processed_at`, `processed_by`, `mymrc_submission_deadline`, `mymrc_bol_uploaded_at`. New `sites` columns for hours, holidays, storage limits. New tables planned: `site_holidays`, `site_inventory_snapshots`. New §4.6 Compliance dashboard surfacing every contractually-tracked metric. Eight new contract-driven risks added to risk table (3-day deadline, 75% recycling, 97% reconciliation, 60-min dock SLA, storage limits, records retention, CIP PII). V2.2+ expanded with Consumer Incentive Program (separate workflow with PII handling), daily processed-units, material breakdown weights, Storage Container/Collection Event/Transportation tracking, monthly Recycling Certificate auto-generation, annual Exhibit G submission. ADR-0010 added for CIP data handling. Success criteria add MyMRC submission timeliness ≥95% and dock SLA ≥90% targets.
- **v0.12 (2026-05-04)** — Q10 resolved: **self-claim** model. All operators at a site see all expected loads; tapping a load atomically claims it (first tap wins, race conditions resolved server-side). Operators can't release a claimed load — only managers can reassign via portal (audit-logged). Aligns with Q9's manager-directed-verbally workflow: manager tells the operator which truck is up, operator taps, system captures.
- **v0.11 (2026-05-04)** — Q9 resolved: operator queue is **manager-directed**, not a disambiguation puzzle. Operators are told which truck is up via verbal direction and an office whiteboard. Queue UX simplified to a list sorted by expected arrival time — no elaborate disambiguation needed. Two new V2.1 roadmap items: (a) **BOL OCR safety check** to compare photographed BOL against tapped-load expected BOL (warns on mismatch, doesn't block — protects against mistaps), and (b) **"Next up" cast view** to replace the office whiteboard with a TV-mounted dashboard showing the same data DR3-Vision already has.
- **v0.10 (2026-05-04)** — Q8 resolved: program/non-program unit split is **not captured at the dock** (operator can't distinguish). Primary path: Playwright schedule-sync pulls expected split from MyMRC haul record. Fallback path: manager enters split at verify time via portal widget. Verification step enforces `program_unit_count + non_program_unit_count == total_units` — manager can't verify unless math reconciles. Whether primary or fallback applies will be confirmed once Playwright is pointed at MyMRC's scheduled-haul page.
- **v0.9 (2026-05-04)** — Q6 refined: rejection requires **multiple** photo captures (documentation is the point) — UX makes "Add another photo" the prominent action throughout the rejection flow; "Continue" is the smaller affordance after the first capture. Q7 resolved: **units are units** at the dock — no mattress vs box spring distinction (no operational use, MyMRC reports them combined, impact stats roll them together). Single number-pad per stack. Schema simplified: `inbound_loads.total_mattresses + total_box_springs` → `total_units`; `load_stacks.mattress_count + box_spring_count` → `unit_count`. MyMRC field mapping updated accordingly.
- **v0.8 (2026-05-04)** — Q6 resolved: rejected loads modeled as terminal status on existing scheduled load record (Option A). Categories: wet, unsafe, wrong_product, contamination, wrong_site, documentation_problem, capacity, other. **All-or-nothing** — entire load rejected, no partial acceptance. Rejection sub-flow inserted between door-open photo (step 3) and stack counter (step 4): operator picks "Begin unload" or "Reject load." Reject path requires category + cause photo + note. Status transitions to `rejected`; ntfy alert fires immediately to `dr3-vision-rejection` topic (manager + Bill) because MRC is notified in real time, not end-of-day. Schema additions: `rejected` status, `rejection_category` / `rejection_note` / `rejection_reported_to_mymrc_at` / `rejection_reported_by` columns; `rejection` added to `load_photos.kind` enum.
- **v0.7 (2026-05-04)** — Q5 resolved: partial unloads never happen at DR3. Model stays simple — single continuous timer session per load, no `paused` status, no pause/resume logic. Note added to §4.3 to prevent future over-engineering.
- **v0.6 (2026-05-04)** — Q4 resolved: one truck = one BOL = one load (`bol_number` unique per site/date). Weight ticket arrives with truck (Scenario A), is **optional**, captured at arrival. Operator flow restructured: weight capture moved from step 6 (post-unload) to step 2 (right after BOL photo). Dual-button UX ("Add weight ticket" / "No weight ticket") — both equal-weight choices, no skip-tucked-in-corner. Schema cleanup: dropped `sites.weighs_loads` flag (weight is per-load optional, not per-site policy); dropped `weighed` from `inbound_loads.status` enum (weight captured during `receiving`, not as separate state); added unique constraint note on `bol_number` per `(site_id, arrival_date)`. Resolved Eugene weighing capacity open decision (no longer applicable).
- **v0.5 (2026-05-04)** — Build questions Q1-Q3 resolved: (Q1) Outbound is roadmap soon as separate workflow type — material/BOL/recipient/weight/photos. V2.2 priority. (Q2) Pre-scheduled load model confirmed — operator's first screen is an expected-loads queue, no walk-up creation in MVP. (Q3) Schedule comes from MyMRC via **hourly Playwright scrape (now in MVP, not V2.1)** — same robot infrastructure as V2.1 write direction, just different workflow. Manual "Schedule a load" form on manager portal for unscheduled arrivals. CSV/XLS reconciliation remains in MVP as complementary verification.
- **v0.4 (2026-05-04)** — **MyMRC API access test resolved: DENIED.** Tested 2026-05-04 against `mrc-us.my.site.com/services/data/v66.0/sobjects/` — both cookie auth and bearer-from-cookie auth returned `401 INVALID_SESSION_ID`. Org-level API surface exists (Spring '14 through Spring '26 versions reachable) but operator user profile lacks "API Enabled" permission. ADR-0009 write path now locked to Playwright/headless-Chrome browser automation on CHAD-HQ. CSV reconciliation in MVP is unaffected. Email-to-MRC remains a parallel ask in case they grant access; if so, V2.1 switches to REST API.
- **v0.3 (2026-05-04)** — Project name corrected: `DR3-Vision` (not `dr3`). Service code `dr3-vision`. Hostname locked to `dr3-vision.svdp.us`. V1 PHP code archives to `legacy/` rather than fresh repo. **MyMRC integration architecture added** (§6.5, §11): DR3-Vision is the source of truth at the dock; MyMRC integration is layered on top via CSV reconciliation (MVP) and API-push or browser automation (V2.1, pending API access test). Schema updated: `weight_lbs` moved into MVP `inbound_loads`, `external_mymrc_haul_id` and `external_mymrc_materials_id` added as integration handles, pickup address restructured to parsed components. Sources seed list to be derived from real MyMRC export (7,046 haul records spanning Jan 2023 – May 2026).
- **v0.2 (2026-05-04)** — Corrected "drivers" → "forklift operators and staff" throughout (truck drivers ≠ warehouse operators). Auth simplified to PIN-only per individual staff member. MVP expanded to Eugene + Woodland from launch (not Eugene-only pilot). Stockton excluded from V2 scope (consistent with consolidation exit). Removed the iPad-auth-model open decision (resolved). Removed pilot-site open decision (resolved: both sites at once).
- **v0.1 (2026-05-04)** — Initial draft.

---

## 1. Background

DR3 is the recycling division of St. Vincent de Paul Society of Lane County. Mattresses arrive by truck at three active facilities (Eugene OR, Woodland CA, Stockton CA) and a future Sacramento-area consolidation site. Today, every inbound load is logged on paper at the dock — operator, BOL, source, count, photo (sometimes), notes (sometimes) — and the facility manager re-keys that data into other systems for billing, MRC reporting, and operational tracking. Paper gets lost, photos get separated from records, and the facility loses visibility into operational metrics that would meaningfully improve dock turnaround and operator throughput.

A student intern built a V1 PHP web app (`BigBill1418/DR3-Vision`) that captured the basic intent: a warehouse staff member opens a task on a tablet, enters stack counts, uploads a photo, marks it complete. V1 has critical security defects, no audit trail, no offline tolerance, no timing data, no MRC fields, no PIN auth, and no fit with the BarnardHQ fleet conventions. It is not deployable.

V2 (this project) replaces V1 with a production-grade application that runs on iPad-mounted forklifts, captures the full operational picture of a load (including timing), feeds the facility manager a real-time portal, and is architected to grow into a general replacement for paper processes across the factory.

## 1.5 Contract context (MRC Recycling Services Agreements — two separate programs)

DR3-Vision operates under **two completely separate state mattress stewardship programs**, both administered by MRC but with distinct contracts, billing cycles, rate structures, regulatory frameworks, and even **separate sections of the MyMRC portal**. The two facilities — Eugene (Oregon program) and Woodland (California program) — are treated as fully isolated tenants throughout DR3-Vision. This is not a configuration detail; it is a foundational architectural principle.

### Strict separation rules (apply to MVP and forever)

- Every query, list, export, alert, and Compliance dashboard metric is **scoped to one site at a time**. Site scoping comes from the user's session (operator/manager) or explicit selection (admin), never inferred or defaulted.
- **Cross-site roll-ups exist only for the admin role** (Bill, who oversees both as DoO). Morena, as DR3 Operations Manager, sees per-site dashboards and can switch between sites — but the data is never co-mingled in the same view.
- **MyMRC integration is per-site.** Two separate MyMRC contexts (Oregon section vs. California section), two separate Playwright login sessions, two separate sets of credentials. The scraper does not assume one MyMRC view covers both facilities.
- **Exports are per-site.** A single export file contains data from a single site. Cross-site analysis is a separate admin-only feature, not the default.
- **Rates, deadlines, contract clauses are per-site.** California-contract values do not bleed into Eugene calculations and vice versa.
- **Alerts route per-site.** Eugene rejection alerts go to the Eugene facility manager; Woodland alerts go to the Woodland facility manager; both go to Morena (DR3 Ops, both sites) and Bill (DoO, all sites).

### California program (Woodland)

MRC California Recycling Services Agreement, signed 2024, term 2025-01-01 through 2027-12-31, auto-renewing. Reviewed in detail and integrated into this charter (clauses below).

- **Per-unit processing fee:** $16.00 (2025), $16.50 (2026), $17.00 (2027), CPI-indexed thereafter.
- **Billing cadence:** mid-month + end-of-month processing invoices, plus separate transportation/fuel/container invoice ("End of Month Trans Invoice").
- **MyMRC platform section:** California-specific. Separate URL path and/or tenant filter from the Oregon section.

### Oregon program (Eugene)

MRC Oregon Recycling Services Agreement (markup dated 2024-12-02). Stewardship organization: **MRC Oregon, LLC** (separate legal entity from MRC California). Regulatory basis: **Oregon SB 1576** (Mattress Stewardship Act, 2022). Regulator: **Oregon DEQ** (Department of Environmental Quality).

- **Initial term:** 3 years from Effective Date, auto-renewing in 1-year terms (120-day notice to non-renew).
- **Per-unit processing fee:** $17.00 flat for 2025, 2026, 2027. CPI-indexed from January 2028.
- **Per-unit Collection Site Count fee:** $2.25/unit at MRC-designated remote drop-off locations. Observed: Salem, Albany, Cottage Grove, Florence. Separate billable revenue stream from the $17 processing fee.
- **Billing cadence:** end-of-month processing invoice only. Plus separate transportation/container invoice. Plus separate Collection Site Count invoice.
- **MyMRC platform section:** Oregon-specific. Separate from the California section.

**Material clauses (Oregon-specific — DO NOT apply California values):**

| Constraint                                               | Oregon value                                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Recycling Percentage minimum                             | **70%** (CA is 75%)                                                                                                       |
| Recycling Percentage formula                             | (recycled + reused + renovated) ÷ (recycled + reused + renovated + disposed) × 100 — broader than CA, includes renovation |
| Processing deadline                                      | **60 days** from receipt to fully deconstruct (CA is 45)                                                                  |
| On-site storage limit                                    | **6,000 unprocessed units total** (single combined limit — CA splits 3,500 inside + 5,000 outside)                        |
| Off-site storage                                         | **Prohibited without prior written MRC notice** — off-site accumulation is grounds for immediate termination              |
| Records retention                                        | **5 years** after final payment (CA is 4)                                                                                 |
| Customer service hours                                   | **8:00am–4:00pm Pacific** Monday–Friday excluding federal holidays (CA is 8:30am–4:30pm)                                  |
| Holidays observed (Eugene closed)                        | New Year's, Memorial, Independence, Thanksgiving, Labor, Christmas (per Exhibit G)                                        |
| 60-minute dock-appointment SLA                           | Same as CA — applies in Oregon                                                                                            |
| 97% inbound/outbound weight reconciliation               | Same as CA — applies in Oregon                                                                                            |
| 3-business-day inbound MyMRC entry deadline              | Same as CA — applies in Oregon (Exhibit H)                                                                                |
| 1-business-day processed-units deadline                  | Same as CA — applies in Oregon (Exhibit H)                                                                                |
| 3-business-day outbound weight + final disposition entry | Same as CA — applies in Oregon (Exhibit H)                                                                                |
| 5-business-day outbound BOL upload                       | Same as CA — applies in Oregon (Exhibit H)                                                                                |
| Service Level Adjustment penalty                         | Same as CA — 10% withhold for missed deadlines or sub-97% reconciliation                                                  |
| Consumer Incentive Program                               | **NOT in Oregon contract** — no CIP at Eugene. CIP is California-only.                                                    |
| Invoicing discrepancy floor                              | **<$5,000 → MRC pays in full**; correction issued on next invoice (Oregon-only protection)                                |
| Standard payment terms                                   | Net 30 from receipt of invoice + supporting documentation                                                                 |
| Bankruptcy notification                                  | 2 business days                                                                                                           |
| Regulatory orders/fines notice to MRC                    | 2 business days                                                                                                           |

**Implication:** Eugene's Compliance dashboard runs on Oregon-specific values. Woodland's runs on California-specific values. They are not interchangeable.

### Two-program implications for DR3-Vision

The schema, code, and UX must enforce per-site separation throughout. Where a feature in this charter says "manager portal" or "alert" or "export" without specifying site scope, the default is **per-site**.

### California contract — material clauses

The California contract creates concrete data, timing, documentation, and compliance obligations that DR3-Vision must support **for Woodland**. Material clauses:

- **Mandatory MyMRC use.** Article 8.2: "Recycler must use and maintain Records in the electronic reporting platform provided by MRC, at MRC's sole expense. MRC currently uses the platform MyMRC." DR3-Vision is the dock source-of-truth, but **MyMRC remains the contractually-required reporting platform** — every haul must end up there.
- **Reporting deadlines (Exhibit H — Service Level Adjustments).** Inbound Units must be entered in MyMRC within **3 business days of receipt**; supporting BOLs uploaded within **3 business days**; processed (deconstructed) units recorded within **1 business day** of dismantling; outbound commodity weights within **3 business days** of weight documentation; outbound BOLs within **5 business days**.
- **Failure to meet deadlines = 10% payment withhold** (Service Level Adjustment, §960).
- **75% recycling rate by weight** is contractual (Exhibit A §2.a, Exhibit C §2.b). Failure may be grounds for termination.
- **97% inbound/outbound weight reconciliation** over rolling 9 months. Failure = additional 10% payment withhold per percentage point below.
- **60-minute dock-appointment SLA** (Article 11.3). Demurrage charges over 2 hours of delay are charged back to Recycler.
- **Storage limits.** Max 3,500 unprocessed units inside facility; max 5,000 in trailers/containers outside. Must notify MRC immediately if exceeded.
- **Records retention.** Minimum 4 years after final payment (Article 8.6 + Exhibit C §1.b).
- **Compensation lines (Compensation Schedule — Exhibit D).** Per-unit processing fee; transportation by Collection Zone (per-trailer stop charges); fuel surcharge; storage container monthly rental ($300–$400/trailer); collection event labor; Consumer Incentive Program reimbursement.
- **Consumer Incentive Program (CA).** $3/unit max 5 units per consumer vehicle per day. Required check-in log with name, phone, license plate, units, payment, signature. Reimbursement claimed monthly. **V2.2 roadmap.**
- **Data Protection Addendum (Exhibit I).** Consumer Incentive Program data is MRC Personal Data with breach-notification obligations and 10-business-day deletion-on-termination requirement.
- **Monthly invoice format (Article 10.4).** Excel report containing: Inbound deliveries (date, source, Transporter, units, collection site, Haul Record ID); Consumer drop-offs (incentive paid + unpaid + illegally dumped, with date, units, Haul Record ID); Outbound transactions (date, commodities, weight, Materials Record ID); Event labor (location, date, hours, per diem, mileage).

### Oregon contract — material clauses

Per the Oregon contract section above. **Eugene runs on Oregon values, not California defaults.** Compliance dashboard, deadlines, SLAs, storage limits, retention period, and recycling rate threshold all use the Oregon-specific numbers documented above.

DR3-Vision must directly support compliance with all of the above per-site. Contract-driven requirements are flagged throughout this charter with **(Contract: CA Article X.Y)** or **(Contract: OR — pending)** references.

---

## 2. Intent (what V1 was trying to do, distilled)

When a truck arrives at DR3, the dock workflow needs to:

1. Capture **what** came in — source, BOL, expected count.
2. Capture **how much** actually came off — by stack, with running totals.
3. Capture **proof** — photos at door open and during unload.
4. Capture **anomalies** — additional photos and notes for damage, contamination, or short loads.
5. Hand off a **verifiable record** to the facility manager for billing, MRC reporting, and downstream systems.

V2 adds two things V1 did not: **forced photo capture** at defined moments (BOL + door-open + concerns) and **timing instrumentation** of the unload process for operational analytics.

## 3. Users

- **Operators** — warehouse staff at each site. iPad mounted on the forklift (or a stationary kiosk for non-forklift workflows like baling, future). Gloves on, dust, glare, intermittent WiFi, possibly limited English literacy. Needs the screen to be a tool, not an obstacle. Note: "operator" refers to DR3 _warehouse staff who operate the equipment and run the forms_. The truck driver who delivers the load is a separate person and is not a system user.
- **Facility manager — Eugene:** **Rick Albritton**. Per-site manager for Eugene operations.
- **Facility manager — Woodland:** **Janette Thomas**. Per-site manager for Woodland operations.
- **DR3 Operations Manager** — **Morena Gomez**. Oversees DR3 across all active sites (currently Eugene + Woodland). Primary day-to-day operations stakeholder for DR3-Vision. Sees per-site dashboards and can switch between sites; data is never co-mingled in a single view (per §1.5 separation principle). Owns the Compliance dashboard from the operations side. Modeled as `manager` role with `user_sites` assignments to all DR3 sites.
- **DR3 Data & Compliance lead** — **Kelsey Ruhland** (kelsey.ruhland@svdp.us). Subject-matter expert for DR3 and MRC contracts across all locations. Primary user of the Compliance dashboard from the data/contract-interpretation side; co-stakeholder with Morena. Manages MRC reporting, audits records, validates contract-rate changes when CPI or term-renewal events trigger updates. Monitors the Compliance dashboard (in-app, not push). Modeled as `admin` role — sees all sites, all contracts, all data.
- **Director of Operations / org admin** — **Bill Barnard**. DoO for SVdP; directly supervises DR3. Org-level admin. Manages users, sites, sources, ADR decisions; escalation tier for system-level alerts and compliance breaches. Modeled as `admin` role.

The 3-role schema (`operator|manager|admin`) plus the `user_sites` many-to-many table handles all of these naturally. Rick has one `user_sites` row (Eugene); Janette has one (Woodland); Morena has both; Kelsey and Bill are `admin` and see everything by role.

**Compliance dashboard primary users:** Morena (operations lens) + Kelsey (data/contract lens). Bill is escalation tier. Any contract-rate change, deadline interpretation, or reporting requirement question routes to Kelsey first.

**Future Sacramento site:** when the Sacramento consolidation completes, **Woodland closes — Sacramento replaces Woodland, not adds to it.** DR3-Vision will have at most two active sites at any time during this transition: Eugene + (Woodland or Sacramento). Sacramento inherits Woodland's California program, MRC California contract, and Janette as facility manager (or her successor at the new site). Site activation/deactivation is admin-controlled via `sites.is_active`; historical data from Woodland remains accessible read-only per the 4-year California retention requirement.

## 4. Functional requirements

### 4.1 Operator flow (iPad on forklift or kiosk)

The operator opens the app, enters their PIN, and lands on the **expected loads queue** for their site — a list of pre-scheduled inbound loads sorted by expected arrival time (ascending). Each row shows source, expected time, transporter, and BOL.

The operator **does not need to disambiguate** loads from a busy queue — the facility manager directs operators to the right truck verbally and via an **office whiteboard** showing the order of incoming trucks (Q9). The DR3-Vision queue is the data record; the whiteboard is the operational sequencer. Future iteration may replace the whiteboard with a "next up" cast view in the office, but this is not MVP scope.

When a truck pulls up and the manager has cued the operator, the operator finds the matching scheduled load in the queue and taps it. **Self-claim:** the tap records the operator as the claimer (`assigned_operator_id` set from the session, status transitions `expected` → `claimed`). First tap wins — race conditions are resolved server-side atomically; a late second tap sees "this load is already being handled by [name]" and returns to the queue. Operators cannot release a load they've claimed; only a manager can reassign via the portal (audit-logged). **Safety check (V2.1 — see Roadmap):** when the BOL photo is captured, OCR compares the photographed BOL number against the expected BOL on the tapped load and warns if they don't match — protects against mistaps without changing the manager-led workflow.

When the operator taps a load to begin unloading:

1. **Forced BOL photo.** The app immediately presents the camera. The operator must capture a clear photo of the BOL (Bill of Lading). No further screens unlock until the photo is captured. **Capturing the BOL photo starts the unload timer.**

2. **Weight ticket capture (optional, at arrival).** The truck may arrive with a printed weight ticket from an upstream weigh station. The operator sees two equal-weight buttons: **"Add weight ticket"** (opens camera → captures ticket photo → numeric pad to enter weight) or **"No weight ticket"** (proceeds without weight). Both are deliberate choices, not Skip-tucked-in-corner — operators should never feel pressured to fake a missing ticket. **Weight is captured as integer pounds** (US trucking standard — DOT-certified scales display whole pounds; no decimals). Validation: must be > 0, ≤ 100,000 lbs (DOT gross max is 80,000 — headroom for outliers; values outside this range surface a soft warning and require manager confirmation). Stored as `weight_lbs INTEGER`; the ticket photo is stored as a `load_photos` row with `kind=weight_ticket`.

3. **Forced load photo.** The app prompts for a "doors open" photo of the trailer interior. This must also be captured before the count UI unlocks.

4. **Stack counter.** Once the required photos are captured, the count UI unlocks. Units are tracked as a single combined count (mattresses + box springs together — no per-type distinction at the dock, confirmed Q7). The operator enters total unit counts using one of three input modes (operator chooses):
   - **Stack ledger mode (preferred for typical loads):** Operator records each stack as they pull it. Tap "+ Stack", enter the unit count for that stack (e.g., "9"), confirm. Running total updates live. UI shows ordered list of stacks with edit/delete on each.
   - **Multiplier mode (fast path for uniform loads):** Operator enters "stacks × per-stack" (e.g., 8 stacks × 9 units = 72).
   - **Total mode (fallback):** Operator enters a single total. Used only when stack-by-stack isn't practical.

   Mode is per-load, not per-operator — the operator picks based on the load.

5. **Concern photos & notes.** At any time during the unload, the operator can tap "Add Concern" to:
   - Capture additional photos (damage, contamination, soiled units, packaging issues)
   - **Annotate captured photos** — after capture, a markup view opens with tools (circle, arrow, freehand draw, text label, red/yellow color toggle for high contrast). Operator marks the area of concern, taps Done. **Both versions stored**: raw original (forensic integrity) + annotated overlay (what surfaces in the manager portal by default). Annotation is optional; "Skip" returns to capture flow with raw photo only.
   - Attach a note (free text, voice-to-text supported)
   - Tag the concern with a category: **damaged | wet | bedbugs | contamination | short | mislabeled | other** (bedbugs split from general contamination per Contract Exhibit C §6 source-tracking requirement)

   Concerns appear on the load record and are visible to the facility manager.

6. **Finish unload.** A prominent "Done — close trailer" button stops the unload timer and transitions the load to status `received`. The app displays a summary: total units, total time, weight (if captured), number of stacks, number of concerns, photos captured.

7. **Submit.** Operator confirms the summary and submits. On submit, the load record is queued (offline-capable) and synced to the server. Operator returns to load list. Session continues until idle timeout or explicit logout — see §5.1.

#### Rejection branch (after step 3, before step 4)

Between the door-open photo (step 3) and the stack counter (step 4), the operator has a decision point. The default action is "Begin unload" — but if inspection at the open trailer reveals a problem (excessive wetness, unsafe condition, wrong product, contamination, wrong site, documentation issue, capacity, or other), the operator taps "Reject load" instead.

The rejection sub-flow:

- **Required:** category dropdown — **wet | unsafe | wrong_product | bedbugs | contamination | wrong_site | documentation_problem | capacity | short | mislabeled | damaged | other**
- **Required:** **multiple rejection-cause photos.** Documentation is the entire point of rejection records — the operator must capture at least one photo, but the UX strongly encourages multiple. The "Add another photo" button stays prominent throughout the rejection flow; a smaller "Continue" affordance appears only after the first photo is captured. **Each photo can be annotated** after capture — circle the wet area, arrow the contamination, label the BOL discrepancy. Both raw and annotated versions stored. Examples: photo of the wet load from inside the trailer, photo of the contamination, photo of the BOL discrepancy, photo of the truck/trailer ID for follow-up. Stored as `load_photos` rows with `kind=rejection`.
- **Required:** free-text note describing what's wrong (voice-to-text supported)
- **Optional but encouraged:** transporter contact info if known (so manager can follow up)
- On submit, status transitions to `rejected` (terminal — load does not unload). Timer stops; `time_to_reject` is captured as a separate metric distinct from unload duration.
- **Alert routing — load operations are visible in-app, NOT pushed via ntfy. ntfy goes to Bill only.** ntfy alerts are reserved for **system-level events only**: app/database outages, MyMRC sync failures, storage container issues (capacity breaches, container offline). All other events — rejections, long unloads, dock SLA breaches, concerns, PIN lockouts, missed deadlines — are in-app indicators, dashboard tiles, and email digests inside DR3-Vision. Kelsey, Morena, Rick, and Janette do not receive ntfy push; they monitor the dashboard. ntfy topics:
  - `dr3-vision-system` — outages, errors, deploy notifications, MyMRC sync failures (Bill only)
  - `dr3-vision-container` — storage container capacity breaches, off-site accumulation alerts, container-rental issues (Bill only)
  - **No ntfy topics for any operational events.** Operational visibility is dashboard-driven exclusively.
- The rejected load remains in the load list with a `rejected` status badge; the manager portal includes a "MRC notified" checkbox + timestamp the manager can mark once they've reported it (writes to `rejection_reported_to_mymrc_at`).
- **All-or-nothing:** rejections always reject the entire load. Partial acceptance is not modeled (confirmed Q6).

### 4.2 Forced photo enforcement

The app must enforce photo capture at the two required moments. UI patterns:

- The camera screen is modal — no back button, no skip option.
- The capture button is disabled until the device confirms a photo was actually taken (camera permission granted, photo file written).
- Photos are written to local IndexedDB **first**, then queued for upload. The UI advances on local-write success, not server-write success — so spotty WiFi never blocks the operator.
- Server-side validation rejects any load submission missing the two required photos. The client should make this impossible, but defense-in-depth.

### 4.3 Timing instrumentation

The unload timer is the operational metric that V1 missed. Implementation:

- Timer starts the moment the BOL photo is successfully captured client-side.
- Timer ticks server-authoritative once synced (so a clock-skewed iPad doesn't poison data).
- Timer stops on "Done — close trailer" tap.
- **Single continuous session per load.** Partial unloads do not occur at DR3 (confirmed Q5) — once an unload starts, it runs to completion. **No mid-load shift handoff** (confirmed Q18) — the operator who starts the load owns it through completion; staff stay until the truck is done. Schema does not include `paused` status, pause/resume logic, or partial-session handoff. Manager-portal reassignment (Q10) exists only as an exception escape hatch, not a designed-for workflow. If an exceptional case arises, the manager can reassign with audit-logged justification.
- Captured per-load: `unload_started_at`, `unload_ended_at`, `unload_duration_seconds`.
- **Dock-appointment SLA tracking (Contract Article 11.3, applies to both CA and OR).** Captured per-load: `dock_appointment_at` (from MyMRC schedule), `arrived_at` (operator marks when truck pulls up), `time_to_unload_start_seconds`. Loads where `unload_started_at - dock_appointment_at > 60 minutes` are flagged on the live dock view with a warning badge at 90 minutes and a critical badge at 110 minutes (demurrage liability ~10 min away). **In-app dashboard signal only** — no ntfy push for SLA breaches per Q16. Manager analytics surface this metric weekly.
- Aggregated for the manager portal:
  - Per-operator: average / median / p90 unload time, throughput
  - Per-source: typical unload time (helps spot problem haulers)
  - Per-dock: utilization, time between loads
  - Per-day / per-week / per-month: trends, peak hours
  - **Dock-appointment compliance rate** (% of loads beginning unload within 60 min of appointment) — direct contract metric
- Anomaly detection: loads that exceed 2× the rolling p90 trigger a "long unload" flag for manager review.

### 4.4 Facility manager portal

The manager portal is responsive (works on phone) but desktop-first. Capabilities:

- **Live dock view:** every active load at the manager's site, with elapsed unload time and live status. Useful for "who's still on the dock?" at a glance.
- **Load list:** filterable by date range, operator, source, status, has-concerns, with-photos.
- **Load detail:** all photos in a gallery, all stacks broken out, all concerns with notes, full timing breakdown, audit trail.
- **Verify action:** manager marks a load `verified` after spot-checking — this is the gate for downstream billing/MRC export. Verification step **enforces** that `program_unit_count + non_program_unit_count == total_units` (Q8): if MyMRC scrape pre-populated the split, manager confirms; if not, manager enters it manually. Manager cannot mark `verified` until the math reconciles.
- **Exports (Q14) — all per-site, never co-mingled:**
  - **MRC Monthly Invoice Report (Article 10.4 for CA; Oregon equivalent TBD):** Excel format matching contract specification. Per site, per month. Contains:
    - Inbound deliveries (date, source, Transporter, units, collection site, Haul Record ID)
    - Consumer drop-offs (V2.2 — incentive paid + unpaid + illegally dumped, with date, units, Haul Record ID)
    - Outbound transactions (V2.2 — date, commodities, weight, Materials Record ID)
    - Event labor (V2.2 — location, date, hours, per diem, mileage)
    - Cover sheet matching the format observed in March 2026 billing summaries
  - **MRC Transportation Invoice (per-site monthly):** Standalone Excel matching the format observed (Transportation total, Container Rental total, Fuel Surcharge, Monthly Total). Generated alongside the processing invoice.
  - **Oregon Collection Site Count Invoice (Eugene only, V2.2):** Per-collection-site monthly count totals (Salem, Albany, Cottage Grove, Florence, etc.), $2.25/unit. Separate from the processing fee.
  - **SVdP Internal Billing Export (CSV):** for Glenn DePrater (CFO) and team. Format TBD pending direct conversation; defaults to MyMRC field names if no specific format requested. Per-site.
  - **Custom Date Range Export:** any date range, any subset of fields, single site (or admin can choose multi-site for analysis). Downloaded as CSV.
- **Analytics tiles:**
  - Loads received today / this week / this month
  - Total units processed
  - Average dock time
  - Operators active right now
  - Unverified load count (manager's queue)
  - Concerns by category (last 30 days)
  - **Rejections this week** (with one-click drill-in to see categories and photos)
- **Reassign operator:** if an operator self-claimed the wrong load (mistap), manager can reassign via the load detail screen. Operators cannot release loads they've claimed — only managers can reassign (audit-logged with before/after operator IDs).
- **Edit / annotate:** manager can correct counts, add notes, but every change is logged in the audit trail with before/after.
- **Schedule a load:** manual entry form for unscheduled arrivals (retail returns, MyMRC outages, off-program loads). Flagged `source=manual` and protected from being overwritten by future MyMRC scrapes.

### 4.5 Admin (site / user / source management)

- Manage sites (Eugene, Woodland, Stockton, Sacramento-future): name, timezone, address, customer-service hours, holiday calendar, storage limits, active flag.
- Manage users: invite by email, set role (operator/manager/admin), assign to site(s), issue/reset PIN, deactivate.
- Manage sources: add hauler/retailer/MRC program names. Free-text BOL; controlled-list source.
- Manage docks per site (optional, V2.1): named docks for per-dock metrics.

### 4.6 Compliance dashboard (Contract-driven)

A dedicated manager-portal section that surfaces every contractually-tracked metric in one view. Required by the Service Level Adjustment provisions of the contract, which directly tie payment to data quality. **Primary users: Morena Gomez (DR3 Operations Manager — operations lens) and Kelsey Ruhland (Data & Compliance — contract/reporting lens)**, with Bill (DoO) as escalation tier for any metric in breach. Per-site filtering enforced; admin role (Kelsey, Bill) can see roll-ups across sites.

- **MyMRC submission timeliness:** % of inbound loads submitted within 3 business days; list of overdue/at-risk loads with hours remaining (Contract: Exhibit H §3)
- **Daily processed-units submission timeliness:** % submitted within 1 business day of dismantling (Contract: Exhibit H §4)
- **Dock-appointment SLA:** % beginning unload within 60 min of appointment, average minutes-to-start, demurrage exposure (Contract: Article 11.3)
- **Recycling rate (rolling):** % by weight of mattresses processed that are recycled vs landfilled, must be ≥ 75% (Contract: Article 6.4, Exhibit C §2.b)
- **Inbound-outbound weight reconciliation:** rolling 9-month accuracy %, must be ≥ 97% (Contract: Exhibit H Service Level Adjustments)
- **Storage inventory:** current units inside facility (CA: max 3,500 inside + 5,000 outside; OR: max 6,000 total on-site, off-site prohibited), days at >90% capacity (Contract: CA Article 6.5–6.6, OR Article 3.5)
- **0.5% unrecyclable waste threshold:** % of mattresses disposed as unrecyclable, alert if approaching (Contract: CA Exhibit A §2.c, OR equivalent)
- **Records retention:** photo and audit data retention status (Contract: CA Article 8.6 — 4 years minimum, OR — 5 years minimum)
- **In-app dashboard signals** for any metric approaching or breaching threshold (color-coded tiles, badges on load list). **ntfy push reserved for system + container events only** (per Q16): app outages, MyMRC sync failures, storage container capacity hard-breaches, off-site accumulation alerts.

## 5. Non-functional requirements

### 5.1 Security

- **Auth:** **PIN-only**, individual to each staff member. No email/password login on the iPad. Each user has a unique PIN (4 digits per Q21, Argon2id-hashed). The iPad shows a user-picker (operator selects their name from the site's active staff) followed by a numeric keypad. Email/password is reserved for managers and admins accessing the portal from the office, and uses Auth.js v5 with the same Argon2id store.
- **Sessions on shared iPads:** short by design — auto-logout after 5 minutes idle, after every load submission, or on explicit "Switch user" tap. This keeps the audit trail accurate when multiple operators share a tablet across shifts.
- **Sessions for managers/admins (browser):** secure cookies (`Secure`, `HttpOnly`, `SameSite=Lax`), 12-hour idle, 30-day absolute.
- **Roles:** `operator`, `manager`, `admin`. RBAC enforced server-side on every API route, never relying on client-side checks.
- **PIN security (Q21):**
  - 4 digits, numeric
  - Server-side rate limit: 5 failed PIN attempts within 60 seconds → 15-minute auto-unlock lockout; surfaces as a notification on the manager portal (in-app, not ntfy push).
  - Disallow obvious patterns at create/change time: sequential (1234, 4321, 2345), all-same (0000, 1111), repeated-pair (1212, 3434).
  - **Unique within a site** (no two users at Eugene share a PIN); **reusable across sites** (Eugene PIN and Woodland PIN can match).
  - Manager-resettable for users at their site; admin-resettable for any user. Audit-logged with actor / target / timestamp.
  - Repeat-lockout indicator on Compliance dashboard so managers can spot operators with chronic forgotten-PIN issues (training signal).
  - PINs are hashed with Argon2id, never logged, never stored client-side.
- **CSRF:** built-in via Auth.js + Next.js form actions.
- **SQL:** Prisma ORM only. No raw SQL outside reviewed migration files.
- **Photo uploads:** validated by content-type (`finfo`-style), stored in **Cloudflare R2** with signed URLs. Files renamed server-side; user filename never preserved. Out of web root.
- **Audit log:** append-only `audit_log` table — every mutation writes a row with actor (user id from session), action, table, row_id, JSON before/after. **Retained indefinitely (no pruning).** Independent of contract retention rules (CA 4yr / OR 5yr) which apply to load records and photos — the audit trail itself lives forever for organizational accountability.
- **Secrets:** `.env` per environment, gitleaks pre-commit + CI, never in code.
- **HTTPS only:** CF tunnel + HSTS header.

### 5.2 iPad-grade UX

- 100% browser-based PWA. **No native iOS app**, no App Store presence, no Apple Developer Program required. Operator iPads install via Safari "Add to Home Screen" → launches full-screen like a native app, automatic updates on every code push. Deploys via the standard fleet pipeline; zero Apple-side friction.
- Targets ≥ 56pt for primary actions (gloves).
- High-contrast color (DR3 deep green on cream / white).
- Body type ≥ 18pt, headings ≥ 24pt.
- One-handed operation viable.
- Landscape-first layouts for dock screens; portrait works but secondary.
- Tested on iPad Gen 9–10 in Safari (iPadOS 16+).
- Sun glare and smudges accounted for: no thin lines, no light-gray-on-white affordances.
- **Native iPadOS voice-to-text** available throughout via the keyboard mic button — no custom recording, no audio files, no transcription API. Operators tap a text field, tap the mic, speak. Subtle "Tap the mic to dictate" tip appears above note fields on first concern submission, then dismisses.

### 5.2.1 Internationalization (i18n) — MVP requirement

DR3-Vision serves a multilingual operator workforce: **English, Spanish, and Urdu** are all spoken at Eugene and Woodland. i18n is built in from MVP day 1 — not retrofitted later. Specifics:

- **Three MVP languages:** English (`en`), Spanish (`es`), Urdu (`ur`)
- **Urdu is RTL** (right-to-left); UI layout flips via `dir="rtl"` with mirrored chrome and Arabic-script font support
- **Per-user language preference** on `users.locale` column; falls back to site default, then to English
- **Translation pipeline:** AI-translated drafts (Claude/DeepL) with bilingual SVdP team review before merge; strings centralized in JSON locale files, never hardcoded
- **Voice-to-text follows the iPadOS keyboard language** — operator's iPadOS language must be set correctly at deployment (deployment checklist item, not a code task)
- **Operator-entered notes preserved in original language** on DR3-Vision records; MyMRC submission layer (Playwright) translates to English before pushing, since the contract requires English reporting (Article 8 + Exhibit H). Both versions retained.
- **Concern/note display in manager portal:** original language shown with a small language tag; on-tap or hover reveals AI translation. Translation is V2.1; MVP shows original + tag.
- **Language coverage at MVP launch:** all operator-facing strings (login, queue, photo capture, stack counter, concerns, rejection, finish/submit, error messages). Manager portal can ship English-only for MVP and add Spanish/Urdu in V2.1 if Morena/managers want it (none of them are likely to need Urdu).
- **Future languages** added by dropping a new locale file and adding the language to the picker — no architecture changes.

### 5.3 Offline tolerance

- PWA with service worker.
- App shell cached for offline launch.
- Mutations (load updates, photo uploads) queued in IndexedDB if network is down.
- Background sync flushes the queue when connectivity returns.
- Optimistic UI for operator actions — local commit advances the screen; sync happens behind the scenes.
- Photos uploaded in chunks with resumable transport (TUS protocol or signed-URL multipart).

### 5.4 Audit-grade

Every record carries `created_by`, `created_at`, `updated_by`, `updated_at`. The `audit_log` table records every state change with actor, before, after, IP, user-agent. MRC and SVdP financial review can answer "who entered this and when?" for any record.

### 5.5 Multi-site

- Sites are first-class entities with their own users, loads, and analytics.
- Every API call is scoped by site (server-enforced from session, not client-trusted).
- Manager dashboard rolls up per-site or all-sites depending on user permission.

### 5.6 Operational

- **Health endpoint:** `/api/health` returns `{status, db, r2, version, uptime}`. NOC probes it.
- **Health endpoint must work without auth** (NOC needs to probe it).
- **GlitchTip DSN** wired via `.env`.
- **Loki** structured logs, OTLP endpoint `http://10.99.0.1:3101/loki/...`.
- **Tempo** traces, OTLP `http://10.99.0.1:4317`.
- **Grafana** dashboard for app + DB + R2 metrics.
- **Daily Postgres backup** to R2, 30-day retention.

### 5.7 Manager portal refresh strategy (Q15)

- **Polling for MVP**, no real-time push (no SSE, no WebSockets in v1)
- **Live dock view:** 5-second polling interval when actively viewed
- **Load list / queue views:** 30-second polling interval
- **Analytics tiles, load detail, Compliance dashboard, exports:** on-demand refresh (manual button or page reload)
- Per-site polling — each site's portal queries its own data scope; no cross-site polling
- Architecture allows future swap to SSE/WebSockets without API contract changes — server-side change only. Likely upgrade trigger: V2.1 "Next up" cast view (Q9) on an office TV where 5-second lag might feel sluggish.

### 5.8 Outage strategy (Q20)

DR3-Vision relies entirely on the offline queue (Pattern C) to ride out outages — **there is no paper fallback**. If the operator iPad cannot reach DR3-Vision and the local PWA cache is unrecoverable, the load cannot be captured through the system. Per Q21 update, this is meaningfully de-risked because **iPads have both site WiFi and built-in cellular service** — two independent network paths to the server. The "no network at all" scenario is rare.

- **Offline-queue scope:** all operator submissions (BOL photo, weight ticket, door-open photo, stack counts, concerns, rejection records, finish/submit) queue locally in IndexedDB when the network is unreachable. Workbox Background Sync replays the queue automatically when connectivity returns.
- **Network paths:** site WiFi is primary; iPadOS automatically falls back to cellular when WiFi drops. Both are confirmed working at Eugene and Woodland (per Q21 confirmation). The PWA does not need to know which path is active.
- **Cache durability:** the PWA shell, all routes, all critical assets, and the active operator's queue must survive iPad reboots, iOS updates, and Safari tab reloads. Service Worker registered with explicit cache versioning; assets served with appropriate `Cache-Control` headers.
- **Photo handling offline:** photos captured offline are stored as Blobs in IndexedDB until upload. R2 upload happens server-side once the submission syncs, not from the iPad directly — this avoids the iPad needing to authenticate to R2 separately.
- **Conflict resolution:** the iPad's queued state is authoritative for the operator's actions; if a manager has reassigned a load on the portal during the outage, the iPad's submission for that load creates a flagged conflict surfaced on the manager portal for resolution. Audit log captures both versions.
- **No silent data loss:** if a queued submission ultimately cannot sync (auth failure, deleted load, etc.), it surfaces as an unresolved-queue alert on the operator's iPad on next login and on the manager portal — never silently dropped.
- **Server outages:** if CHAD-HQ or the database is unreachable, the iPad behaves identically to a network outage — submissions queue, sync resumes when service returns. ntfy fires to Bill via `dr3-vision-system` topic on outage detection (one of the two ntfy-eligible event types per Q16).
- **Hard failure scenario (PWA cache unrecoverable AND both WiFi and cellular unreachable):** documented as an operational risk; mitigation is (a) cache durability engineering, (b) two-path network. No paper recovery path exists.

## 6. Data model (V2)

```
sites
  id, name, timezone, address, is_active,
  -- Jurisdiction & program (Q14)
  jurisdiction enum(ca|or),                -- which state mattress program applies
  mrc_program_code (e.g., "MRC-CA", "MRC-OR"),
  per_unit_rate_usd_current,               -- e.g., 16.50 (CA 2026), 17.00 (OR 2026)
  per_unit_rate_effective_date,            -- when this rate took effect
  billing_cadence enum(mid_and_end_month|end_month_only|other),
  -- Hours (Contract: Article 11.1 — Customer Service hours; Exhibit G — facility hours)
  customer_service_hours_start (e.g., 08:30),
  customer_service_hours_end (e.g., 16:30),
  customer_service_days_of_week (bitmask: M-F default),
  -- Storage limits (Contract: Article 6.5, 6.6 — CA values; OR TBD pending contract review)
  max_units_inside_facility (default 3500),
  max_units_outside_storage (default 5000),
  created_at, updated_at

site_billing_rates                          -- historical rate tracking for back-billing
  id, site_id, per_unit_rate_usd, effective_date, end_date (nullable), notes

site_holidays                            -- federal/local holidays where facility is closed
  id, site_id, holiday_date, label, is_active

site_inventory_snapshots                 -- daily inventory tracking (Contract: storage limits + monthly cert)
  id, site_id, snapshot_date,
  units_inside_facility, units_outside_storage,
  computed_at, manual_count_at (nullable; for monthly physical inventory cert per Exhibit C §3.g)

docks                                    -- V2.1, future
  id, site_id, label, is_active

users
  id, email (nullable for operator-only accounts), name,
  -- Manager/admin sign-in is Microsoft Entra ID SSO only per ADR-0016;
  -- no password column. The Sprint-2 cleanup migration dropped the
  -- vestigial `password_hash` field. Operators sign in with PIN.
  pin_hash (Argon2id; required for all roles that use the iPad),
  role enum(operator|manager|admin),
  locale enum(en|es|ur) default en,        -- per-user language preference; UI + voice-to-text
  is_active, last_login_at,
  failed_pin_attempts, locked_until,
  created_at, updated_at

user_sites                               -- many-to-many
  user_id, site_id, role_at_site

sources                                  -- collection sites + transporters
  id, name,
  kind enum(collection_site|transporter|retailer|mrc_program|other),
  street_line1, street_line2, city, state, zip,    -- nullable; populated from MyMRC seed
  external_mymrc_id (text, nullable),    -- if seeded from MyMRC export
  is_active, notes,
  created_at, updated_at

inbound_loads
  id, site_id, dock_id (nullable),
  source_id (nullable until set; "Other Collection Site" handled via free-text fallback),
  bol_number,                           -- unique per (site_id, arrival_date)
  reference_number (nullable; matches MyMRC "Reference Number" field),
  pickup_street_line1, pickup_city, pickup_state, pickup_zip,    -- parseable address
  dock_appointment_at,                  -- scheduled dock appointment time (Contract: Art 11.3, 60-min SLA)
  expected_arrival_at,
  arrived_at,                           -- when the truck physically pulled up (operator marks)
  assigned_operator_id (nullable until claimed),
  status enum(expected|claimed|receiving|received|rejected|verified|submitted_to_mymrc|processed|closed),
  unload_started_at, unload_ended_at, unload_duration_seconds (computed),
  time_to_unload_start_seconds (computed: arrived_at → unload_started_at; Contract Art 11.3),
  total_units,                                       -- combined count; mattresses+box springs not split (Q7)
  program_unit_count, non_program_unit_count,    -- MyMRC reconciliation columns (split orthogonally to mattress/foundation)
  weight_lbs (nullable; captured at arrival from optional truck-borne weight ticket),
  weight_ticket_photo_id (FK to load_photos, nullable),
  count_mode enum(stack_ledger|multiplier|total),
  notes,
  -- Rejection fields (populated only when status=rejected)
  rejection_category enum(wet|unsafe|wrong_product|bedbugs|contamination|wrong_site|documentation_problem|capacity|short|mislabeled|damaged|other) nullable,
  rejection_note text nullable,
  rejection_note_locale enum(en|es|ur) nullable,    -- language note was entered in
  rejection_reported_to_mymrc_at timestamp nullable,    -- manager marks when MRC notified
  rejection_reported_by user_id nullable,
  -- Processing (Contract: Exhibit H §4 — 1 business day)
  processed_at timestamp nullable,                      -- when fully deconstructed
  processed_by user_id nullable,
  -- MyMRC integration (Contract: Exhibit H §3 — 3 business days)
  mymrc_submission_deadline timestamp,                  -- computed at receipt (3 business days)
  external_mymrc_haul_id (text, nullable),         -- e.g. "H-126152"
  external_mymrc_materials_id (text, nullable),    -- e.g. "M-000300" (daily aggregate)
  mymrc_synced_at,
  mymrc_sync_status enum(not_attempted|pending|success|conflict|failed),
  mymrc_bol_uploaded_at timestamp nullable,             -- BOL photo uploaded to MyMRC (Contract Exhibit H §3)
  created_by, updated_by, verified_by,
  created_at, updated_at, verified_at

load_stacks                              -- replaces V1 space-separated string
  id, load_id, position (1-indexed),
  unit_count,                            -- combined; no type split (Q7)
  recorded_at

load_photos
  id, load_id,
  kind enum(bol|door_open|concern|weight_ticket|rejection|other),
  storage_key (R2 object key — original, untouched),
  annotation_storage_key (R2 object key — annotated overlay PNG; nullable),
  has_annotation boolean default false,
  content_type, file_size, sha256_hash,
  captured_by, captured_at,
  client_lat, client_lng (optional, future)

load_concerns
  id, load_id,
  category enum(damaged|wet|bedbugs|contamination|short|mislabeled|other),
  note,
  note_locale enum(en|es|ur),       -- language note was entered in (i18n; for translation downstream)
  photo_ids (FK array),
  reported_by, reported_at

material_breakdowns                      -- V2.1+, post-processing weight breakdown
  id, load_id,
  steel_lbs, foam_lbs, cotton_lbs, wood_lbs, contamination_lbs,
  weighed_at, weighed_by

mymrc_reconciliations                    -- one row per uploaded MyMRC CSV/XLS reconciliation run
  id, uploaded_by, uploaded_at,
  source_file_name, source_file_sha256,
  total_external_records, matched_count, unmatched_count, conflict_count,
  notes

mymrc_reconciliation_items              -- one row per external haul record vs. our load
  id, reconciliation_id,
  external_haul_id, external_materials_id,
  external_delivery_date, external_unit_count, external_weight_lbs,
  matched_load_id (nullable),
  match_status enum(matched|missing_local|missing_external|conflict),
  conflict_fields jsonb (when match_status=conflict),
  resolved_at, resolved_by

audit_log
  id, actor_user_id, action,
  table_name, row_id,
  before_json, after_json,
  ip, user_agent, created_at

form_templates                           -- V2.2+, when extending beyond loads
  id, code, name, schema_json, is_active
```

Key indexes: `inbound_loads(site_id, status)`, `inbound_loads(assigned_operator_id, status)`, `inbound_loads(external_mymrc_haul_id)` (for reconciliation lookup), `audit_log(table_name, row_id)`, `load_photos(load_id, kind)`, `mymrc_reconciliation_items(external_haul_id)`. `users(pin_hash)` is **not** indexed (lookup is by user id from picker, not by PIN — prevents PIN enumeration).

## 6.5 MyMRC integration model

MyMRC (`mrc-us.my.site.com`) is a **Salesforce Experience Cloud** portal hosted by the Mattress Recycling Council. It is the system-of-record for haul submissions, official unit/weight counts, attached BOL/load photos, and the basis for MRC quarterly invoicing. Today, DR3 staff manually enter haul data into MyMRC after-the-fact — that double-entry is one of the core problems DR3-Vision exists to solve.

**DR3-Vision is the source of truth at the dock.** MyMRC integration layers on top of that, with three modes:

### Schedule sync (MVP — Playwright read direction, hourly)

DR3-Vision pulls the inbound haul schedule from MyMRC every hour during operational hours via Playwright headless-Chrome automation on CHAD-HQ. This is the same robot infrastructure as the V2.1 write direction, run in the opposite direction. Populates the operator's expected-loads queue (§4.1).

- Logs in as the operator user, navigates to the MyMRC haul list filtered to scheduled/upcoming
- Scrapes haul records: Haul ID, expected delivery date, source/collection site, transporter, BOL, reference number, pickup address, expected unit count
- Diffs against current `inbound_loads` state for each site:
  - **New haul in MyMRC** → create local row with status `expected`
  - **Changed haul** (date shifted, source updated, count revised) → update local record; preserve any operator-entered data (counts, photos) untouched; log change in audit_log
  - **Haul removed from MyMRC** → flag local record for manager review (cancellation? data error in MyMRC? still expected?). Doesn't auto-delete.
- **Idempotency:** scraper checks `external_mymrc_haul_id` before creating; loads created locally and pushed to MyMRC (V2.1 write direction) won't be duplicated when the next scrape sees them
- **Failure handling:** ntfy alert on automation failure (`dr3-vision-mymrc-sync` topic). Manager portal shows a "MyMRC last synced: 14m ago" indicator so staleness is visible at a glance
- **Manual override:** manager portal includes a "Schedule a load" form for unscheduled arrivals (retail returns, walk-ups, MyMRC outage). These are flagged `source=manual` and don't get overwritten by future scrapes. Inverse case: if a manual load later appears in MyMRC, the scrape can match by BOL+date and link them.

### Reconcile (MVP — CSV/XLS upload, complementary)

For end-of-day or end-of-week verification — a manager can also upload a MyMRC report export (CSV or Salesforce-flavored XLS) directly:

- Parses the export (Salesforce exports `.xls` files that are actually HTML tables — handles both)
- Matches MyMRC `Haul ID` and delivery date against DR3-Vision loads
- Surfaces three categories of mismatch:
  - **Missing local:** MyMRC has a haul DR3-Vision didn't capture (data leak — load was processed but never logged at dock)
  - **Missing external:** DR3-Vision has a load that never made it into MyMRC (action: submit it via V2.1 write direction)
  - **Conflict:** Both sides have the haul, but unit count, weight, or date differs (action: investigate and reconcile)
- Stores results in `mymrc_reconciliations` and `mymrc_reconciliation_items` for audit
- Manager dashboard shows a daily reconciliation health score per site

### Write (V2.1+ — Playwright browser automation)

When a manager marks a load `verified` in DR3-Vision, the system creates the corresponding haul in MyMRC and attaches photos via headless-Chrome automation:

- **Playwright** running as a containerized service on CHAD-HQ — same robot as the schedule sync, different workflow
- Logs in as the operator user with credentials stored in `~/.dr3-vision-secrets/mymrc.env` (mode 600, gitignored, per fleet §11 secrets layout)
- Navigates the haul-creation UI, fills fields per the §6.5 mapping table, attaches photos from R2 (downloaded to a tmpfs scratch path, uploaded into MyMRC, scratch wiped)
- Submits, captures the resulting `H-NNNNNN` Haul ID from the confirmation page
- Writes back `external_mymrc_haul_id`, `mymrc_synced_at`, status `submitted_to_mymrc` on the local load
- ntfy alert on automation failure (`dr3-vision-mymrc-sync` topic, severity `high`)
- Manual fallback workflow: if the robot is in cooldown after a failure, manager dashboard surfaces the load with a "Submit manually" button that opens the prefilled MyMRC URL in a new tab

**Selector resilience patterns** (mitigates the MyMRC-UI-changes risk for both directions):

- Prefer ARIA labels and data attributes over XPath
- Centralize all selectors in a single `mymrc-selectors.ts` module so a UI redesign is a one-file fix
- Snapshot the page HTML on every successful run; diff on failure to detect what changed
- Weekly health-check against a non-production MRC sandbox if MRC provides one (ask in the email)

**Why not REST API:** Tested 2026-05-04. MyMRC operator user profile does not have "API Enabled" permission. Org-level API surface is reachable but rejects user session. If MRC grants API access in response to the parallel email request, switch from Playwright to Salesforce REST API client at that point — the field mapping table doesn't change, only the transport.

### Field mapping (DR3-Vision → MyMRC)

| MyMRC field                     | DR3-Vision source                                                           |
| ------------------------------- | --------------------------------------------------------------------------- |
| Recycler                        | `sites.name`                                                                |
| Recycler Reported Delivery Date | `inbound_loads.unload_ended_at` (date portion, site timezone)               |
| Collection Site                 | `sources.name` (when `kind=collection_site`)                                |
| Other Collection Site           | free-text fallback when source not in controlled list                       |
| Pickup Address                  | `pickup_street_line1` + `pickup_city`, `pickup_state` `pickup_zip`          |
| Transporter                     | `sources.name` (when `kind=transporter`)                                    |
| Reference Number                | `reference_number`                                                          |
| Unit Count at Unload            | `total_units`                                                               |
| Recycler Program Unit Count     | `program_unit_count`                                                        |
| Recycler Non-Program Unit Count | `non_program_unit_count`                                                    |
| Recycler Weight                 | `weight_lbs`                                                                |
| Status                          | `status` enum mapped to MyMRC vocabulary                                    |
| Commodity                       | hardcoded `"Whole Mattresses and Foundations"` (only commodity DR3 handles) |
| Attachments                     | `load_photos` of kinds `bol`, `door_open`, `concern`, `weight_ticket`       |

### Sources seed data

The `sources` table is seeded on day 1 from the real MyMRC haul export Bill provided (7,046 records, Jan 2023 – May 2026). The seed set is committed to the repo at `prisma/seed/sources.csv` and includes:

- **Top 50 collection sites** by frequency (Western Placer Waste Management Authority, Costco-Innovel-Sacramento, North Area Recovery Station, Yolo County Central Landfill, Neal Road Recycling and Waste Facility, Humboldt Waste Management Authority, Tehama County / Red Bluff Landfill, Redding Transfer Station, Recology Yuba Sutter, etc.)
- **All known transporters** (Ron Lawrence & Son, SVdP/DR3 internal, CH Robinson Worldwide, Titan Concepts International, Fusion Transport California, Total Quality Logistics, Self/customer-delivered, etc.)
- Each row includes `external_mymrc_id` (where derivable) so reconciliation matches deterministically

## 7. Architecture & technology

| Layer         | Choice                                                      | Rationale                                                                                                                                              |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Framework     | **Next.js 15 (App Router) + TypeScript**                    | Single codebase for operator PWA + manager portal. Existing fleet precedent (Guardian). Strong PWA story.                                              |
| ORM           | **Prisma**                                                  | Eliminates SQL injection class-of-bug at the language level. Excellent migration tooling.                                                              |
| Database      | **Postgres 16**                                             | Replaces MySQL/MariaDB. Better constraints, JSON support, partitioning when needed. Single instance on CHAD-HQ initially; replication later if needed. |
| Auth          | **Auth.js v5 (manager/admin) + custom PIN flow (operator)** | PIN-only on iPad with Argon2id hashing. Auth.js handles session cookies for both roles.                                                                |
| Photo storage | **Cloudflare R2**                                           | Already in fleet. Signed URLs. Out of web root. Cheap.                                                                                                 |
| UI            | **Tailwind + shadcn/ui**                                    | Themeable to DR3 brand. Accessible by default. Production component primitives.                                                                        |
| Validation    | **Zod**                                                     | Runtime-validate every input on both client and server.                                                                                                |
| Offline       | **next-pwa** + **idb** + **Workbox Background Sync**        | Service worker + IndexedDB queue.                                                                                                                      |
| Container     | **Dockerfile + docker-compose.yml**                         | Standard fleet pattern. Deployed by `swarmpilot_deployer`.                                                                                             |
| Notifications | **ntfy** (`dr3-*` topics)                                   | Per fleet ADR-0036 / 0037.                                                                                                                             |
| Errors        | **GlitchTip**                                               | Per fleet observability stack.                                                                                                                         |
| Logs          | **Loki via Alloy**                                          | Per fleet observability stack.                                                                                                                         |
| Traces        | **Tempo via OTLP**                                          | Per fleet observability stack.                                                                                                                         |
| Metrics       | **Prometheus → Grafana**                                    | Per fleet observability stack.                                                                                                                         |
| CI            | **Self-hosted runner** `[self-hosted, linux, x64, chad]`    | Per fleet §8. Build + lint + test + (deploy via marker push).                                                                                          |
| Deploy        | **swarmpilot_deployer** auto-deploy from `main`             | Per fleet §7. `[skip-deploy]` for doc-only commits.                                                                                                    |

### 7.1 Fleet integration checklist (pre-launch — per FLEET-PRIMER §12)

- [ ] Service code `dr3-vision` reserved in `~/noc-master/data/service-registry.json`
- [ ] Host placement (`chad-hq`) recorded in registry, `data/config.yml`, README, CHANGELOG
- [ ] Repo scaffolded inside existing `BigBill1418/DR3-Vision`: V1 PHP code moved to `legacy/`; V2 root contains `CHANGELOG.md`, `ROADMAP.md`, `PROGRESS.md`, `docs/PROJECT-CHARTER.md` (this file), `docs/adr/0001-tech-stack.md`, `README.md`, `.env.example`
- [ ] Pre-commit `gitleaks` + workflow `gitleaks` job
- [ ] ntfy helper module copied from peer (Guardian); topics `dr3-vision-system` (deploy/error/health/sync failures) and `dr3-vision-container` (storage container capacity, off-site accumulation); fallback in `ntfy-fallback-topics.yml`. **No ntfy topics for load-operations events** (rejections, long unloads, concerns) — those are in-app signals only per Q16.
- [ ] Deployer config: `services[]` block in `data/config.yml` with stack name, host, health URL
- [ ] CF DNS: `dr3-vision.svdp.us` → existing tunnel, no fresh cloudflared
- [ ] CF Access policy (staff-only access, SSO); aware of 5-destination cap on shared apps
- [ ] CF Healthcheck added to `cf-healthchecks.yml`
- [ ] GlitchTip project + DSN in `.env`
- [ ] Loki/Tempo OTLP endpoints wired
- [ ] Grafana dashboard scaffolded
- [ ] CI workflow with self-hosted runner label `chad`
- [ ] R2 bucket `dr3-vision-photos` provisioned (separate prod / staging buckets)
- [ ] Postgres database `dr3_vision` provisioned on CHAD-HQ; nightly backup to R2
- [ ] Sources seeded from MyMRC export (`prisma/seed/sources.csv` derived from the 7,046-haul export)
- [ ] Verification: `curl /api/status/dr3-vision` returns 200; ntfy test alert renders; CHANGELOG entry; ADR-0001 captured

## 8. Branding

Palette extracted from `mattressrecycling.us` 2026-05-04:

| Token              | Hex       | Notes                                         |
| ------------------ | --------- | --------------------------------------------- |
| `--dr3-green-deep` | `#00524C` | Primary. Headers, primary buttons.            |
| `--dr3-green`      | `#49AD8E` | Secondary. Active state, success affordances. |
| `--dr3-green-dark` | `#0B6662` | Hover/pressed.                                |
| `--dr3-chartreuse` | `#EFFE8B` | Highlight. Sparingly — call-to-action only.   |
| `--dr3-cream`      | `#FCFFD7` | Soft surfaces.                                |
| `--dr3-ink`        | `#1A1A1A` | Body text.                                    |
| `--dr3-white`      | `#FFFFFF` | Default surface.                              |
| `--dr3-danger`     | `#DF080F` | Destructive only.                             |

Logo: clean SVG of the DR3 mark (green "D", black "R3", recycling arrow under the "3"). Source asset to be checked into the repo at `public/brand/dr3-logo.svg` — Bill to provide canonical SVG (don't ship the Wix-CDN PNG).

Typography: open question — see §11. Suggested: **Inter** (UI) + system fallback. The Wix site uses several proprietary Linotype faces we can't license through the fleet; Inter is free, modern, and matches a clean operations brand.

Theming approach: Tailwind config exposes the palette as utility classes (`bg-dr3-green-deep`, `text-dr3-cream`, etc.). shadcn/ui components are themed via CSS variables in `globals.css`.

## 9. MVP scope vs. roadmap

### MVP (target: deployable to Eugene + Woodland concurrently)

- Auth: PIN flow for operators on iPad; email/password for managers/admins in browser
- Site management (Eugene + Woodland active at launch; Stockton excluded; Sacramento future)
- Operator flow: forced BOL photo → optional weight ticket capture (truck-borne, with deliberate dual buttons) → forced door-open photo → **decision point: Begin unload OR Reject load** → (unload path) stack counter (all three modes) → concerns → finish unload (timer stop) → submit; (reject path) category + photo + note → submit, in-app indicator on manager portal
- Unload timer (start on BOL capture, stop on "Done" or rejection submit)
- Manager portal: live dock view, load list, load detail, verify, CSV export, basic analytics tiles, manual "Schedule a load" form for unscheduled arrivals
- Admin: user CRUD (with PIN issuance/reset), site CRUD, source CRUD
- **MyMRC schedule sync (Playwright, hourly):** scrapes MyMRC haul list to populate operator's expected-loads queue. Diff-aware (creates new, updates changed, flags removed). Idempotent (won't recreate locally-pushed hauls). "Last synced: X ago" indicator on manager portal.
- **MyMRC CSV/XLS reconciliation:** upload export → match by Haul ID → surface missing-local / missing-external / conflict items → reconciliation history with audit trail
- Sources table seeded from real MyMRC export (top 50 collection sites + all transporters)
- Operator UI in **English, Spanish, and Urdu** — i18n built in from MVP day 1; per-user language preference; Urdu is RTL with mirrored chrome
- Native iPadOS voice-to-text on all note fields (no custom recording, no transcription API)
- **In-app photo annotation** for concern + rejection photos — circle, arrow, freehand draw, text label; raw original + annotated overlay both stored
- Audit log
- DR3 brand theme
- PWA install + offline submission queue (browser-only, no native iOS app)
- Health, errors, logs, metrics wired to fleet observability
- Daily Postgres backup to R2

### V2.1 (post-launch)

- **MyMRC Playwright write direction** — auto-create hauls in MyMRC from verified DR3-Vision loads, attach photos. Same robot infrastructure as the MVP read/sync direction; new workflow added. ntfy alerts on failure. Switch to Salesforce REST API instead if MRC grants API access in response to parallel email request.
- **BOL OCR safety check.** On BOL photo capture, run OCR (Tesseract or Cloud Vision) and compare extracted BOL number against the expected BOL on the tapped load. Warn (don't block) if mismatch. Protects against mistaps in the queue without changing the manager-led workflow.
- **Whiteboard replacement / "Next up" cast view.** Office TV-mounted dashboard showing incoming-truck queue, currently-unloading status, and dock occupancy in real time — replaces the physical whiteboard. Same data already in DR3-Vision, no double-maintenance, always current.
- Material/weight breakdown capture (post-processing weights, separate from arrival weight)
- Per-dock metrics
- Operator throughput dashboards (cautious framing — coaching tool, not surveillance)
- Voice-to-text for concern notes
- Tablet kiosk-mode lock for shared iPads
- MyMRC quarterly export format alignment if MRC ever publishes a recycler-side report spec

### V2.2+ (paper-process replacement series)

- **Outbound shipment tracking (next paper process — confirmed Q1).** Separate `outbound_shipments` table. Captures: material type (steel, foam, cotton, wood, fabric, other), BOL, recipient/destination, weight, photos. Same end-of-day MyMRC manual-entry pain point as inbound. Shares infrastructure (audit log, R2 photo storage, auth, sites) but not row schema. **Contract deadlines apply: 3 business days for weight + final disposition entry, 5 business days for BOL upload (Exhibit H §7).**
- **Consumer Incentive Program (CIP) check-in workflow.** Separate `consumer_incentive_checkins` table. Consumer drops off mattresses (max 5/vehicle/day) and receives $3/unit cash/check/electronic payment. Captures (Contract: Exhibit A §3.d): date of delivery, **Collector name, phone number, license plate number**, units delivered, incentive amount paid, **Collector signature** (touchscreen capture), receipt issued. Submitted with monthly Incentive Reimbursement Request. Treated as MRC Personal Data under Exhibit I — encryption, breach notification, and 10-business-day deletion-on-termination apply. Will require its own ADR (proposed ADR-0010).
- **Daily Processor Form (deconstruction line tracking) — V2.1 priority.** Replaces the per-processor-per-day paper form currently used at both sites for tracking deconstruction. Critical for compliance — the contract requires processed-unit counts in MyMRC within **1 business day** of dismantling (CA Exhibit H §4, OR Exhibit H — tightest deadline in either contract). Also drives **processor bonus pay calculation** — payroll-adjacent. Captures per processor per day:
  - Site, line number, processor, lead, date
  - **Stack ledger** (S# + count + lead initial) — each stack the processor deconstructed
  - **Per-unit material tally** (mattresses table) — each unit categorized by material composition (foam, fiber, steel, wood, fabric, disposed) — feeds the recycling-rate calculation
  - **Saved units** — set aside for reuse/renovation rather than deconstructed
  - Daily totals: handled, processed, saved, leftover (carried to next day)
  - Two-person verification: lead initials + authorized-by signature before bonus calculation
  - The relationship between inbound load `total_units` and eventual `sum(processed + saved + leftover)` across processor-form sessions is the contractual reconciliation point — schema-design must support this even though MVP doesn't implement it
  - Per-site form variant (Woodland sample seen; Eugene equivalent pending)
  - Will require its own ADR (proposed ADR-0011 — Processing workflow)
- **Oregon Collection Site Count tracking (Eugene only).** Eugene services Oregon collection sites (Salem, Albany, Cottage Grove, Florence) and is paid $2.25/unit for counts at those sites. Captures: collection site name, monthly count, billing period. Feeds the standalone Collection Site Count Invoice. Per-site list extensible (new sites added via admin).
- **Material breakdown weight tracking (Exhibit H §6).** Per-commodity weight (steel, foam, fiber, etc.) sold to secondary markets or sent to landfill/biomass. With purchaser/destination. Drives the 75% recycling rate and 97% reconciliation metrics.
- **Storage Container rental tracking** (Compensation Schedule line item).
- **Collection Event labor tracking** (Compensation Schedule line item — General Labor $90/hr, Driver $125/hr, Per Diem $275/night, IRS mileage).
- **Transportation services tracking** (Collection Zone-based stop charges, Compensation Schedule).
- **Bed bug identification training records** (Contract: Exhibit C §6 — documented training compliance).
- **Monthly Recycling Certificate generation** (Contract: Article 9, Exhibit E — auto-populate from DR3-Vision data, manager signs and submits).
- **Annual Exhibit G submission** (facility hours, holidays, contact info — auto-generate by Dec 15 each year).
- Baling logs, equipment inspections, contamination reports.
- BERC / RMDZ reporting integration when Sacramento consolidation activates.
- QuickBooks (or whatever billing platform) export connector.
- Multi-tenant (other recyclers? unlikely but architecture allows).

## 10. Initial ADRs to capture on day 1

- **ADR-0001 — Tech stack** (Next.js + Postgres + Prisma + R2)
- **ADR-0002 — Fleet host placement** (CHAD-HQ; SVdP tenant)
- **ADR-0003 — Domain & routing** (`dr3-vision.svdp.us`; piggyback existing tunnel; CF Access)
- **ADR-0004 — PIN-based authentication for shared iPads** (numeric PIN, Argon2id, user-picker UI, lockout policy, manager-issued reset)
- **ADR-0005 — Photo storage architecture** (R2, signed URLs, content-type validation, server-renamed, **per-program retention: CA 4 years minimum per Article 8.6, OR 5 years minimum** — system retains the longer of the two for cross-program loads, defaults to 5 years global)
- **ADR-0006 — Offline queue strategy** (IndexedDB + Workbox Background Sync; conflict resolution rules)
- **ADR-0007 — Audit log scope and retention** (what counts as a mutation; **per-program retention: CA 4 years, OR 5 years**; PII handling)
- **ADR-0008 — Brand theme implementation** (Tailwind tokens; shadcn variable mapping)
- **ADR-0009 — MyMRC integration approach** (DR3-Vision is source of truth; CSV reconciliation in MVP; **Playwright headless-Chrome automation on CHAD-HQ as V2.1 write path** per 2026-05-04 API access test result; selector resilience patterns; field mapping; ntfy alerts on automation failure; switch to REST API only if MRC grants API access in response to parallel email request)
- **ADR-0010 — Consumer Incentive Program data handling (V2.2)** — separate workflow, MRC Personal Data treatment per Contract Exhibit I, encryption at rest, breach notification process, 10-business-day data deletion on contract termination, signature capture UX, check-in log generation
- **ADR-0011 — Processor Form / deconstruction-line workflow (V2.1)** — paper-replacement for the daily Processor Form at each site; per-processor-per-day session model; stack-ledger plus per-unit material tally; lead verification; bonus-calculation feed; schema reconciliation between inbound `total_units` and downstream `processed + saved + leftover`. **Bonus formulas (per current 2026 spreadsheet):**
  - **Eugene (Oregon):** daily bonus = `MAX(units − 50, 0) × $1.00 + MAX(units − 100, 0) × $0.25` — additive two-tier
  - **Woodland (California):** daily bonus = `MAX(units − 50, 0) × $0.50 + MAX(units − 75, 0) × $0.25` — additive two-tier, lower rates and tighter high-volume threshold
  - Both jurisdictions share the same formula _shape_ (two-threshold, two-rate) but with different parameters. Modeled as a per-site `processor_bonus_rules` table: `(site_id, threshold_low, rate_low, threshold_high, rate_high, effective_date, end_date)`. Historical rates retained for back-calculation.
  - Eugene tracks roles per processor (Lead, Processor, Machine Operator, Stryo, Floater); California tracks bare names. Schema includes optional `processor_role` field.
  - Eugene reports monthly **bonus dollars** only; California also reports **monthly processed total** (units). Both should be exposed in V2.1 reports.

## 11. Open decisions (to resolve before sprint 1)

1. **Logo asset.** Bill to drop canonical DR3 SVG into `public/brand/dr3-logo.svg` at the start of the Claude Code session. Canva search did not surface a clean vector asset on 2026-05-04. If only PNG exists, vector-trace before launch.
2. **SVdP internal billing format.** 5-minute conversation with Glenn DePrater (CFO) — show him the current monthly file he gets from DR3, ask what he'd want if he could redesign it. Drives the "SVdP Internal Billing Export" format. Until then, MyMRC field names are the default.
3. **iPad procurement and mounting.** Out of scope for the software project but a hard dependency. Need confirmed Gen 9–10 iPads (or newer) at both sites with WiFi + cellular service confirmed working (per Q21 update — already in hand) and dock-rated mounts.
4. **Operator-data privacy posture.** Names visible to managers (yes), names visible across sites (admin only), names included in CSV exports (yes for billing reconciliation, redacted for any external sharing). Document in ADR-0007.
5. **Roll-forward plan if MRC contract terms shift.** Schema designed to absorb new fields; both contracts have 60-day amendment notice provisions; document the change-management cadence.
6. **V1 disposition.** V1 PHP code archives to `legacy/` inside the existing `BigBill1418/DR3-Vision` repo. No production data to migrate. Confirm and document.
7. **Site manager contact info.** Names captured: **Rick Albritton (Eugene)**, **Janette Thomas (Woodland)**. Email + cell needed at deployment for portal account setup; not blocking the build. Neither receives ntfy (Bill-only per ntfy policy).

### Deferred (pending external response)

- **MyMRC API access.** Email sent to MRC contact 2026-05-04 requesting "API Enabled" on operator profile or Connected App setup. Holding on V2.1 write-path implementation pending response. If granted: switch from Playwright to Salesforce REST API. If denied or no response within 30 days: proceed with Playwright per ADR-0009. CSV reconciliation in MVP is not blocked by this and ships as planned.

### Resolved

- **(2026-05-04)** ~~MyMRC API access available?~~ **No (current state).** Tested via `mrc-us.my.site.com/services/data/v66.0/sobjects/`; both cookie auth and bearer-from-cookie returned 401. Operator user lacks "API Enabled". V2.1 write path = Playwright browser automation unless MRC reverses on parallel email request.
- **(2026-05-04)** ~~Oregon MRC contract review?~~ Oregon contract received (markup dated 2024-12-02) and integrated into §1.5 charter section. Eugene runs on Oregon-specific values (70% recycling rate, 6,000 unit storage limit total on-site, 5-year retention, $17 flat through 2027, etc.) — California values do NOT apply.
- **(2026-05-04)** ~~PIN length and policy?~~ **4-digit PIN, 5 attempts → 15-min auto-unlock, disallow obvious patterns (sequential, all-same, repeated-pair), unique within site / reusable across sites, manager-resettable, admin-resettable, audit-logged** per Q21.
- **(2026-05-04)** ~~WiFi reality at Eugene and Woodland docks?~~ **WiFi confirmed good at both sites; iPads also have built-in cellular service as automatic fallback.** Two-path network reliability significantly de-risks the no-paper-fallback decision (Q20). Offline queue can be sized for short outages, not multi-day.

## 12. Success criteria (when is V2 "done"?)

- Deployed to `dr3-vision.svdp.us`, green in NOC.
- Eugene + Woodland: ≥ 30 days of all inbound loads captured in V2 with zero paper backup at both sites.
- Operator session-to-submit median time ≤ 30 seconds beyond actual unload time (i.e., the app doesn't slow operators down).
- Manager portal generates a billing-ready CSV that the SVdP CFO accepts.
- **MyMRC reconciliation passes ≥ 95% match rate** within the launch window (DR3-Vision loads matching MyMRC hauls by Haul ID and date, with unit/weight values within tolerance).
- **MyMRC submission timeliness ≥ 95%** within 3 business days of receipt (Contract Exhibit H §3 — protects against 10% payment withhold).
- **Dock-appointment SLA ≥ 90%** of loads beginning unload within 60 minutes of appointment (Contract Article 11.3 — protects against demurrage chargebacks).
- Audit log clean: every mutation in the launch window has a corresponding `audit_log` row.
- Photo capture compliance: 100% of submitted loads have a BOL photo and a door-open photo.
- Zero security incidents.
- ADR-0001 through ADR-0009 written, reviewed, merged (ADR-0010 deferred to V2.2 with Consumer Incentive workflow).
- CHANGELOG, ROADMAP, PROGRESS, README current at every release tag.

## 13. Out of scope (V2.0)

- Outbound shipment tracking (V2.2)
- Baling, equipment, contamination logs (V2.2)
- BERC/RMDZ reporting integrations (V2.2; awaits consolidation site activation)
- Native mobile apps (PWA only — no app store presence)
- Customer-facing surfaces (everyone is internal staff)
- Public APIs (internal API only; no third-party integration surface)
- Multi-tenant for non-DR3 recyclers

## 14. Risks

| Risk                                                                                                                                                          | Likelihood | Impact       | Mitigation                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPad WiFi worse than expected at dock                                                                                                                         | Medium     | High         | Aggressive offline queue from MVP day 1                                                                                                                                                                                                                                                                   |
| Operators resist new tool                                                                                                                                     | Medium     | High         | On-site iteration during the first 30 days; weekly UX feedback loop                                                                                                                                                                                                                                       |
| MRC reporting requirements shift mid-build                                                                                                                    | Low        | Medium       | Schema designed to extend; ADR-0007 captures change process; MRC has 60-day notice obligation under contract                                                                                                                                                                                              |
| Sacramento consolidation timeline shifts the multi-site rollout                                                                                               | High       | Low          | Site model is data-driven; new site = new row, not new code                                                                                                                                                                                                                                               |
| V1 PHP app accidentally referenced as "the system" by anyone external                                                                                         | Medium     | Low          | Archive V1 to `legacy/` in the same repo once V2 is in production                                                                                                                                                                                                                                         |
| Operators misuse "Total mode" to skip stack-by-stack tracking                                                                                                 | Medium     | Medium       | Manager dashboard flags total-mode loads for spot-check                                                                                                                                                                                                                                                   |
| Shared-iPad PIN sharing between operators                                                                                                                     | Medium     | Medium       | Short idle timeout; auto-logout after each load submission; manager education on audit-trail integrity                                                                                                                                                                                                    |
| MyMRC UI redesign breaks Playwright automation                                                                                                                | Medium     | Medium       | Selector resilience patterns; weekly snapshot diff; ntfy alert on failure; manual fallback workflow with prefilled URL in manager dashboard                                                                                                                                                               |
| MyMRC and DR3-Vision unit counts diverge (data integrity risk)                                                                                                | Medium     | High         | Daily reconciliation dashboard; conflict-resolution UX; audit log preserves both versions                                                                                                                                                                                                                 |
| MyMRC credentials in `.env` get committed                                                                                                                     | Low        | High         | gitleaks pre-commit + CI; secrets in `~/.dr3-vision-secrets/` per fleet §11; mode 600                                                                                                                                                                                                                     |
| **Missed 3-day MyMRC submission deadline → 10% payment withhold** (Contract Exhibit H)                                                                        | Medium     | **High**     | Submission deadline timestamp on every load; Compliance dashboard tracks % on-time; in-app warning at 24h before deadline; daily email digest to Morena summarizing at-risk loads; Playwright automation reduces manual effort                                                                            |
| **Failed 75% recycling rate by weight → potential termination** (Contract Article 6.4)                                                                        | Low        | **Critical** | Material breakdown tracking from V2.1; rolling rate calculation on Compliance dashboard; alert if approaching threshold                                                                                                                                                                                   |
| **Failed 97% inbound/outbound weight reconciliation → 10% payment withhold per pp below**                                                                     | Medium     | **High**     | Weight tracked at every step; reconciliation dashboard; nine-month rolling calculation with predictive alert                                                                                                                                                                                              |
| **60-min dock SLA breach → demurrage chargeback** (Contract Article 11.3)                                                                                     | Medium     | Medium       | dock_appointment_at vs unload_started_at timing; in-app warning badge at 90 min, critical at 110 min on live dock view                                                                                                                                                                                    |
| **Storage limit breach** (CA: 3,500 inside / 5,000 outside; OR: 6,000 total on-site) **→ termination grounds** (Contract: CA Article 6.5–6.6, OR Article 3.5) | Low        | **Critical** | Daily inventory snapshots; live counter on manager dashboard; **ntfy alert via `dr3-vision-container` topic to Bill at 90% capacity** (storage is one of the two ntfy-eligible event types per Q16); immediate notification automation to MRC on hard breach; in-app banner to Morena/Kelsey on dashboard |
| **PWA cache unrecoverable + offline queue lost** (no paper fallback per Q20)                                                                                  | Low        | **High**     | Cache durability engineering: Service Worker versioning, IndexedDB encryption-at-rest, queue replay on every PWA load, queue-health indicator on operator screen, monthly cache-recovery drills documented in deployment runbook                                                                          |
| **Records-retention failure** → audit findings (Contract Article 8.6)                                                                                         | Low        | High         | 4-year retention default for photos/audit/postgres backups; lifecycle policy on R2; documented in ADR-0005 + ADR-0007                                                                                                                                                                                     |
| **Consumer Incentive Program PII breach** (Contract Exhibit I — Personal Data)                                                                                | Low        | **Critical** | V2.2 separate ADR-0010; encryption; access controls; breach notification process; 10-business-day deletion-on-termination automation                                                                                                                                                                      |

## 15. Where to read more (cross-references)

- `/CHANGELOG.md` — code/feature history
- `/ROADMAP.md` — forward plan
- `/PROGRESS.md` — current sprint state
- `/docs/adr/` — every cross-cutting decision
- `/README.md` — quickstart, dev environment, deploy
- `~/noc-master/docs/spec/fleet-integration.md` — fleet integration checklist (canonical)
- `~/noc-master/data/service-registry.json` — canonical service entry for `dr3-vision`
- `FLEET-PRIMER.md` — fleet conventions briefing

## 16. Sprint 2 (Bonus Management, Vision Dashboard, observability)

Sprint 2 ships ahead of the V2.1 backlog. It moves the Woodland processor bonus inside DR3-Vision, gives the product a real landing page, and completes the fleet observability wire-in deferred from Sprint 1. Tickets T-100 through T-125 (see `docs/SPRINT-2-PLAN.md`). The section numbering below is intentional: §12 above remains the original "Success criteria" section; this Sprint 2 section is appended as §16 rather than renumbering the charter.

**Bonus Management System (ADR-0019).** The Woodland daily mattress-handling bonus — previously tracked on paper and an Excel sheet with a wrong high-throughput formula — is replaced by a code-enforced workflow. Daily per-employee entry pulls rates from `processor_bonus_rules` (the off-by-one high threshold corrected from 75 to 74, per ADR-0019 §1, superseding ADR-0011's formula). A monthly state machine (`draft` → `pending_signatures` → `partially_signed` → `signed` → `paid`, with admin `amended`) is server-enforced; daily-entry mutations lock once a month leaves `draft`. Dual sign-off (facility manager + operations manager) carries an asymmetric override — Bill or Morena can sign for Janette; only Bill can sign for Morena — and every signature records actor, timestamp, IP, and user-agent. A co-branded PDF auto-generates on the second signature, uploads to R2, and is delivered to payroll. Amendment (admin-only unlock, "AMENDED" PDF marker, supersedes line), historical browsing, and per-employee plus annual aggregate views with CSV export complete the lifecycle. Woodland-only in V2; the schema is site-scoped so Eugene drops in later. A 5:00 PM Pacific EOD cron publishes to ntfy `dr3-vision-system` when active-employee entries are missing for a Woodland working day.

**Vision Dashboard (ADR-0020).** The root route `/` becomes a branded, role-aware tile launcher replacing the "coming soon" placeholder, surfacing each user's available capabilities and showing V2.1+ work as deactivated Coming Soon tiles. Bill (admin) sees all tiles; Janette and Rick see only their site-scoped, role-appropriate set; the operator PIN flow at `/operator` is unaffected. The tile registry is a single TypeScript array so adding a tile is one entry.

**M365 Graph mail-send (ADR-0021).** Payroll PDF delivery goes through Microsoft Graph (`POST /users/{mailbox}/sendMail`) rather than external SMTP, so intra-tenant `dr3-vision@svdp.us → payroll@svdp.us` mail is recognized by Exchange Online as same-organization and bypasses the same-domain spoofing filters that quarantine third-party-origin SMTP. Token acquisition uses `ClientSecretCredential` against the existing Entra tenant (extends ADR-0016); sends retry with backoff on transient failures, fail open without the Entra env vars, and publish to ntfy on exhaustive failure. Every send is audited.

**Fleet observability wire-in (ADR-0022).** The Sprint-1 deferral (T-018) is closed: OpenTelemetry traces to Tempo, `@sentry/nextjs` errors to GlitchTip (sensitive headers/cookies/PIN scrubbed, fail-open without a DSN), `pino` structured JSON logs to Loki with request-id correlation and field redaction, and an internal-only Prometheus `/metrics` endpoint (404 through the public Cloudflare tunnel). A committed Grafana dashboard and alert-rule set complete the stack; critical alerts route to ntfy, warnings stay in-portal.

**Signature-request emails (ADR-0019 §5a).** Signers are actively prompted by email when their signature is required rather than relying on them to check the portal. On `draft → pending_signatures` (and on amendment re-open) the facility-manager signer is emailed; after the first signature the still-unsigned slot's signer is emailed; recipients resolve from the `users` table (no hardcoded addresses) and every prompt is audited. Fails open — signing still works if mail is unconfigured.

**Shipped tickets (T-100–T-125):**

- **T-100** — Bonus schema migration (`bonus_employees`, `bonus_daily_entries`, `bonus_months`)
- **T-101** — Processor bonus formula off-by-one correction (Woodland high threshold 75 → 74)
- **T-102** — OpenTelemetry SDK + auto-instrumentation → Tempo
- **T-103** — GlitchTip (Sentry SDK) integration
- **T-104** — Bonus employees CRUD (`/bonus/employees`)
- **T-105** — Bonus daily entry grid (`/bonus`)
- **T-106** — Monthly state machine
- **T-107** — Vision Dashboard tile landing (`/`)
- **T-108** — Loki structured logging (pino)
- **T-109** — Prometheus `/metrics` endpoint (internal-only)
- **T-110** — Signature capture flow
- **T-111** — Signature override workflow (asymmetric)
- **T-112** — PDF generation (Playwright, co-branded)
- **T-113** — EOD ntfy enforcement
- **T-114** — M365 Graph mail-send integration
- **T-115** — Grafana dashboard + alert rules
- **T-116** — Amendment workflow (admin-only)
- **T-117** — Historical browsing
- **T-118** — Per-employee + annual aggregate views + CSV
- **T-125** — Signature-request emails
- **T-119–T-124** — Polish, operator residuals (M365 mailbox + observability env vars), and go-live verification

---

**End of charter.** When this document and `service-registry.json` / fleet ADRs disagree, the canonical files win. Update this charter as scope and decisions evolve.
