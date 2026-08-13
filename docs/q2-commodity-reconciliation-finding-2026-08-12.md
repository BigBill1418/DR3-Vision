# Q-2 Finding — where the real commodity-reconciliation data lives (FINDING ONLY)

**2026-08-12 · investigation only, nothing absorbed/wired/built · decision returns to Bill.**

## Confirmed: the absorbed tracker is a sign-off log, not reconciliation data

`doc_commodity_audit_rows` (252 rows, from **"Woodland Data Auditing Tracker
(1).xlsx"**, doc*source `9f71ccb3…`) columns are exactly:
`audited, audit_date, initials, second_audit, second_audit_date, second_initials,
status, confirmed_by, discarded*\*, stream_label, month_label, …` — an
audited-yes/no + who + when log across commodity bands (FOAM, METAL-GreenZone,
METAL-SA, WOOD-{Biomass,Renovation,Sierra,Yolo}, PLASTIC/CARDBOARD/…, TOPPERS,
TRASH-Yolo, XTRACTION). **No weight, no dollar amount, no invoice number, no
expected-vs-actual variance.** The handoff's premise holds — Layer B
reconciliation cannot be built from this file.

## Candidate files carrying the ACTUAL reconciliation inputs

From `doc_ingest_reachable_items` (160 rows, 8 distinct files in the Woodland
`docs-dr3` share, all owner `kelsey.ruhland@svdp.us` except the machine list):

| File                                     | Size       | Modified   | Why it is the likely reconciliation source                                                                                                                                  |
| ---------------------------------------- | ---------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Woodland Outbound Auditing 2026.xlsx** | **461 KB** | 2026-07-30 | Largest audit-family file; "Outbound" = shipped commodity loads — the population a MyMRC-vs-invoice cross-check reconciles. Most probable home of per-load weights/amounts. |
| **Woodland Invoices tracking.xlsx**      | 52 KB      | 2026-07-29 | Invoice side of the cross-check — invoice numbers and dollar amounts.                                                                                                       |
| TEREX.xlsx                               | 481 KB     | 2026-07-29 | Throughput/equipment (already partly absorbed, ADR-0079/0081) — not commodity reconciliation.                                                                               |
| DR3 Data Tracking.xlsx                   | 331 KB     | 2026-07-29 | General tracking; unclassified — worth a column look but not obviously reconciliation.                                                                                      |

Other reachable files (not reconciliation): DR3 Machine List, DR3 Meeting Notes
Log, DR3 Task Lists, JOURNAL Woodland Facility, Woodland Trailer list.

**Reachability note:** the sweep already flags this exact gap — anomaly row:
_"Vision can READ 11 documents in scope but is WATCHING only 3. 8 reachable
documents are …"_. The two named candidates are in the readable-but-unwatched
8; the app can see them, it just has not sampled their columns because they
were never added as watched `doc_sources`.

## Honest limit of this finding

I did **not** open the two candidate files' actual cells — reading them means
decrypting the Graph refresh token (AES-256-GCM under `MYMRC_CRED_KEY`) and
pulling bytes, a live-credential action beyond a finding-only task that risks
touching the one live ingest connection. What is proven: the files **exist, are
reachable, and are named/sized/owned consistently with carrying the real
reconciliation inputs**. Their exact columns — do they actually hold
per-commodity weight + amount + invoice + variance — are **unconfirmed until
someone samples them**.

## Recommendation to Bill (decision returns to you)

The cheap, read-only next step: add **Woodland Outbound Auditing 2026.xlsx**
and **Woodland Invoices tracking.xlsx** as watched `doc_sources` and let the
existing classifier sample their headers — turning "likely" into "confirmed"
without building any Layer B. Whether to then wire reconciliation is a
separate, later call.

---

## CONFIRMED 2026-08-12 (evening PT) — columns sampled, join question answered (handoff #259 Phase 1)

Both candidates were added as watched `doc_sources` (audited under Bill's user id,
`system:handoff-259-phase1-register`, identity taken from `doc_ingest_reachable_items`)
and sampled by the live pipeline itself: sweep run `28997020` cut + applied one
version of each, ADR-0067 Am.8 header detection resolved **strong** header rows
past the MyMRC banner rows (Jan sheet: header row 10 under 7 title rows), and the
classifier filed proposals only — nothing was confirmed, so the ADR-0069
absorption path never ran and no money data touched any typed table.

### Woodland Outbound Auditing 2026.xlsx — the WEIGHT side (MyMRC report exports)

Monthly sheets (`Outbound Jan 2026` … `June2026 Outbounds`) plus per-commodity
pivots (`Wood`, `Foam_Topper`, `steel`, `trash`, `xtraction (2)`, `other`). Row
grain = one outbound materials record. Actual columns:

`Account Name · Materials: Record Type · Materials: Materials ID (M-xxxxxx, unique
per row) · Materials Status · Shipment Date · Outbound Vendor Materials Record
(VC-xxxxxx vendor codes, 9–11 distinct) · BOL ID · Total Outbound Weight ·
<commodity> (lbs) + <commodity> Disposition × 13 commodity families · Number of
Program/Non-Program Units · Total Outbound Materials Weight`

**Per-commodity weight: YES. Dollar amount: NO. Invoice number: NO. Variance
column: NO** (the paired `Total Outbound Weight` vs `Total Outbound Materials
Weight` totals differ by ~0.1% on Jan — an internal check, not a vendor variance).

### Woodland Invoices tracking.xlsx — the MONEY side (hand-kept)

Sheets `WOODLAND 2026/2025`, `STOCKTON 2026/2025` + a small `Sheet1` pivot.
Actual columns:

`Present on Daily Log · desk receipt · Invoice Date · Amt. · credit amt ·
category · Invoice # · Notes · Machine ID · day · commodity · gallons`

**Dollar amount: YES (`Amt.`/`credit amt`). Invoice number: YES (124 distinct in
2026). Weight: NO. Variance column: NO.** It is an expense-and-invoice log
(categories: Transportation, Machinery/Truck/Building Repair, Supplies, Diesel,
**Commodity**, **Transportation/Commodity**, recycling), not a reconciliation —
the reconciliation was never IN either file, which is consistent with the
sign-off tracker recording only _that_ someone checked.

### The join answer (the crux)

- **No shared machine key.** All 275 `Invoice #` values were checked against all
  816 `BOL ID` and 831 `Materials ID` values across every Outbound sheet:
  **zero overlap** either way.
- **The linkage exists, hand-recorded in `Notes` and `commodity`:** invoice rows
  carry `ticket number 2378/2438/2447/2449` (ticket 2378 IS a Feb BOL ID),
  explicit `M-152487, M-153183, …` Materials-ID lists, tonnages + rates
  ("4.17 tons at $200/ton, 8,340 lbs"), and `in MyMRC <date>` cross-references.
  The `commodity` column on 29 rows holds **haul numbers (H-130100 …)** — a
  direct key into Vision's own `inbound_loads`/MRC hauls for inbound
  transportation invoices.
- **Verdict: Layer B is buildable from these files** at the grain the data
  actually supports: **(month × commodity × vendor)** — Outbound lbs by commodity
  by VC-vendor by date, × rate, vs Commodity-category invoice `Amt.` by date —
  with **per-load exact matching available for the subset** whose Notes carry a
  ticket/BOL or M-id (heuristic text parse), and **exact per-haul matching on the
  inbound side** via the H-numbers. A strict per-load outbound↔invoice key does
  not exist and would need vendors' invoices to start quoting BOL IDs.

### Two cautions recorded at the same time

1. **Do NOT confirm the classifier's proposal on the Outbound file.** It proposed
   `commodity_audit_tracker` (conf 0.30) — the class whose absorber expects the
   sign-off-log shape. Confirming it would absorb a weights workbook under the
   wrong contract. It needs either a new class or to stay unconfirmed until
   Layer B is designed.
2. **Both files live on Kelsey's personal OneDrive** (`kelsey.ruhland@svdp.us`,
   departed 2026-08-08) — as do 4 of Vision's 5 watched sources. If her account
   is deprovisioned, the live links die (R2 keeps every ingested version, so
   history survives). Moving the canon to a team/SharePoint library is the same
   move ADR-0067 Am.6 §E already recommends for discovery.
