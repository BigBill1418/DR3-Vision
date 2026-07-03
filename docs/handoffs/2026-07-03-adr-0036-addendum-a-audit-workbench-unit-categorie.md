# ADR-0036 — Addendum A: Audit Workbench, Unit Categories, Transport Rate Table

**Date:** 2026-07-03 · **Amends:** `docs/handoffs/2026-07-03-adr-0036-build-mission-operations-continuity-mrc-b.md` (merged) · **Sources:** Kelsey Ruhland survey addendum (via Bill, 2026-07-03); `Stockton_Tracking_2026.xlsx`; `renegotiate_trans_rates.docx`

## A1. P1 expansion — the Audit Workbench (Kelsey's UX spec)

Kelsey's addendum, verbatim: *"I built a category breakdown into the dynamic daily log that Janette is using, which makes auditing so much more efficient. It has a few other handy shortcuts on it that make auditing faster, such as auto outbound weight calculation, auto inventory adding, etc. Having auditing shortcuts in DR3 Vision like these would be super helpful."*

Reframe P1 as **engine + workbench**. The 3-way reconciliation engine stands as specced (§6-P1 of the mission doc); the workbench is its human-facing surface, transcribing the shortcuts she hand-built in Excel:

- **Category rollups** — daily inbound/processed counts by unit category (A2), the breakdown that makes her audit fast
- **Auto outbound weight calculation** — derived, never entered: bale count × average-per-bale (structure already present in the Commodities blocks); standard per-unit weights for whole-unit loads where applicable
- **Auto inventory rolling** — running ledger: prior inventory + inbound − processed − renovator whole units, auto-rolled at daily close, reconciled against Pool-A `site_inventory_snapshots` and the quarterly MRC physical counts (Christine/Mark P)
- **One-click drill-down** — every rollup cell traces to its slips/loads/photos

**Pending input:** the *current* daily log file (Janette's live copy) — the March 2026 version analyzed for the Track 2 decisions predates Kelsey's category-breakdown addition. Bill to re-upload; exact shortcut inventory and category list fold in as a follow-up commit. Build the workbench frame against A2's minimum categories; do not block P1 on the file.

## A2. Unit-category dimension (new schema requirement)

The MRC Monthly Recycling Summary — which the COR certifies under penalty of perjury — reports **Mattresses and Foundations as distinct quantities and weights**; MyMRC's commodity label is "Whole Mattresses and Foundations." No category split exists anywhere in the shipped inbound capture (stack counter counts units only). Vision cannot generate the monthly summary, or Kelsey's category audit, without this dimension.

**Capture point — resolved by prior locked decision, not new debate:** ADR-0033 Track 2 locked *office desktop entry only, iPad untouched* for the daily-log replacement. Categories therefore enter at **office daily close**, mirroring today's spreadsheet workflow. **The iPad operator flow does not change; the 07-08/09 Woodland go-live proceeds as planned.** Minimum category set: `mattress`, `foundation` (MRC reporting requirement); extend to Kelsey's full list when the current daily log lands. Schema: category-quantified daily-close lines, not a load-level attribute — a single haul mixes categories.

## A3. P2 expansion — collection-site transport rate table + a live underbilling

`renegotiate_trans_rates.docx` reveals the freight model: **per-site, mileage-based charges to MRC** — and the mileage figures are Stockton-era holdovers. Actual Woodland distances run **+34% to +1240%** (GVCC Stockton Yard 5→67 mi; WARF Buena Vista 38→197; Recology Mountain View 33→118; Bay Counties SMART 32→112; most routes +100–300%). Since the 06-09 Stockton diversion, every transport-charged haul from these sites has been billed on badly understated mileage — quantifiable mission-dollar leakage per truck.

Build: **`collection_site_transport_rates`** — site, mileage basis, rate, **effective-dated history** (renegotiation lands as a dated rate change; retro-audit prices historical hauls under the rate in force). Freight on transport-charged loads becomes **computed, never typed**. Write access: **Rick, manager-scoped** (same pattern as `container_rental_sites`). Vision generates the **rate variance report** (billed vs actual mileage per site) — the negotiation exhibit, replacing the hand-built docx.

Human side: renegotiation with MRC is MRC-point-person work → **Bill (interim seat)**, priority given the deltas. **Missing datum:** the $/mile (or formula) converting mileage → freight dollars — not in `MRC-CONTRACTS.md`, contracts not mounted. → **Kelsey July capture item #8.**

## A4. Renovator channel schema note

`Stockton_Tracking_2026.xlsx` Reno tab shows **component-only sales** — wood lbs with no whole units (e.g., US Mattress, 13,112 and 17,444 lbs wood). Renovator records: `whole_units` nullable; wood/steel/foam weights independent; recovery-rate math handles both shapes per MRC rules.

## A5. Additional template-defect exhibit (mission doc §4.1)

Every commodity block in the *Stockton* tracker is header-labeled **"Woodland"** — copy-paste identity drift across a site boundary. In Vision, site derives from the record; the defect class is structural, not procedural. The Stockton tracker itself retires 2026-07-11 with the Vendor Agreement; its pattern (inbound log + processed-by-date + commodities + renovators) is absorbed by the per-site Vision modules.

## A6. Kelsey July capture list — amended

Adds: **(8)** $/mile freight rate basis per the transport model; **(9)** current daily-log category definitions + full shortcut inventory (or Bill re-uploads the live file, preferred).
