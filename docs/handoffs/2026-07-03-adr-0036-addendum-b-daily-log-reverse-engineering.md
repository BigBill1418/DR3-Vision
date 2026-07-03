# ADR-0036 — Addendum B: Daily-Log Reverse Engineering — Category Model Corrected, Rate Card Recovered

**Date:** 2026-07-03 · **Amends:** ADR-0036 mission doc + Addendum A · **Source:** full build-spec extraction of `JUNE 2026 DAILY LOG WOODLAND.xlsm` (47 sheets, live workbook, via Claude in Excel; VBA modules unread — see B10)

## B1. Category model — Addendum A §A2 CORRECTED

The daily log's category breakdown is **load source types, not unit types**. MyMRC reports the combined commodity "Whole Mattresses and Foundations" — **no mattress/foundation split exists anywhere in the workbook and none is required**. Strike A2's "minimum category set: mattress, foundation."

**Inbound source types** (verbatim from `list!Q`): `inbound units`, `Unpaid Consumer Drop off`, `Incentive drop off`, `Illegal Drop off`, `event units` (⚠ excluded from the dropdown's fixed window `Q2:Q5` — confirm validity). Non-program is **site-driven, not commodity-driven** (B7). Map to/extend Vision's existing `load_source_type` enum (`cip_consumer` already exists): `standard_haul`, `unpaid_consumer_dropoff`, `cip_consumer` (=incentive), `illegal_dropoff` (new), `event`, with `non_program` derived from the site record.

**Outbound taxonomy** — two axes: commodity × sub-category. Commodities (verbatim, `list!I`): `trash, toppers, foam, metal, wood, cardboard, plastic, shoddy, cotton`. Sub-categories (`list!K`): `renovation, baled, shredded`. Renovation sub-category is what splits the renovator channel from commodity sales — cleaner than Addendum A's separate-channel framing; A4's nullable-whole-units note stands. ⚠ **Mapping question:** daily-log commodities (9) vs billing-workbook blocks (11: Landfill, Steel, Biomass, WTE, Wood, Toppers, Foam, Cardboard, Plastic, Cotton, Landfilled Units) — trash→Landfill vs WTE appears **destination-driven** (vendor determines block); confirm shoddy↔Biomass with Kelsey/Janette before fixing the outbound→invoice mapping.

Category capture point unchanged from A2: office daily close; iPad flow untouched; go-live unaffected.

## B2. Transport rates — Addendum A §A3 model CORRECTED (and capture item #8 RESOLVED)

Freight is **not $/mile**. It is a **mileage-tier zone table** (`variables!D7:F13`, duplicated at `Events!V4:W10`): 0–25 mi → $425 · 26–50 → $600 · 51–100 → $925 · 101–200 → $1,450 · 201–300 → $2,000 · 301–400 → $2,500 · 401–500 → $3,000 — plus a **per-account haul-rate override table** (`variables!H1:Q~86`). Revised design: `transport_rate_tiers` (effective-dated) + `account_haul_rates` (per-site overrides, effective-dated) + per-site canonical mileage. Freight computed from site mileage → tier (or override). Renegotiation exhibit becomes tier-jump math: e.g., GVCC 5→67 mi = $425→$925/haul; WARF 38→197 = $600→$1,450. Rick-scoped write per A3.

## B3. Fuel surcharge — capture item RESOLVED

Formula: **(weekly EIA West Coast PADD-5 diesel price ÷ 6.5 MPG) × miles**, applied when CA diesel exceeds **$5.05/gal**. Today: price hand-keyed weekly from the EIA page into `Fuel_Table`; surcharge results pasted as constants. Vision: `fuel_prices` weekly table with **EIA API auto-fetch** (manual override retained), surcharge computed per load, trigger threshold + MPG in `state_program_rules` (CA-only; OR structurally disallowed, unchanged).

## B4. Inventory & daily-close model (confirms + extends Track 2)

Equation: `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`; **NP inventory is a separate ledger** (`NP End = NP begin + NP inbound − sold − landfilled` per Processed!D45 shape). `Saved` (I42) is captured but **excluded from the equation** — semantics unknown (B10). Daily-close fields confirmed: processed/stripped, whole units sold, landfilled, saved(❓), material ticket # (M-xxxxxx), # employees, # processors, # pocketcoil estimate, authorized signature. Headcount field (Track 2) corroborated. **Capacity: Woodland 3,500 units** → locked 90%/100% warn thresholds = **3,150 / 3,500**. Capacity is per-site config.

**Defect exhibit (add to mission §4.1):** inventory roll chain **broken at DAY6** — hardcoded 2863 instead of `='DAY5'!E38`; whole days silently detached from the roll. Vision's roll is structural (prior close row FK), unbreakable by typing.

## B5. Parameterized constants (all into `state_program_rules` / site config — never code, never retyped)

55 lbs/unit (estimate only — MRC weight reporting uses actual scale weights on outbound; label estimate fields as such) · CA per-unit fee lookup **2025=$16.00, 2026=$16.50, 2027=$17.00** (a proper effective-dated fee table already existed at Summary!Q8:R11 and was ignored — the fee was retyped; Vision wires the table) · incentive $3/unit (`list!T2`) · driver $125/hr · general labor $90/hr · per diem $275/night · 6.5 MPG · $5.05/gal trigger.

## B6. Document-number sequences (Janette's parked item, partially answered)

DR3 # is a **running counter across days/months** (formula offsets observed: 4562→4586→4620→4655→4733→4767→4805 across June days 5–23; manual on other days). Material ticket # is per-day (M-xxxxxx). Vision issues both as **atomic DB sequences** with site scoping TBC — confirm with Janette whether DR3 # is per-site or company-wide, and the Material # issuance rule.

## B7. Site master data

Three classification lists drive the trans-charge classifier: non-program sites (16, verbatim incl. Petaluma, Golden Bear, Recology SF…), trans-charge sites (~49), no-charge sites (~88). Design: `collection_sites` with flags `is_non_program`, `is_trans_charge`, canonical name, mileage, + **alias table** for backfill — the workbook's own lists carry heavy spelling drift (`All about Buidling`, `Chester Tranfer`, `VAcaville`, a literal `Name` junk row) and DAY0 rows 125–318 hold three legacy site lists full of variant spellings. Historical data cannot be joined without alias resolution.

## B8. Two-artifact duplication (audit motivation)

The daily log's monthly tabs mirror the standalone MRC billing workbook — **the same monthly data is maintained twice**, by hand, today. The artifacts already disagree: June rentals total **$10,800** (42 trailers) in the daily log vs **$10,500** in the July billing workbook. Possibly a legitimate month change; either way it is precisely the drift class the 3-way audit + single-source design eliminates.

## B9. Additional defect exhibits (mission §4.1)

`#VALUE!` corpses stored as static header values across 9 monthly sheets (dead header formula, likely a severed prior-month link — 4 broken workbook names `=#REF!#REF!` confirm links once existed) · Summary mid-month transport shows **−925** while the typed O4/P4 mid-month totals are blank (`C13=O4−C14`) · stale identities: June table named `May2026__working__inb_trans_charges__2`, `June2025_toppers__reno`, labels "MRC May Total"/"May Total:" · fixed validation windows already exclude `event units` and will exclude any site past row 182 · hand-stretched per-commodity SUM end-rows (N85:N112 vs V85:V116 vs AD85:AD110…) — same silent-clipping class as §4.1 · mixed INDIRECT styles; IFERROR present on some rows, absent on others · vestigial columns (`Outbound Unit #` in inbound tables and vice versa) · DAY-sheet filter/staging blocks are pure presentation → Vision views/reports, not storage.

## B10. Open questions (routed)

1. **VBA modules unread** — does a macro populate the static Freight/Mileage/Assignment/ID/Fuel-Surcharge/Total columns on the trans-charges sheet and the `June2026All` consolidation, or is it hand lookup+paste? → Bill: Alt+F11, paste module code; or ask Janette. Determines whether any logic exists only in VBA.
2. **`Saved` (I42)** semantics — tracked, excluded from inventory math → Kelsey/Janette.
3. **`DAY6!AR5 = AL5×5`** — unexplained ×5 beside the incentive block (rate is $3) → Kelsey.
4. **`event units`** as valid inbound source type (excluded from its own dropdown) → Kelsey/Janette.
5. **Commodity→billing-block mapping**, esp. shoddy↔Biomass and trash→Landfill-vs-WTE destination logic → Kelsey/Janette.
6. **DR3 # scope** (per-site vs company-wide) + Material # issuance rule → Janette.
7. Rentals $10,800 (June) vs $10,500 (July) — confirm month change vs error → Rick.

## Kelsey July capture list — amended

**Resolved by this extraction:** ~~(8) freight rate basis~~ (tier table, B2) · ~~fuel-surcharge formula~~ (B3). **Remaining:** OR fee schedule · `%` column semantics (Steel/Biomass/WTE) · Re-TRAC/CalRecycle mechanics · MRC contact map · 30-min audit-comparison description · GP backstop · B10 items 2–5.
