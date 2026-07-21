# 2026-07-20 — MRC billing addendum: Rick/Mary/Kelsey rollup + full June reconciliation

**Session arc (Claude ↔ Bill, 2026-07-17 → 2026-07-20):**

Continuation of PR #128 handoff (`2026-07-17-mrc-billing-tune-and-launch-rollup-2026-07-17.md`) which has been merged to main. This session captured:

- Rick's canonical MyMRC names for all Oregon sites + third-party inbound model + Sponsors reclassified
- 11 internal SVDP stores tagged as new `svdp_internal_store` site_type
- Kelsey's walkthrough answers (Q1/Q3/Q4/Q5); Q2 closed by Bill's corrected sheet
- Kelsey vacation → transfer deadline moved from 2026-08-01 to 2026-08-08
- Rick's three parked follow-ups all answered (commodity attachment IS sent; saved_units are status flag not immediate subtraction; event billing mechanics detailed + TONU)
- Mary's full 5-question answer set with real EOM invoice PDFs
- Stockton 2025 commodity breakdown workbook analysis (11-block taxonomy)
- 10-file May + June production workbook drop (both sites, all tabs) — reconciles every June invoice line to real math
- 6 CA + OR invoice PDFs (mid-month + EOM processing + trans + collections + incoming MRC stewardship)

**Bottom line:** the module has enough real data to launch pilot mode against production numbers. Only outstanding data ask is Covanta WTE % + Xtraction Landfill classification (Rick email sent 2026-07-20, awaiting reply).

---

## §0 — Executive summary

**All ADR amendments from PR #128 shipped and deployed.** This handoff captures the delta from PR #128 close through 2026-07-20.

**Concrete new outputs from this session:**

1. **Canonical MyMRC names locked** for all Oregon sites (Glenwood, Albany, Salem, Florence, The Dalles, Cottage Grove, Rifes; Roseburg parked non-program until MRC signup)
2. **New `site_type=svdp_internal_store`** for 11 SVDP-run retail/warehouse locations that bring mattresses but aren't MRC-approved collection sites
3. **Sponsors reclassified as provenance agency** — new `provenance_agencies` table + FK on inbound_loads
4. **`unit_records.status` enum** replaces earlier `daily_closes.saved_units` field — Rick's model wins (status flag, not immediate inventory subtraction)
5. **Live floor inventory tile per site** required by operations (Rick's ask)
6. **7 GP item codes locked** with aggregation rule (MILES 0 combines freight + event trans + rental into one line)
7. **Complete June 2026 invoice reconciliation** — all 6 invoices reconcile to workbook math
8. **11-block commodity breakdown attachment structure** documented from real 2025 Stockton production data
9. **Event billing model + TONU** — new ADR needed (next-free number)
10. **O-7 closes** — stewardship AP handled outside Vision
11. **PR #128 corrections** — OR customer ID same as CA, PO formats have spaces, OR processing rate is $17.00/unit

---

## §1 — Rick's canonical MyMRC names + billing structure (from 2026-07-19)

**Locked names for source seeds** (MRC portal is authoritative; parser matches case-insensitively):

| Vision source | Canonical MyMRC name | Address |
|---|---|---|
| Glenwood Transfer Station | **Glenwood Central Recieving Station** (verbatim spelling; MRC's typo of "Receiving") | 3100 E 17th Ave, Eugene OR |
| Albany SVDP | **ST Vincent De Paul OF Lane County-Albany Thrift Store** | 2220 Pacific Blvd, Albany OR |
| Salem SVDP | **St Vincent De Paul Of Lane County - Salem Thrift Store** | 445 Lancaster Dr NE, Salem OR |
| Florence SVDP | **St Vincent De Paul Of Lane County - Florence Thrift Store** | 2315 HWY 101, Florence OR |
| The Dalles SVDP | **St Vincent De Paul Of Lane County - The Dalles Thrift Store** | 505 W 9th St, The Dalles OR |
| Cottage Grove | **St Vincent De Paul Of Lane County - Cottage Grove Store** | 910 Row River Rd, Cottage Grove OR |
| Rifes | **Rifes** | Eugene (no address in MyMRC portal) |
| Roseburg | (Roseburg Transfer Station) | non-program; rates pre-negotiated pending MRC signature |

Rick confirmed: when Roseburg signs, activate seed row immediately (rates already established with MRC).

## §2 — Third-party inbound + Sponsors reclassified

**Rick verbatim:** *"All Others that will deliver to the Mattress shop, Regardless of Collection Site or Transporter will have no billing on our side."*

**Third-party MRC-contracted haulers** (Fusion Transport, etc.): bill MRC directly. DR3's role is entering unit count in MyMRC when the trailer is unloaded. Vision produces zero billing lines. Existing `site_type=third_party_inbound` covers this.

**Sponsors reclassified.** *"Sponsors is the name of the agency That brought us the mattresses. They are treated the same as Eugene Mattress Company or U-Haul... Sponsors is a half way house on 99 next to Lindholm."*

Schema change:
- REMOVE `Sponsors` from `sources` seed
- ADD `provenance_agencies` table: `id, name, notes, active`
- ADD `inbound_loads.provenance_agency_id` (nullable FK)
- Seed: Sponsors (halfway house on Hwy 99 next to Lindholm), Eugene Mattress Company, U-Haul
- iPad drop-off entry: "Source of origin" typeahead + write-in

**Illegal Drop** unchanged from Addendum A — `load_source_kind='illegal_dropoff'`, program-pool routing.

## §3 — Live floor inventory tile (Rick's ask, Bill confirmed answer)

**Rick's operational question:** *"As of this morning i had 137 Program Units on my floor and 1152 Non Program Units on the floor... Will it give us an 'currently on the floor' inventory or we will track that outside of Vision?"*

**Bill confirmed:** Vision tracks both pools live per site.

**Build addition:** operator-facing tile at `/dashboard/{site}` showing:
- Program units on floor (real-time)
- Non-program units on floor
- Total on floor
- Optional: trailing-rate projection ("days of program pool remaining")

Feeds off ADR-0037 inventory ledger.

**Sequential depletion in action (Rick's illustration):** *"So if we processed 237 and only had 137 Program units on the Floor, we would have reported 137 Program Processed and 100 non program processed."* Matches Kelsey Q1 rule exactly.

## §4 — Internal SVDP stores taxonomy (11 stores)

**Rick:** *"Other SVDP Locations do not get the 2.25 per unit count as they are not an MRC approved collection site... As all our stores collect but they are not Collection sites in conjunction With the MRC."*

**New `site_type=svdp_internal_store`** — SVDP-run retail/warehouse, bring mattresses, NOT billed per-mattress, no trans, no trailer rental.

**11 seed rows** (all `site_type=svdp_internal_store, active=true, active_billing=false`):

| Store | Address | Notes |
|---|---|---|
| Division | 201 Division Ave, Eugene | Retail |
| Seneca | 705 Seneca Rd, Eugene | Retail |
| West Eugene | 2167 W 11th Ave, Eugene | Retail |
| Chad Drive | 2890 Chad Dr, Eugene | Retail (SVdP HQ) |
| Q Street | 199 Q St, Springfield | Retail |
| Main Street | 4555 Main St, Springfield | Retail |
| Junction City | 333 Ivy St/HWY 99, Junction City | Retail |
| Oakridge | 47663 Hwy 58, Oakridge | Retail |
| Garfield | 888 Garfield St, Eugene | Retail |
| CARS | 1175 State Hwy 99N, Eugene | Used car lot, no mattresses yet |
| Cleveland WH | 135 N Cleveland St, Eugene 97402 | Warehouse, closed to public |

CARS renamed from "Affordable Vehicles" per Bill 2026-07-19; Cleveland WH added same day.

## §5 — Rick's Addendum-A follow-ups answered

### §5.1 — Q1: Outbound commodity attached to invoice

**Rick verbatim:** *"It is sent as a breakdown along with the invoice."*

Partially reverses Addendum A §A.1. Invoice math still single-line (commodity mapping NOT a billing input) but a **companion attachment IS required** with EOM invoice (Rick confirmed EOM only, not mid-month).

**ADR-0041 amendment:** invoice generator emits `attachments[]` on EOM invoices; first attachment is monthly commodity breakdown. Full structure in §11.

### §5.2 — Q2: saved_units is a status flag (Rick's model wins)

**Rick verbatim:** *"Saved units are not removed from inventory until they are sent to a store."*

**Kelsey's Addendum-A §A.2 model was wrong.** Rick's operational reality:
- Saved units carry a status flag but STAY in inventory
- Only decremented when physically transferred to a retail store

**Schema correction:**
- RETRACT `daily_closes.saved_units` (from Addendum A §A.2)
- ADD `unit_records.status` enum: `on_floor | saved | processed | sold | landfilled`
- ADD `unit_records.status_changed_at` timestamp
- Daily log "saved" number → mark N units as `status=saved` (no inventory change)
- Store transfer → change status from `saved` to `sold` with `store_destination_id` FK to `svdp_internal_store` source
- iPad: two separate ops — "Mark N as saved" and "Send N saved units to [store]"

### §5.3 — Q3: Event billing mechanics (six components + TONU)

**Rick's full walkthrough:**

1. **Freight — same-day loaded** → mileage rate (standard rate table)
2. **Freight — drop + next-day pickup** → Event Mile Rate tier, PER LEG (drop = one leg, pickup = another; each tier-priced separately)
3. **Labor hours** — total Woodland→event→Woodland (roundtrip travel counts as labor)
4. **Driver wages** — ONLY on-site time (drive time already in labor)
5. **Per diem** — days on event, overnight only (rare; Happy Camp is the example)
6. **IRS mileage** — per vehicle, IRS-guideline rate (NOT SVDP rate), facility→event→facility

**Plus TONU (Trailer Order Not Used):**
- Trigger: driver dispatched but cannot drop trailer
- Cancelled before dispatch → NO bill
- Cancelled after dispatch OR diverted → billed at haul rate

**Schema addition:**
- `events.legs[]`: `{leg_type: drop|pickup|same_day, tier_lookup_miles, rate_cents}`
- `events.labor_hours`
- `events.driver_onsite_hours`
- `events.per_diem_days`
- `events.overnight` boolean
- `events.vehicles[]`: `{vehicle_id, miles_driven}` per vehicle

**Rate constants** (add to `state_program_rules`):
- `labor_hourly_rate`
- `driver_hourly_rate`
- `per_diem_daily_rate`
- `IRS_mileage_rate` (current-year — needs check + update)

**New `tonu_billing` table:**
- `event_id` FK
- `dispatched_at`, `cancelled_at`
- `haul_rate_used` (Primary rate for Woodland per PR #128 §3.5)
- `billed_at_cents`

**Ships as new ADR — "Event Billing + TONU Line Handling"** (next-free number at draft time; 0055 and 0056 are consumed, use 0057+ or whatever's free).

**Production data check:** June Woodland EVENTO = $4,235.35, Event Trans = $925 (low event month). OR June had $0 event activity. Rick's model handles zero case naturally.

## §6 — Cadence clarifications

**Bill:** *"Mid month is woodland processing only"*
**Rick:** commodity breakdown attachment is **EOM only** (not mid-month)

**Full monthly invoice cycle:**

| # | Site | Type | Cadence | PO format | Notes |
|---|---|---|---|---|---|
| 1 | Woodland | Processing | Mid-month (16-18) | `M/DD/YY DR3 W` | CA only, no attachment |
| 2 | Woodland | Processing | EOM (1st-5th) | `M/DD/YY DR3 W` | With Trade Discount + commodity attachment |
| 3 | Woodland | Transportation/Rental | EOM (1st-5th) | `M/DD/YY TRANS` | Freight + rental + Event Trans aggregated + Fuel |
| 4 | Eugene | Processing | EOM (1st-5th) | `M/DD/YY DR3 OREGON` | No mid-month; with commodity attachment |
| 5 | Eugene | Transportation/Rental | EOM (1st-5th) | `M/DD/YY TRANS OR` | Freight + rental aggregated; NO fuel |
| 6 | Eugene | Collections | EOM (1st-5th) | `M/YY OR COLLECTIONS` | Per-site $2.25/mattress |
| 7 | (Incoming) | MRC Stewardship | Monthly | (MRC-generated) | Mary handles outside Vision; closes O-7 |

Vision generator branches on `(site, period, invoice_type)`; rejects invalid combos (Eugene mid-month, mid-month with Trade Discount, etc.).

## §7 — Kelsey vacation + extension

**Bill 2026-07-19:** *"Kelsey is on vacation all this week - I have renegotiated her transfer to extend by a week."*

**Deadline moved: 2026-08-01 → 2026-08-08.**

Implications:
- OPEN-ITEMS.md Stage 1-3 anchor slides one week
- Kelsey email (MRC contact map + Re-TRAC handoff) HELD until return
- Kelsey's AP approver auto-remove date needs migration: 8/1 → 8/8
- `saved_units` question resolved by Rick's answer (§5.2) — no Kelsey re-consult needed
- Only remaining Kelsey ask: MRC contact + Re-TRAC transfer (post-vacation)

## §8 — Mary's five answers (closes GP-side questions)

**Q1: OR customer ID.** **Same as CA: `MRCL001`.** Correction to PR #128 §4.2.

**Q2: EOM invoice samples.** Two real PDFs delivered — analysis in §10.

**Q3: Sales ID 34.** Mary: *"Sales ID is used for sorting in GP ID is assigned to DR3"* — **static value, hardcoded.**

**Q4: Eugene PO format.** From PDFs: **`M/DD/YY DR3 OREGON`** (spaces, spelled out). NOT `DR3E` or `DR3O`. Correction to PR #128 §4.3.

Also correction: Woodland PO has space too — **`M/DD/YY DR3 W`**. Trans invoices use `M/DD/YY TRANS` (CA) or `M/DD/YY TRANS OR` (OR). Collections uses `M/YY OR COLLECTIONS` (2-digit year, no day).

**Q5: Stewardship AP structure.** Mary: *"Rick generates a report on MRC stewardship website using the number from thrift works sales program numbers which are checked against GP number put in by store sales accounting staff. I just pull the report from the website, verify the number again and then make the payment on the website then I book the payment against the liability account on GP. I do not generate any invoice per say and there is not vender."*

**Sample:** `MRC0220259_20260601-20260630__3_.pdf` — MRC-generated stewardship invoice, June 2026, $2,520.00 (112 items × $22.50 for new units; renovated items @ $0).

**Payment mechanics:** Check to MRC (PO Box 223594, Chantilly VA) OR ACH to United Bank (routing 056004445, acct 5060-154134).

**O-7 CLOSES:** stewardship fee AP does NOT need Vision surface. Source data lives in thrift works POS (not Vision), MRC generates on portal, Mary handles entirely outside Vision. Close O-7 as **"Not needed. Stewardship fee handled outside Vision via MRC portal + GP liability booking."**

## §9 — GP item code taxonomy + aggregation rules

**Item codes locked (7 total) — from real invoice PDFs:**

| Item code | Description | Site | Aggregates |
|---|---|---|---|
| `LOCATION` | $0 header/spacer | Both | Section boundary marker |
| `UNITSMO` | Processed units × rate | Both | Program units × site rate ($16.50 CA, $17.00 OR) |
| `REIMBO` | Consumer drop-off reimbursement | CA only | Unpaid drop-off units × $3.00 |
| `EVENTO` | Event labor aggregate | CA only | Sum of event labor for the month |
| `MILES 0` | Freight + rental aggregate | Both | **Regular freight + Event Trans + Container Rental (ONE line)** |
| `FUEL` | Fuel surcharge | CA only | EIA-based; OR always $0 |
| `OREGON MATTRESS` | Collection site per-mattress | OR collections | Units × $2.25, one line per site |

**Critical aggregation rule:** `MILES 0` combines THREE components into ONE GP line item:

```
miles_0_extended_price = 
    regular_freight_total 
  + event_transportation_total 
  + container_rental_total
```

Only fuel gets its own line (`FUEL`). Applies to both CA (Woodland) and OR (Eugene) Transportation invoices.

**Rate table updates:**
- CA processing: $16.50/unit
- **OR processing: $17.00/unit** (new confirmed rate; was speculated in PR #128)
- Collection sites: $2.25/mattress
- Unpaid drop-off reimbursement (CA): $3.00/unit
- Fuel: CA formula only; OR always emits $0

## §10 — Complete June 2026 invoice reconciliation (all 6 invoices)

From the 10-file drop, every June invoice line traces to workbook math.

**Woodland CA — Processing IVC072778 (EOM):**
```
Line 1: LOCATION           "Total units processed 6.30.26"          $0.00
Line 2: 17,126 UNITSMO     "MRC-Processed Units DR3 Woodland" × $16.50 = $282,579.00
Line 3: LOCATION           "Incentive program"                       $0.00
Line 4: 1 REIMBO           "MRC- $3.00 Incentive Program"           $15.00 (5 units × $3)
Line 5: LOCATION           "Misc Events"                             $0.00
Line 6: 1 EVENTO           "MRC- Event Labor"                     $4,235.35
Subtotal:                                                        $286,829.35
Trade Discount:                                                 -$138,699.00 (8,406 mid-month units × $16.50)
Total:                                                           $148,130.35 ✓
```

**Woodland CA — Transportation IVC072775 (EOM):**
```
Line 2: 1 MILES 0          "MRC Freight & Rental Cal sites 6/30/26" $67,375.00
  ↑ AGGREGATION: Transportation $55,650 + Event Trans $925 + Container Rental $10,800
Line 3: 1 FUEL             "surcharge - June"                       $5,105.51
Total:                                                            $72,480.51 ✓
```

**Eugene OR — Processing IVC072777 (EOM):**
```
Line 2: 4,947 UNITSMO      × $17.00                                $84,099.00
Total:                                                            $84,099.00 ✓
```

**Eugene OR — Transportation IVC072776 (EOM):**
```
Line 2: 1 MILES 0                                                 $13,800.00
  ↑ AGGREGATION: Transportation $12,900 + Container Rental $900 + Event Trans $0
  ↑ NO FUEL LINE
Total:                                                            $13,800.00 ✓
```

**Eugene OR — Collections IVC072779 (EOM):**
```
Line 2: 67  OREGON MATTRESS   Cottage Grove × $2.25 =    $150.75
Line 3: 203 OREGON MATTRESS   Salem         × $2.25 =    $456.75
Line 4: 379 OREGON MATTRESS   Albany        × $2.25 =    $852.75
Line 5: 59  OREGON MATTRESS   Florence      × $2.25 =    $132.75
Line 6: 54  OREGON MATTRESS   The Dalles    × $2.25 =    $121.50
Total:                                                 $1,714.50 ✓
```

**Woodland CA — Mid-month IVC061656:**
```
Line 2: 8,406 UNITSMO × $16.50 = $138,699.00 ✓ (matches Trade Discount)
```

**June totals per site:**
- Woodland CA: $148,130.35 + $72,480.51 + $138,699.00 = **$359,309.86**
- Eugene OR: $84,099.00 + $13,800.00 + $1,714.50 = **$99,613.50**
- **June grand total: $458,923.36**

## §11 — Commodity breakdown attachment (11-block taxonomy from Stockton 2025)

Analyzed from `MRC_Billing_Stockton_2025_Final.xlsx` Commodities tab.

**Layout:** wide landscape, one commodity block per column range. Facility label at row 6, commodity name at row 7.

**11 commodity blocks per site:**

| # | Cols | Commodity | Structure | Vendor + %? |
|---|---|---|---|---|
| 1 | B-F | Landfill | Date, Slip #, Lbs, Ticket #, Retrac ID | — |
| 2 | H-M | Steel | Date, Recycler, %, Lbs, Ticket #, Retrac ID | ✓ |
| 3 | O-T | Xtraction Landfill | Date, Recycler, %, Lbs, Ticket #, Retrac ID | ✓ (Xtraction only) |
| 4 | V-AA | Covanta WTE | Date, Recycler, %, Lbs, Ticket #, Retrac ID | ✓ |
| 5 | AC-AG | Wood | Date, Lbs, Ticket #, Retrac ID | — (Biomass 100%) |
| 6 | AH-AL | Toppers | Date, Lbs, Ticket #, Retrac ID | — |
| 7 | AM-AQ | Foam | Date, Lbs, Ticket #, Retrac ID | — |
| 8 | AR-AV | Cardboard | Date, Lbs, Ticket #, Retrac ID | — |
| 9 | AW-BA | Plastic | Date, Lbs, Ticket #, Retrac ID | — |
| 10 | BB-BF | Cotton | Date, Lbs, Ticket # | — |
| 11 | BG-BL | Landfilled Units (Bed Bug, Soiled, Wet) | Date, Unit, Quantity | — |

**Steel × Xtraction = 81%** confirmed in real production data (matches Kelsey Q4 answer, validates ADR-0055 seed).

**Xtraction Landfill is a separate reporting block** — MRC wants Xtraction's landfill fraction (19% of steel loads) tracked distinctly from general Landfill. Vision's ADR-0055 already computes lbs; attachment renders as discrete block, not aggregated.

**Landfilled Units block:**
- UNIT count (not lbs)
- Contamination categories: **Bed Bug, Soiled, Wet**
- Whole-mattress landfills (can't be processed)

**Schema addition:** `unit_records.landfilled_reason` enum: `bed_bug | soiled | wet`. Distinct from `outbound_records.landfilled_lbs` (commodity-lb landfill).

**11-value `OutboundCommodity` enum extension:**
```
landfill / steel / xtraction_landfill / wte / wood / toppers / 
foam / cardboard / plastic / cotton
```

Plus `unit_records.landfilled_reason` for the 11th block.

**Attachment PDF renderer requirements:**
- Landscape orientation
- Multi-column block layout
- Per-transaction rows per block
- Per-block totals at bottom
- Facility header once per block
- Rendered from `outbound_records` + `unit_records.landfilled_reason` aggregated for invoice period

**Pending Rick clarification (email sent 2026-07-20):**
- Covanta WTE recycling %
- Xtraction Landfill: MRC-required separate block or Rick's rendering choice

## §12 — Real production data validation (10-file drop)

**10 workbook files delivered 2026-07-20** covering May + June both sites plus billing templates.

**Files inventoried:**
- `MRC_Woodland_May_2026.xlsx`, `MRC_Woodland_June_2026.xlsx` (9 tabs each)
- `MRC_Oregon_May_2026.xlsx`, `MRC_Oregon_June_2026.xlsx` (9-10 tabs)
- `California_Transportation_May_2026.xlsx`, `California_Transportation_June_2026.xlsx` (5 tabs)
- `Oregon_Transportation_May_2026.xlsx`, `Oregon_Transportation_June_2026.xlsx` (5 tabs)
- `Collection_Site_Billing.xlsx` (June — Inbound + Summery)
- `Unit_Count_Billing_Spreadsheet.xlsx` (May — same shape, older name)

**Two-file architecture per month per site:**
- `MRC_{Site}_{Month}_{Year}`: MRC-facing billing basis (Processed, Inbound, Commodities, Container Rentals, Events, Public Drop/Paid-Unpaid, Non-Program, OutBound to Renovators)
- `{Jurisdiction}_Transportation_{Month}_{Year}`: freight/rental basis (Inbound Trans, Container Rentals with rates, Fuel, Variables lookup, Summery)

**Container rental June (updated from Jan template):**
- CA: $10,800/mo (44 rentals, unchanged)
- **OR: $900/mo (6 rentals)** — was $565 in Jan template with 5; The Dalles added ($100)

**Fuel data (CA):** EIA West-Coast diesel weekly, June $5.528–$6.398/gal. Total June fuel surcharge $5,105.51.

**OR Fuel tab exists as template artifact** — resolves to $0. Only April 2026 rows populated. Rick's "no OR fuel" confirmed operationally.

**Non-program processing active in OR June:**
- OR June: 5,292 program inbound + 749 non-program inbound; 4,947 program stripped + **436 non-program stripped**
- Sequential depletion fired — program pool ran out mid-month, non-program started depleting
- MRC only billed 4,947 × $17 = $84,099
- 436 non-program processed units tracked in Vision but NOT billed

**Woodland June (contrast):** 19,536 program inbound + 229 non-program inbound; 17,126 program stripped + **0 non-program stripped**. Program pool never dry.

**85-unit discrepancy still surfaces.** Woodland June Summary tab reports 19,536 program inbound; PR #128 §2.4 shows 19,451 corrected. Same 85 units as the 4,062→3,977 closing balance delta. Kelsey Summary tab still references pre-correction values. Vision uses corrected math per PR #128 §2.3.

**Kelsey Summary tab errors:**
- Row 12 label "Fuel surcharge" $72,480.51 is actually total Trans invoice (mislabeled)
- Row 16 "End Of Month Trans Inv" $139,855.51 double-counts
- Row 17 "MRC Total" $426,684.86 uses buggy numbers

**Vision uses correct arithmetic in code** (unchanged from PR #128 §2.3). Parser skips these tabs per Addendum A §A.6.

**Customer name normalization required.** Same collection sites, wildly different names month-to-month:
- May: "SVDP Albany", "SvdP Albany" (typo!), "SVDP Florence", "Cottage Grove"
- June: "Albany" (no prefix), "SVDP Cottage Grove", "SVDP Florence", "SVDP The Dalles"

**Parser requirement:** alias resolution table at intake. Match input against canonical MyMRC names (§1) via fuzzy or explicit aliases. Log unmatched names for operator review.

**Two months of production data available for parser validation** once files are pulled from `/admin/file-drop` R2 storage.

## §13 — Delta corrections to PR #128

| PR #128 reference | Original | Corrected |
|---|---|---|
| §4.2 Customer ID (OR) | "pending Mary" | **`MRCL001` (same as CA)** |
| §4.2 Purchase Order format | `M/DD/YY DR3W` | **`M/DD/YY DR3 W`** (with space) |
| §4.3 Eugene PO format | TBD (DR3E or DR3O) | **`M/DD/YY DR3 OREGON`** (spelled out) |
| §0 CA/OR rates | CA $16.50 only | **CA $16.50, OR $17.00** (different) |
| §6.1 OR container rentals | 5 rentals, $565-$800 | **6 rentals, $900/mo** (June actual + The Dalles) |
| §3.7 Event Mile Rate tier serves as | Woodland freight fallback | Also base for **event freight per-leg** (§5.3) |
| §A.2 saved_units field | `daily_closes.saved_units` (immediate subtraction) | **`unit_records.status` enum** (flag, no subtraction until store transfer) |

## §14 — Delta to §8 amendments (ADR-level)

**ADR-0037 amendment:**
- New `site_type=svdp_internal_store` enum value
- New `provenance_agencies` table + FK
- REVISE saved_units model per §5.2 (Rick's answer wins)
- Add `unit_records.landfilled_reason` enum from §11
- `unit_records.status` enum

**ADR-0040 amendment:**
- OR processing rate: $17.00/unit
- `MILES 0` aggregation rule (§9)
- MRC billing address: Mattress Recycling Council, Attn: Ryan Trainer, 501 Wythe Street, Alexandria VA 22314
- 44 CA + 6 OR container rentals seeded with June values

**ADR-0041 amendment:**
- PO format templates (§9) with spaces
- Sales ID 34 static config
- 7-item code taxonomy (§9)
- Invoice cycle validator — rejects Eugene mid-month, mid-month with Trade Discount
- `invoices.attachments[]` on EOM only
- Commodity breakdown attachment renderer (§11)
- Kelsey Summary tab documented UNRELIABLE

**ADR-0055 (Recycling Rates):**
- Steel × Xtraction @ 81% confirmed by production data
- Pending: Covanta WTE %, Xtraction Landfill classification (Rick email 2026-07-20)

**New ADR needed — Event Billing + TONU Line Handling:**
- Six event billing components (§5.3)
- `events.legs[]`, labor_hours, driver_onsite_hours, per_diem_days, overnight, vehicles[]
- Rate constants: labor_hourly, driver_hourly, per_diem_daily, IRS_mileage_rate (current-year)
- `tonu_billing` table

**O-7 CLOSED:** stewardship fee handled outside Vision.

## §15 — Actions for Claude Code

**Build queue:**

1. **Sources model updates:**
   - Add `site_type=svdp_internal_store` enum
   - Seed 11 SVDP internal store rows (§4)
   - Replace `Sponsors` source with `provenance_agencies` entry
   - Update all OR source names to canonical MyMRC spellings (§1)
   - Add `provenance_agencies` table + `inbound_loads.provenance_agency_id` FK

2. **Unit record + status enum:**
   - `unit_records.status` enum: `on_floor | saved | processed | sold | landfilled`
   - `unit_records.status_changed_at` timestamp
   - `unit_records.landfilled_reason` enum: `bed_bug | soiled | wet`
   - RETRACT `daily_closes.saved_units` from Addendum A §A.2
   - Store-transfer op moves `saved` → `sold` with `store_destination_id` FK

3. **Invoice generation (ADR-0041 amendments):**
   - PO format templates from §9 with spaces
   - Item code enum: LOCATION, UNITSMO, REIMBO, EVENTO, MILES 0, FUEL, OREGON MATTRESS
   - `MILES 0` aggregation rule (freight + event_trans + rental into one line)
   - OR processing rate seed: $17.00/unit
   - Invoice combinations validator
   - `invoices.attachments[]` on EOM only
   - Sales ID 34 static config
   - MRC billing address config

4. **Commodity breakdown attachment renderer:**
   - 11-block landscape PDF layout (§11)
   - Per-transaction rows within each block
   - Per-block totals
   - Fires EOM only

5. **Live floor inventory tile:**
   - Operator tile at `/dashboard/{site}`
   - Program + non-program + total on floor, real-time
   - Feeds off ADR-0037 inventory calc

6. **Event billing + TONU (new ADR):**
   - Schema per §5.3
   - Rate constants added to `state_program_rules`
   - `tonu_billing` table
   - IRS mileage rate current-year update

7. **Parser normalization:**
   - Customer name alias resolution at intake (§12)
   - Match against canonical MyMRC names (§1)
   - Log unmatched for operator review

8. **Kelsey AP approver auto-remove:**
   - Change date: 2026-08-01 → **2026-08-08** (§7)
   - Small config change or migration

**Do NOT:**
- No live customer_id rate seeding without Bill's explicit go-ahead
- Pilot mode stays default `pilot` until Rick + Bill sign off after reconciliation
- No mid-month invoice with Trade Discount, no Eugene mid-month invoice

## §16 — Actions for Bill

**Stakeholder status:**

- **Rick — very responsive:** all major questions answered except Covanta WTE % + Xtraction Landfill classification (email sent 2026-07-20)
- **Mary — fully answered:** all 5 background questions closed; O-7 resolves as "not needed"
- **Kelsey — on vacation until ~7/27:** MRC contact + Re-TRAC handoff email HELD in Bill's UI
- **Morena — hanging:** dispatch example emails nudge sent 2026-07-19, no reply; blocks ADR-0050

**Operator actions:**

- **O-2:** file-drop LIVE (`/admin/file-drop`); June + July workbooks uploaded per state check. Claude Code needs to pull + run promotion.
- **O-3:** RESTIC_PASSWORD off-box confirmation — STILL OPEN, critical-path
- **O-4:** Mary's account HELD (§8 doesn't change decision)
- **O-7:** CLOSED as "not needed" per §8 Q5
- **O-8:** Stage-0 runbook rows — unchanged

**Kelsey deadline moved: 2026-08-01 → 2026-08-08**

## §17 — Blocker list, current state

**Hard blockers:**
1. Workbook files on titan — Bill uploaded to file-drop; Claude Code needs to pull from R2 and run promotion
2. Kelsey confirmation of parser layout assumptions — **already given in Addendum A §A.1-A.5** (Q1/Q3/Q4 answers). Claude Code needs to know these confirmations are complete.
3. RESTIC_PASSWORD (O-3) — still gates Stage 1+ manager ramp

**Soft blockers (parallel):**
4. Rick's Covanta WTE + Xtraction Landfill answers (§11)
5. Morena's dispatch example emails
6. Kelsey's post-8/8 knowledge transfer (MRC contacts + Re-TRAC)

**No new hard blockers.** This session's answers unblocked more than they blocked.

## §18 — Session end-state

**Vision MRC billing module status:**
- All ADR amendments from PR #128 merged and deployed
- ADR-0055 (Recycling Rates) merged
- **All production data validated end-to-end** — June invoices reconcile to real workbook math (§10)
- Item code taxonomy locked (§9)
- GP identifiers confirmed
- Site type taxonomy expanded to 5 (`svdp_internal_store` added)
- Commodity breakdown attachment structure documented — 11-block, EOM only
- Event billing + TONU model documented — new ADR needed
- Pilot mode default — nothing to MRC until sign-off

**Ready to launch pilot cycle for July 2026 EOM (early August)** once:
1. Sources seeded per §4 + §14
2. New event billing ADR drafted + shipped
3. Parser promotion runs (Kelsey's answers already in Addendum A)
4. Rick's Covanta WTE + Xtraction Landfill answers land (soft blocker, not launch-critical for pilot)

**Pilot period:** Rick reconciles Vision invoices against his spreadsheets. When clean, admin flips `invoice_mode_config` from `pilot` → `production` per site+kind. That's the launch.
