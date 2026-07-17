# 2026-07-17 — MRC billing tune-and-launch rollup

**Session arc (Claude ↔ Bill, 2026-07-17):**
- Kelsey delivered substantive Q1/Q3/Q4 answers plus flagged Q2 as buggy
- Rick delivered the CA + OR rate template workbooks, business rules, and site-type taxonomy
- Two real production PDFs landed: mid-month COR + IVC072871 mid-month invoice
- Bill dropped corrected June workbook with fixed opening-balance calculation
- Draft emails composed for Rick (two rounds of follow-ups) and Kelsey (walkthrough scheduling)

**Supersedes / adds to:**
- PR #91 (`2026-07-09-full-rollup-mary-morena-july-terex-eugene-2026-07.md`) — carries forward, this handoff extends the billing module scope
- Rick's answers close ADR-0040 D1/D2/D3 open items; Kelsey's answers close ADR-0037 §4.4 program/non-program routing

**File transfer status:** same constraint as PR #91 §7 — sandbox network-isolated, files must arrive via one of the three fetch methods. New files added to the manifest in §11.

---

## §0 — Executive summary

**All three P2 billing ADRs (0040 / 0041 / 0042) shipped. Now moving to tune-and-launch phase.** This session locked in the business rules and reference data needed to run the module against real numbers.

**Concrete outputs:**
1. **Site type taxonomy expanded to 4** (mrc_inbound / cvp_retailer / collection_site / third_party_inbound) with per-type billing rules
2. **All OR trans rates locked** for 7 named sites; Roseburg tabled as non-program until MRC signup
3. **Woodland transportation rule (transitional):** always use Primary rate + Primary mileage from variables sheet, ignoring load's actual site assignment; fallback to Event Mile Rate tier when no Primary defined
4. **Pilot / preview mode required for ADR-0041** — invoices generated but routed only to Bill + Rick until sign-off, nothing to MRC
5. **Program-first sequential depletion confirmed** (Kelsey Q1) — model changes in ADR-0037 §4.4 landed
6. **Corrected June closing balance: 3,977 (was 4,062)** — split 3,748 program + 229 non-program
7. **CA rate infrastructure ready to seed** (44 container rentals + Event Mile Rate tier + ~90 sources on variables)
8. **OR rate infrastructure ready to seed** (5 container rentals + trans rates + collection billing structure)
9. **Real GP invoice format captured** — customer ID `MRCL001`, sales ID `34`, PO format `M/DD/YY DR3W`, MRC billing address, two-line UNITSMO structure

**Numbers Rick gave that go straight into config:**
- CA processing rate: $16.50/unit (confirmed from IVC072871)
- CA fuel surcharge: `(EIA West-Coast weekly ÷ 6.5 mpg) × miles`, trigger $5.05, formula CA-only
- CA event mile tier: 0-25→$425, 26-50→$600, 51-100→$925, 101-200→$1,450, 201-300→$2,000, 301-400→$2,500, 401-500→$3,000
- Container rentals **never prorated** (closes C-10)
- OR has **no fuel surcharge** — resolver skips for OR sites

---

## §1 — Kelsey's Q&A responses (from 2026-07-17 session)

### §1.1 — Q1: Processed sheet mapping + sequential depletion (ANSWERED)

**Column mapping confirmed:**
- D = program units processed (stripped)
- E = non-program units processed (stripped)
- J = ticket number (M-##### format, MyMRC material number)
- Rows keyed by "Day N" label

**New business rule (major):** *"program units are always processed first, so non-program processed units are only subtracted from the inventory when there are no program units left."*

**Build implication (ADR-0037 §4.4):** inventory ledger operates two sequential pools:
```
program_available = program_open + program_inbound
non_program_available = non_program_open + non_program_inbound

for each day:
  daily_stripped = read from Processed!D (program) or Processed!E (non-program)
  program_stripped_today = min(program_available, daily_stripped_total)
  non_program_stripped_today = max(0, daily_stripped_total - program_available)
```

**Partial answer to saved_units:** Bill's working theory is that saved_units = non-program inventory not yet drawn down. Pending Kelsey walkthrough confirmation.

### §1.2 — Q3: Program vs non-program routing (ANSWERED)

**Routing table lives in `list!` sheet.** Non-program sources column drives the "NP" flag on the daily log and totals under "Non-Program Inbound" on daily log summary.

**Build implication (ADR-0037):**
- Parse `list!` sheet, extract Non-program sites column → `sources.is_non_program` boolean
- Add editable list at `/admin/sources` — Janette/Rick can flip flag per source
- Add write-in override at iPad entry — one-off non-program tag with free-text source name (Kelsey anticipated needing this)

Ships as ADR-0037 amendment. Small change, no schema break.

### §1.3 — Q4: Consumer drop-off traceability (ANSWERED)

**Two field additions to unpaid drop-off records:**
- `consumer_name` (nullable string) — for traceable records
- `incentive_amount_cents` (nullable int) — Kelsey wants explicit dollar/check amount captured even though it's `units × $3` Bye Bye Mattress, to save Janette mental math

**Build implication:** small schema addition to `inbound_loads` (or wherever unpaid drop-offs land). iPad entry form gets two new fields on the drop-off type. Deterministic default: `incentive_amount = units × $3` unless overridden.

### §1.4 — Q2: Opening balance (CORRECTED, see §2)

Bill dropped corrected June workbook; full analysis in §2.

### §1.5 — Kelsey's remaining walkthrough items (5, deadline 8/1)

Bill sent scheduling email. Items:
1. Commodity → invoice-block mapping (biggest, gates ADR-0041 §3.1 outbound math)
2. saved_units confirmation (partial answer already; walk-through verifies)
3. DAY6 ×5 formula-level mystery
4. % column on Steel / Biomass / WTE outbound
5. Event units validity as inbound type
6. MRC contact map + Re-TRAC / CalRecycle filing (for post-8/1 compliance handoff to Bill)

---

## §2 — Corrected Processed sheet analysis

**File:** new June workbook uploaded 2026-07-17 (SHA `1eeeccbde0db7824aaf859b4352c7ac5e28ccba9efa319adb0976e635a966295`), 759,720 bytes. Replaces earlier June workbook (SHA `301fcc2c...`, 716,398 bytes).

### §2.1 — What changed

**Opening balances unchanged:**
- Processed!D5 = 1,423 (program opening) — formula `='DAY1'!L2`
- Processed!F5 = 0 (non-program opening) — was implicit in old sheet, now explicit

**Closing balance corrected:**
- Old total close: 4,062
- **New total close: 3,977**
- Delta: 85 units

**Layout change: sheet now explicitly separates program vs non-program inventory tracking with three labeled totals:**

```
Row 42:  D42 = D5 + F40 - D40                  Program in Inventory
             = 1,423 + 19,451 - 17,126 = 3,748
Row 45:  D45 = F5 + E40 + G40 - H40 - I40       Non-Program in Inventory
             = 0 + 0 + 229 - 0 - 0 = 229
Row 48:  D48 = D42 + D45 - H40 - I40            Total Units in Inventory
             = 3,748 + 229 = 3,977
```

### §2.2 — Column semantics confirmed via real formulas

| Col | Header | Sourced from | Formula (Day 1 example) |
|---|---|---|---|
| C | Daily Total | F + G | `=IFERROR(F9+G9,"")` |
| D | Daily Program stripped | DAY!I39 | `=IFERROR(INDIRECT("'DAY" & ROW()-8 & "'!I39"),"")` |
| E | Daily Non-Program stripped | (DAY sheet equivalent) | array formula, resolves 0 in June |
| F | Daily Program inbound | DAY!I38 - G | `=IFERROR(INDIRECT("'DAY1'!I38"),"")-G9` |
| G | Daily Non-Program inbound | DAY!L39 | `=IFERROR(INDIRECT("'DAY" & ROW()-8 & "'!L39"),"")` |
| H | Sold units | DAY!I40 | `=IFERROR(INDIRECT("'DAY" & ROW()-8 & "'!I40"),"")` |
| I | Landfilled | DAY!I41 | `=IFERROR(INDIRECT("'DAY" & ROW()-8 & "'!I41"),"")` |
| J | Ticket # (M-#####) | DAY!K39 | `=IFERROR(INDIRECT("'DAY1'!K39"),"")` |

**Parser now has exact DAY-sheet cell references for each column — no inference needed.**

**Bug in F9 (Day 1 program inbound):** hardcoded `'DAY1'!I38` (missing INDIRECT with ROW()-8). Every other day uses the correct pattern. Harmless because Day 1 → DAY1 either way, but flag for future days shifting.

### §2.3 — Latent formula bugs (Vision uses correct arithmetic, ignores literal)

**D45 formula:** `=F5+E40+G40-H40-I40` — this ADDS E40 (non-program stripped) instead of subtracting. In June it's harmless because E40=0 (no non-program units stripped this month). Any month where program pool runs dry and non-program starts getting stripped, this formula will overstate non-program inventory.

**D48 formula:** `=D42+D45-H40-I40` — double-subtracts sold/landfilled (already deducted in D45). Same harmless-because-zero this month.

**Vision uses correct arithmetic in code:**
```
program_close = program_open + program_inbound - program_stripped
non_program_close = non_program_open + non_program_inbound - non_program_stripped
total_close = program_close + non_program_close - sold - landfilled
```

Not the literal workbook formula. Fixture assertions use CORRECT arithmetic outputs.

### §2.4 — Monthly totals for June (from D40 SUM formulas)

```
C40 = 19,680   total inbound (all pools)
D40 = 17,126   program stripped
E40 =      0   non-program stripped
F40 = 19,451   program inbound
G40 =    229   non-program inbound
H40 =      0   sold
I40 =      0   landfilled
```

Reconciliation: F40 + G40 = 19,680 = C40 ✓. All processed units came from program pool (E40 = 0).

### §2.5 — MRC billing basis clarified

**MRC pays on program units processed only** (not non-program). For June:
- Program units processed: 17,126
- At $16.50/unit CA rate: **$282,579** (June EOM MRC invoice)
- Non-program processed (0 this month): tracked in Vision but NOT billed to MRC

**ADR-0041 schema addition:**
- `invoices.program_units_processed` (billable basis)
- `invoices.non_program_units_processed` (tracked, off-invoice)

Mid-month invoice IVC072871 showed 10,307 UNITSMO — this is Woodland program units processed July 1-15. Non-program count wasn't on the invoice at all, consistent with this rule.

### §2.6 — DAY6 finding

DAY6 shows all zeros on the Processed sheet in the corrected workbook (row 14: C14=0, D14=0, F14=0, G14=0, ticket "M-"). Confirms DAY6 was a no-processing day (weekend/closure), which is why it uniquely has the cotton block — it's the day someone was adding an ad-hoc commodity block, not producing.

---

## §3 — Rick's business rules (from 2026-07-17 session)

### §3.1 — Glenwood TC 143/144 correction

**"The numbers refer to the trailer and have no bearing on billing. this is just used for us to know what trailer is full since they have 4."**

Sources seeded 2026-07-10 as separate entities `Glenwood TC 143` and `Glenwood TC 144` are wrong. Consolidate to single source `Glenwood` with 4 trailers = $400 container rental.

**Migration:** merge existing seed rows into one, aliases table entries redirect `Glenwood TC 143` and `Glenwood TC 144` to the canonical `Glenwood`.

### §3.2 — Four site types (billing routing)

**New enum on `sources`:** `site_type` with values `mrc_inbound | cvp_retailer | collection_site | third_party_inbound`.

| Type | Trans | Trailer | Per-mattress | MRC unit rate | Examples |
|---|---|---|---|---|---|
| `mrc_inbound` | ✓ | ✓ | — | ✓ | Glenwood (OR), all CA MRC sites |
| `cvp_retailer` | ✓ | ✓ | — | — | Rifes (OR) |
| `collection_site` | ✓ | ✓ | ✓ ($2.25) | ✓ | Albany/Salem/Florence/Dalles SVDP (OR) |
| `third_party_inbound` | — | — | — | ✓ | Thompsons Sanitary Service, Stayton, Deschutes, Sponsors (OR — MRC-contracted haulers deliver, DR3 processes only) |

**Cottage Grove edge case:** `collection_site` with trans + trailer suppressed (produces too little to qualify) — `bill_trans=false`, `bill_trailer=false`, per-mattress still charged.

**Roseburg:** currently non-program. Seed as `active_billing=false` — no invoice lines generated. Reactivate when they sign MRC.

**Illegals (Oregon-specific):** treated as **program units** — feed program-first depletion pool. Rick said "illegals are treated the same as unpaid, but Oregon does not receive that many that has their own category. We call them illegal."

Load source kind enum: `mrc_program | non_program | collection | unpaid_dropoff | illegal_dropoff | event`. Pool routing: mrc_program + collection + unpaid_dropoff + illegal_dropoff → **program pool**; non_program → **non-program pool**. Events tracked separately.

### §3.3 — OR trans rates (all destinations → SVDP Prairie Rd Eugene)

| Site | Trans | Trailer | Per-mattress | Type | Status |
|---|---|---|---|---|---|
| Glenwood Transfer Station | $200 | $400 (4× 28ft) | — | mrc_inbound | active |
| Roseburg Transfer Station | (n/a) | (n/a) | (n/a) | non-program | **inactive** — signup pending |
| Albany SVDP | $350 | $100 | $2.25 | collection_site | active |
| Florence SVDP | $500 | $100 | $2.25 | collection_site | active |
| Salem SVDP | $500 | $100 | $2.25 | collection_site | active |
| The Dalles SVDP | $1,000 | $100 | $2.25 | collection_site | active from ~2026-06-01 |
| Rifes | $200 | $100 | — | cvp_retailer | active |
| Cottage Grove | — | — | $2.25 | collection_site (special) | active |

Effective dates: seed all as `effective_from: 2026-01-01` except The Dalles at `effective_from: 2026-06-01`.

### §3.4 — Pilot / preview mode for ADR-0041 (NEW)

**Rick asked, Bill agreed:** invoices generated by Vision are routed to Bill + Rick only, NOT to MRC, until Rick reconciles against his own spreadsheets and signs off.

**Schema addition:**
- `invoices.mode` enum: `pilot | production`
- `invoice_pilot_recipients` config table (or hardcoded to Bill + Rick during pilot)
- Rick's approval flow adds a **"flip to production"** toggle per invoice kind (or per site)
- Default mode = `pilot` until explicit flip

**Behavior:**
- Pilot: full audit trail, generate PDF, email preview to pilot_recipients, ADR-0039 audit runs, DO NOT send to MRC
- Production: same generation, sends via normal MRC delivery (Mary types into GP)

Ships as ADR-0041 amendment. Small schema change, meaningful safety net for launch.

### §3.5 — Woodland transportation rule (transitional)

**Rule:** For any Woodland load, always use the source's **Primary** haul rate + **Primary** mileage from variables sheet, regardless of the load's actual site Assignment (Primary/Secondary/Tertiary). Temporary pending rate renegotiation.

**Freight resolver logic for Woodland:**
```
1. If Woodland load and source in variables:
   → use Primary rate + Primary miles for that source
2. If Woodland load and no Primary destination defined:
   → fall back to Event Mile Rate tier by mileage (§3.7)
3. If neither works:
   → FreightUnresolvableError (source unknown)
```

CA (non-Woodland Stockton) uses normal Assignment-based resolution.

### §3.6 — Container rentals never prorated (closes C-10)

Full month rate for any overlap, even a rental that starts on the 28th and continues into the next month. Full month in both months. Documented in ADR-0040.

### §3.7 — Event Mile Rate tier (CA only)

Extracted from `Variables!D6:F13`:

```
0-25 miles     → $425
26-50 miles    → $600
51-100 miles   → $925
101-200 miles  → $1,450
201-300 miles  → $2,000
301-400 miles  → $2,500
401-500 miles  → $3,000
```

Also serves as the fallback rate table for Woodland loads without a Primary destination (§3.5).

### §3.8 — Workbook date irrelevance

**Rick: "The workbooks are current. Don't worry about the date. Those are my templates that way I don't have to re-create the spreadsheet every month."**

CA Dec 2025 and OR Jan 2025 rate rows are current production values, not historical snapshots. No version-drift concern.

---

## §4 — Real production artifact analysis

### §4.1 — COR sample (`Scan_084.pdf`, mid-month July 2026)

**Signer:** Richard Albritton, **"Transportation Manager"** — closes Q-5 in QUESTIONS.md registry. ADR-0042 `cor_signer_title` seed is correct.

**Mid-month COR discovery:** the form is used for BOTH end-of-month AND mid-month periods. Rick filed a "mid month July 2026" version with:
- Inventory field: BLANK
- FT worker count: BLANK
- PT worker count: BLANK
- Signature + Date populated

**ADR-0042 amendment required:**
- Add `period` enum on `cor_certificates`: `end_of_month | mid_month`
- On `mid_month`, inventory + FT + PT fields are optional (renderer prints blank)
- Pre-render reconcile assertion (D3) runs only on `end_of_month`
- June-3,977 fixture stays end-of-month only
- Capacity banner stays end-of-month only

### §4.2 — Mid-month invoice sample (`7_15_26_MRC_IVC072871_Mid_month_July.pdf`)

**GP invoice specifics for Vision's export contract:**

| Field | Value | Notes |
|---|---|---|
| Invoice # | `IVC072871` | 6-digit sequence, IVC prefix, GP-assigned |
| Date | 7/15/2026 | Mid-month cutoff |
| Bill To / Ship To | Mattress Recycling Council, Attn: Ryan Trainer, 501 Wythe Street, Alexandria VA 22314 | Static — one config row |
| Customer ID | `MRCL001` | CA MRC. **OR MRC customer ID unknown** — pending Mary |
| Sales ID | `34` | Confirmed static (Mary's rep code, pending Mary confirmation) |
| Purchase Order | `7/15/26 DR3W` | Format: `M/DD/YY [site_suffix]`. Site suffixes: `DR3W`=Woodland. Eugene TBD (pending Mary) |
| Payment Terms | `Net 30` | Static |
| Rate | $16.50/unit | CA processing rate — matches state_program_rules seed |

**Two-line item structure:**

```
Line 1: LOCATION | (item empty) | "total units processed 7/15/26"    Each  $0.00  $0.00
Line 2: 10,307 UNITSMO | (item empty) | "MRC-Processed Units DR3 Woodland"  Each  $16.50  $170,065.50

Subtotal:        $170,065.50
Misc:                 $0.00
Tax:                  $0.00
Freight:              $0.00
Trade Discount:       $0.00  ← mid-month has $0 because no prior invoice to subtract
Total:           $170,065.50
```

**ADR-0041 `invoice_export` v2 contract (C-1) needs to emit both lines** so GP template renders correctly. Not just a total dollar amount — GP expects the LOCATION header + UNITSMO billing pair.

**EOM invoice will have the Trade Discount line populated** with the mid-month invoice amount, per Mary's Q4 answer.

### §4.3 — Site suffixes for PO format (partial)

- Woodland: `DR3W` (confirmed)
- Eugene: **TBD** — pending Mary confirmation. Likely `DR3E` or `DR3O`.

---

## §5 — CA workbook data (from `California_Transportation_December_2025.xlsx`)

**Structure:** 5 sheets — Inbound Trans (125r×14c), Container Rentals (47r×9c), Summery (10r×5c), Variables (88r×18c), Fuel (108r×4c).

### §5.1 — CA container rentals (44 active rows, $10,500/mo total)

**By facility:**
- DR3 Stockton (13 rows): Bay Counties SMART $300, Conservation Corps $300, Newby Island $300, Pleasanton Garbage $300, Recology Marsten $300, Recology Mountain View $300, Recology on the Coast $300, EcoHaul (blank rate), Foothill Sanitary (blank), Big Oak Flat $300, City of San Leandro $300, Goodwill (blank), 1-800-Got-Junk (blank), Spirit Logistics (blank), Speedy Delivery $300
- DR3 Woodland (25 rows): Bass Hill Landfill $600 (2× 28ft), Black Butte $300, Casper $400 (48ft trailer), Diamond Recycling (blank), Evan's Furniture (blank), City of Folsom $300, Happy Camp $300, Guerneville $300, Humboldt Waste $300, Loyalton $300, Oberlin Rd $300, Ramshorn $300, Recology Davis $300, Recology Del Norte $300, Recology Butte-Colusa $300, Red Bluff $300, Recology Vacaville (blank), Willits $300, Yolo County (blank), Zaengles $300, South Tahoe (blank), Woodfords Washoe Tribe $500 (20ft container), Chester Transfer (blank), Ord Rd $300, Scott River $300, Recology San Francisco $1,200 (4× 53ft)

Total from workbook: $10,500 (some blank rate rows exclude from total).

### §5.2 — CA Variables sheet structure (columns G-N for haul rate lookup)

Columns:
- G: Account Name (matched to source)
- H: Destination (`DR3 Woodland`, `DR3 Stockton`, `DR3 - Livermore`)
- I: Haul Rate ($)
- J: Mileage (int)
- K: Assignment (`Primary (1st)`, `Secondary (2nd)`, `Tertiary (3rd)`)
- L: (blank)
- M: Re-Trac Random ID (matches source's ID)
- N: Container Rental Rate ($/month, per source — used for the rentals sheet)

**~90 source rows.** Woodland resolver uses Primary rows only per §3.5.

### §5.3 — CA Fuel sheet (EIA West-Coast diesel weekly)

Columns: Begin Date, End Date, Price per Gallon. Historical data back to 2022-01. Feeds ADR-0040 fuel surcharge formula (CA only).

---

## §6 — OR workbook data (from `MRC_Oregon_January_2025.xlsx`)

**Structure:** 8 sheets — Inbound Trans (132r×8c), Inbound (306r×8c), Public Drop (40r×7c), Events (21r×16c), Container Rentals (47r×7c), Summary (33r×8c), Commodities (267r×56c), OutBound To Renovators (14r×8c).

### §6.1 — OR container rentals (5 rows, $800/mo)

| Location | Trailers | Size | Rate |
|---|---|---|---|
| Glenwood | 4 | 28ft | $400 (bundled) |
| Albany SVDP | 1 | 28ft | $100 |
| Florence SVDP | 1 | 28ft | $100 |
| Salem SVDP | 1 | 28ft | $100 |
| Rifes | 1 | 53ft | $100 |

**Add The Dalles SVDP** at 1× 28ft $100 (onboarded 2026-06-01 per §3.3).

### §6.2 — OR Public Drop (equivalent to CA incentive_unpaid)

Columns: Date, Customer, Slip #, Units. Consumer drop-off tracking. Vision maps to `unpaid_dropoff` load kind. Rick's "illegal" category (§3.2) is a variant.

### §6.3 — OR Events tab

Same shape as CA Events (Date, Customer, County, Slip, Units, Freight, Driver Hours, Drivers Wages, Labor Hours, Labor Wages, Mileage Reimb, Per Diem). Confirms Events is a cross-site concept, not Woodland-only.

### §6.4 — OR Commodities tab (267r × 56c)

Wide outbound-by-commodity grid similar to Woodland's `June26 Commodities`. Same section-by-commodity layout inferred. Parser uses row-2 label matching per PR #91 §3.2.

### §6.5 — No fuel surcharge on OR

Rick confirmed. Vision's fuel resolver skips for OR-jurisdiction loads.

---

## §7 — Sources seed changes needed

Comprehensive list of source seed corrections + additions:

### §7.1 — Corrections to existing seeds (from 2026-07-10 seed)

- **DELETE** `Glenwood TC 143` and `Glenwood TC 144` as separate entities
- **MERGE** into single canonical `Glenwood` source — 4 trailers, 28ft, $400/month
- **UPDATE** Eugene sources (Thompsons/Stayton/Deschutes/Sponsors) to `site_type=third_party_inbound` — no trans/trailer billing
- **UPDATE** all seeded OR sources: canonical names + real addresses pending Rick's reply (item 3 in latest Rick email)

### §7.2 — New OR seeds needed

| Source | site_type | trans_cents | trailer_rate_cents | per_mattress_cents | active_billing |
|---|---|---|---|---|---|
| Glenwood Transfer Station | mrc_inbound | 20000 | 40000 (bundled 4 trailers) | 0 | true |
| Roseburg Transfer Station | mrc_inbound | 0 | 0 | 0 | **false** (pending signup) |
| Albany SVDP | collection_site | 35000 | 10000 | 225 | true |
| Florence SVDP | collection_site | 50000 | 10000 | 225 | true |
| Salem SVDP | collection_site | 50000 | 10000 | 225 | true |
| The Dalles SVDP | collection_site | 100000 | 10000 | 225 | true (effective 2026-06-01) |
| Rifes | cvp_retailer | 20000 | 10000 | 0 | true |
| Cottage Grove | collection_site | 0 | 0 | 225 | true (bill_trans=false, bill_trailer=false flags) |
| Thompsons Sanitary Service | third_party_inbound | 0 | 0 | 0 | true (MRC per-unit only) |
| Stayton Community Center | third_party_inbound | 0 | 0 | 0 | true |
| Deschutes | third_party_inbound | 0 | 0 | 0 | true |
| Sponsors | third_party_inbound | 0 | 0 | 0 | true |
| Illegal Drop | (special, no source entity per se — bucket in load_source_kind) | — | — | — | — |

Illegal Drop is a load classification, not a source — track as `load_source_kind='illegal_dropoff'` on individual load records, not a source seed row.

### §7.3 — CA seed changes needed

- Seed ~90 sources from CA Variables tab (extraction script needed once file arrives on titan)
- Seed 44 container rental rows into `container_rentals` config table
- Seed 7 Event Mile Rate tier rows into `event_mile_tier` table

Column-level parsing rules already documented in §5.2.

### §7.4 — Rick pending items (from last email)

Bill's latest email to Rick asks about:
- Rosburg classification (answered: non-program, no billing)
- Any rate changes since workbook dates (answered: none, workbooks are current templates)
- Eugene third-party inbound sources canonical names + addresses (pending)
- Illegal Drop treatment (answered: program units, tracked as separate kind)

Once Rick replies with canonical Eugene site names + addresses, §7.2 rows update from placeholder to real.

---

## §8 — ADR amendments consolidated

Ships as one PR set. Order matters — ADR-0037 changes come first, then downstream ADRs adjust.

### §8.1 — ADR-0037 amendment (inventory + sources)

- Sequential depletion (program-first, non-program overflow) — §1.1 rules
- `sources.site_type` enum (4 values) — §3.2
- `sources.is_non_program` boolean (routing) — §1.2
- `sources.active_billing` boolean (Roseburg pattern) — §3.2
- `sources.bill_trans` + `sources.bill_trailer` boolean overrides (Cottage Grove pattern) — §3.2
- `load_source_kind` enum extends: adds `illegal_dropoff` — §3.2
- Pool routing rules: mrc_program + collection + unpaid_dropoff + illegal_dropoff → program pool; non_program → non-program pool; events tracked separately
- iPad entry: write-in one-off non-program tag with free-text source name (Kelsey's anticipated need)
- `/admin/sources` editable is_non_program toggle
- Consumer drop-off: `consumer_name` + `incentive_amount_cents` fields, default `units × $300`

### §8.2 — ADR-0040 amendment (rate infrastructure)

- Container rental proration: **never prorated** (C-10 closed) — documented as policy
- Event Mile Rate tier table seeded from §3.7 (CA)
- OR fuel surcharge: skipped (formula CA-only)
- Woodland freight resolver: Primary rate + Primary miles regardless of assignment (§3.5), fallback to Event Mile Rate tier
- Per-source-type billing config (collection_site trans + trailer + per-mattress; cvp_retailer trans + trailer only; third_party_inbound MRC unit rate only)
- OR trans rate seeds from §3.3
- Cottage Grove `bill_trans=false + bill_trailer=false` override support

### §8.3 — ADR-0041 amendment (invoice generation)

- **Pilot / preview mode** — `invoices.mode` enum, `invoice_pilot_recipients` config, admin toggle to flip to production
- **Program vs non-program split on invoice basis** — `invoices.program_units_processed` (billable) + `invoices.non_program_units_processed` (tracked, off-invoice)
- **Trade discount line structure** for EOM invoices (per Mary's Q4 + real GP output §4.2)
- **Two-line invoice_export format** — LOCATION header + UNITSMO billing (per §4.2), C-1 v2 contract bump
- **Real GP identifiers** — MRC billing address, customer_id (CA=MRCL001), sales_id (34), PO format (M/DD/YY [site_suffix])
- **Amendment paths** — credit_memo state machine (shipped) + void_and_reissue path (shipped, verify integration)

### §8.4 — ADR-0042 amendment (COR generator)

- **Mid-month COR support** — `cor_certificates.period` enum (`end_of_month | mid_month`)
- On `mid_month`, inventory + FT + PT fields optional; renderer prints blank
- Pre-render reconcile (D3) runs only on `end_of_month`
- June-3,977 fixture is end-of-month only
- Capacity banner is end-of-month only
- Signer title seed confirmed correct: "Transportation Manager"

### §8.5 — ADR-0037 Addendum B (commodity taxonomy)

- No changes from PR #87 §3.2 finding (cotton confirmed permanent template feature)

---

## §9 — Fixture updates

Following corrections needed to shipped fixtures:

### §9.1 — ADR-0048 D2 (June close-balance assertion)

**Old fixture:** June close = 4,062  
**New fixture:** June close = 3,977 (3,748 program + 229 non-program)

### §9.2 — ADR-0042 COR pre-fill fixture

**Old:** total inventory 4,062 for June  
**New:** total inventory 3,977. Pending Kelsey walkthrough on whether MRC wants the program/non-program split reported separately or just total.

### §9.3 — Parser fixture (June Processed sheet)

Full column mapping now confirmed with real formulas — update `docs/parsers/woodland-daily-log-schema.md` (or wherever the parser schema lives) with §2.2 cell references.

### §9.4 — July workbook re-verification pending

The July workbook Bill dropped 2026-07-09 has DAY1 opening = 4,062 (from old June-end close). **Once Bill drops the corrected July workbook**, DAY1!L2 should show 3,977 as the new opening.

**Action for Bill:** re-download July workbook after opening/saving from Kelsey's OneDrive (formulas will recompute if cells reference the June close). Or note that the current July workbook has stale opening from pre-correction; parser handles either.

---

## §10 — Actions for Claude Code

**Reference:** this handoff filename.

### §10.1 — Execute §8 amendment build queue

Order:
1. ADR-0037 amendment (schema + sources + pool routing)
2. ADR-0040 amendment (rate tables + Woodland resolver + OR site type rules)
3. ADR-0041 amendment (pilot mode + trade discount + two-line export + GP identifiers)
4. ADR-0042 amendment (mid-month COR + period enum)

### §10.2 — Execute §7 seed changes

- Delete Glenwood TC 143 + TC 144 sources; merge into Glenwood canonical
- Update Eugene sources with correct `site_type=third_party_inbound`
- Seed OR sources per §7.2 table
- Seed CA sources + rentals + Event Mile Rate tier per §5 (waits for CA file on titan)
- Seed GP config: MRC billing address, customer_id `MRCL001`, sales_id `34`, PO suffix `DR3W`

### §10.3 — Execute §9 fixture updates

- ADR-0048 D2 assertion: 3,977 (not 4,062)
- ADR-0042 pre-fill fixture: 3,977
- Parser schema doc: §2.2 cell references

### §10.4 — Small correctness items

- Latent formula bugs in Processed sheet D45 + D48 are workbook-side, NOT to replicate in code. §2.3 documents correct arithmetic.
- Fix workbook-mode toggle for Kelsey's iPad entry: `write_in_non_program` field per load
- Confirm `credit_memo` + `void_and_reissue` state machines are wired to Mary's approval flow (should already be — verify)

### §10.5 — Do NOT

- Do NOT run ADR-0048 D4 promotion — waits for full workbook files on titan per §11
- Do NOT flip pilot → production mode default — stays `pilot` until Rick signs off
- Do NOT seed rates on live customer_ids without Bill's explicit go-ahead per environment

---

## §11 — Actions for Bill

### §11.1 — File transfer (still open, blocks §10.4 promotion)

Same three fetch options as PR #91 §7: rclone/wrangler/browser upload. Pick one.

**Files pending transfer to titan:**
- `JUNE_2026_DAILY_LOG_WOODLAND.xlsm` (CORRECTED, SHA `1eeeccbde0db7824aaf859b4352c7ac5e28ccba9efa319adb0976e635a966295`)
- `JULY_2026_DAILY_LOG_WOODLAND.xlsm` (SHA `4287392ca48f86f79953688314a677a2c737f7a8287064786f2f6d7fbc988f13`, may be stale re: DAY1 opening)
- `TEREX.xlsx` (SHA `13704f754ebeb5918690354227e3b21465e8b843de1d685add86f3b0b473c383`)
- `California_Transportation_December_2025.xlsx` (NEW today)
- `MRC_Oregon_January_2025.xlsx` (NEW today)
- `Scan_084.pdf` (COR sample, NEW today)
- `7_15_26_MRC_IVC072871_Mid_month_July.pdf` (invoice sample, NEW today)

Suggested titan path: `~/DR3-Vision/tests/fixtures/adr-0048/` for workbooks, `~/DR3-Vision/tests/fixtures/adr-0041/` for invoice sample, `~/DR3-Vision/tests/fixtures/adr-0042/` for COR sample.

### §11.2 — Pending stakeholder inputs (parked, drafts sent)

**Rick email (sent):** Rosburg (answered), workbook date currency (answered), Eugene site canonical names + addresses (pending), Illegal Drop treatment (answered).

**Kelsey email (sent):** Scheduling for 5 remaining walkthrough items before 8/1 — commodity mapping (biggest), saved_units confirmation, DAY6 ×5, % column on Steel/Biomass/WTE, event units, MRC contact map. Bill's provided Processed sheet analysis (§2) closes Q2.

**Mary email (drafted, not yet sent):** OR MRC customer ID, EOM invoice sample, Sales ID 34 confirmation, Eugene PO format, stewardship fee AP structure.

**Morena (pending her example emails):** 2-3 examples per category (non-program haul / reusable / MRC event) for ADR-0050 dispatch integration draft.

### §11.3 — Other operator actions

- O-2: file-fetch method decision (§11.1)
- O-3: `RESTIC_PASSWORD` off-box confirmation
- O-4: create Mary's account when she's ready
- O-7: outgoing stewardship-fee AP surface decision (still open from PR #91)
- O-10: security decisions D2 (session revocation) + D3 (CSP nonce)

---

## §12 — Blocker list, current state

**Hard blockers to launch:**
1. §11.1 file transfer — blocks full-file parser validation + June-3,977 fixture + ADR-0041 parity check
2. Mary's account (§11.3, O-4) — blocks billing verify view validation

**Soft blockers (parallel):**
3. Rick's Eugene site canonical names + addresses (§11.2)
4. Mary's OR customer ID + EOM sample + PO format (§11.2)
5. Kelsey's 5 remaining walkthrough items before 8/1 (§11.2)
6. Morena's dispatch email examples (§11.2)

**Nothing else blocks §10 build queue.** ADR amendments proceed independently of file transfer; fixtures ready to assert against real data whenever it lands.

---

## §13 — Session close

Rich session. All materials from 2026-07-17 captured. Handoff is comprehensive — parser + rate + invoice + COR + source seeds + pilot mode all ready to build. When Bill flips O-2, everything downstream unblocks in one cascade.
