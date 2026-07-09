# 2026-07-09 — June workbook + Terex file analysis (unblocks ADR-0048 D4)

**Files received from Bill 2026-07-09 ~07:12 UTC:**
- `JUNE_2026_DAILY_LOG_WOODLAND.xlsm` (716 KB, 47 sheets, VBA present, 258 internal files)
- `TEREX.xlsx` (491 KB, 40 sheets)

Two of three ADR-0048 D4 files landed. **Still outstanding:** Eugene Jun 24–30 daily log (whatever artifact holds it).

Analysis performed on both files. Structural findings documented below so Claude Code can finalize the ADR-0048 parser + ADR-0049 sync parser against real bytes rather than fixtures.

**Getting the files to titan:** the files are on Claude's analysis workstation, not on titan. Bill needs to scp them over (or drop via Google Drive / share) before Claude Code can run the promotion. Suggested paths on titan: `~/DR3-Vision/tests/fixtures/adr-0048/JUNE_2026_DAILY_LOG_WOODLAND.xlsm` and `.../TEREX.xlsx`. Or add them as gitignored `.fixtures/workbooks/` if Bill prefers not to commit binaries.

## §1 — June workbook structural inventory

Workbook has **two structural layers**:

### §1.1 — Category tabs (positions 0–14)

Aggregated / reference / summary sheets. Headers on **row 3** (not row 1). Data starts row 4. Wide tabs are horizontally partitioned into per-commodity sections with the header block repeated for each section.

| # | Name | Dims | Purpose |
|---|---|---|---|
| 0 | `June2026 inb trans charges` | 58r × 18c | Inbound with transportation charges. Cols: Date, Site, inbound unit #, LBS (55 per Unit), BOL # or Check #, DR3 #, Haul #, Freight Rate, Mileage, Mileage_Table.Assignment, ID, Fuel Surcharge, Total |
| 1 | `June26 inb no trans charge` | 149r × 10c | Inbound without transportation charges. Cols: Date, Site, commodity, inbound unit #, LBS, BOL # or Check #, DR3 #, Haul #, Office Use Only, trans charge |
| 2 | `June26 incentive_unpaid` | 61r × 20c | Two side-by-side sections: INCENTIVE DROP OFF and UNPAID DROP OFF |
| 3 | `NonProgram` | 166r × 10c | Non-program inbounds. Cols: Date, Site, commodity, inbound unit #, LBS, BOL # or Check #, DR3 #, Haul #, Office Use Only, trans charge. Example row: 2026-06-29, Petaluma, inbound units, 100, 5500, ..., 'NP' flag |
| 4 | `June2026 Renovation` | 5r × 89c | Renovation outbound by commodity. Cols per section: Date, Site, commodity, sub category, LBS, BOL #, DR3 #, Material #, Office Use Only. Sections observed: WOOD, METAL |
| 5 | `June26 Commodities` | 135r × 154c | Widest tab. Multi-section outbound-by-commodity. Cols per section: Date, Site, commodity, sub category, Outbound Unit #, LBS, BOL #, DR3 #, Material #, Office Use Only. First section observed: TRASH |
| 6 | `June26 Processed` | 56r × 71c | Processed units per day |
| 7 | `Container Rentals` | 47r × 71c | Rick's rate table. Cols: Date, Location, ID, Trailers, Trailer Size, Rental Amount Due, Container Drop Off, Facility |
| 8 | `Trans Summary` | 27r × 71c | Transportation summary |
| 9 | `Summary` | 34r × 77c | Two side-by-side sections: `Woodland- Summary MID-MONTH` and `Woodland- Month running total` |
| 10 | `Events` | 24r × 28c | Event units. Cols: Date, Customer, County, Slip, Units, Freight, Driver Hours, Drivers Wages, Labor Hours, Labor Wages, Mileage Reimb, Per Diem, Misc., ID# |
| 11 | `June2026All` | 168r × 22c | All inbounds combined; two side-by-side date-source-units sections |
| 12 | `variables` | 90r × 31c | Master lookup: Account Name, ID, Destinations, Primary/Secondary, Haul Rate, Mileage, Assignment, **Re-Trac Random ID = the account ID**, Container Rental Rate |
| 13 | `list` | 192r × 20c | Reference lists: All Inbound Sites, No trans charge sites, Non-program sites, trans charge sites (with rates), OUTBOUND, commodity list, sub category list, vendors |
| 14 | `Fuel` | 21r × 5c | EIA PADD-5 weekly diesel prices. Cols: Begin Date, End Date, Price per Gallon |

### §1.2 — DAY sheets (positions 15–46)

32 daily sheets: `DAY0` (opening state / 6/1 template) through `DAY31`. Each is 73 columns wide × ~252 rows deep, except **`DAY6` which is 75 columns** (see §3).

DAY-sheet layout is the **operator entry form** — the direct working sheet Janette fills in daily. Structure (row 4 has headers):

| Cols | Section | Fields |
|---|---|---|
| C–M (3–13) | SHIPMENT/LOGIN SHEET (inbound entry) | Date, Site, commodity, inbound unit #, Outbound Unit #, LBS (55 per Unit), BOL # or Check #, DR3 #, Haul #, Office Use Only, trans charge |
| P–Y (16–25) | INBOUND TRANS CHARGE $$ | Date, Site, Inbound Units, Inbound Unit #, LBS, BOL # or Check #, DR3#, Haul #, trans charge |
| Z–AK (26–37) | INBOUND NO TRANS CHARGE | Date, Site, Inbound Units, Inbound Unit #, weight, BOL, DR3#, Haul #, office use |
| AE–AS (30–45) | Consumer drop off | Date, Site, Inbound Units, Inbound Unit #, weight, check #, DR3#, Haul #, office use |
| Row 51+ | OUTBOUND-BY-COMMODITY GRID | 8 commodity blocks side-by-side: TRASH, METAL, WOOD, FOAM, TOPPERS, CARDBOARD, PLASTIC, SHODDY, each ~8 cols: Date, Site, Commodity, Weight, BOL# or Check #, DR3#, Haul#, revenue |
| Row 2 col K | Starting inventory | number carried forward from previous day |

Row 2 shows `Starting inventory` as a header, col L holds the numeric value. Example: DAY1 opens at 1423; by DAY6 it's 2863.

## §2 — Terex file structural inventory

40 sheets. Three functional groups:

### §2.1 — Maintenance & fuel tracking

| Sheet | Purpose |
|---|---|
| `Maintenance Log 2025`, `Maintenance Log2026` | Chronological maintenance events. Cols: Date, Time, Issue, Measures taken, Estimated repair time, Estimated cost, Notes, Actual Repair Cost, Amount Credited |
| `Maintenance Prices` | Labor rates ($180/hr Powerscreen, $100/hr Kelliher), parts pricing, oil change tracking (with machine hours + hours-since-last-oil) |
| `diesel` | Fuel consumption. Cols: Date, DEF, Gallons added, Units processed, gal/unit, $/gal, total $, days between fills, run time per fill (hrs), hours/gal |

### §2.2 — Monthly operating data (12 × 2026 + 12 × 2025 + 4 × 2024)

Layout is consistent across all months (with template variations). Sheet name pattern: `Jan 2026`, `Feb26`, `March26`, `Apr26`, ..., `Dec26` (2026), `Jan25`, `Feb25`, ... (2025), `Sept24`, `Oct24`, `Nov24`, `Dec24` (partial 2024).

Layout: **row 1** = "Terex Operating Data" + month/year, **row 2** = column headers, **rows 3+** = one row per day of month.

Standard columns (from `Jan 2026` reference sheet):
- Day (1–31)
- Pocket coil (units processed)
- Springs (units processed)
- Wood (units processed)
- Start Hours (meter reading at day start)
- End Hours (meter reading at day end)
- Day Total Hrs Used (= End Hours − Start Hours)
- Units per hour (calc)
- Operator (name, e.g. "Tim", "Timothy", "Justin", "operator?")
- condition* (single-letter code, see §2.4)
- Notes (free text)

Small variations across months: some 2025 sheets add `PC Units per hour`, `Springs Units per hour`, `Wood Units per Hour` as separate columns; `Feb26` adds `re-fuel` column; older 2024 sheets have a different shape entirely (Sept24 uses different column layout).

### §2.3 — Overview & cost sheets

| Sheet | Purpose |
|---|---|
| `OVERVIEW2026`, `OVERVIEW2025` | Monthly high/low/average processed units per hour, hours used per month |
| `Combined Costs Per Coil` | Cost analysis: coils/springs/wood per month with estimated cost per unit |
| `Combined Totals` | Total hours + avg hours per day + weekdays running + maintenance costs |
| `Annual Cost` | Loan payment ($6500), Diesel ($3500), Maint, Labor ($4200), Forklift ($1575) — Estimates vs Actual for 2025 |
| `Template`, `Template (2)`, `Aug25(1)` | Blank/example monthly templates |

### §2.4 — Condition code enum (from observed data)

- `G` — Good (running normally)
- `LOTO` — Lock Out Tag Out (maintenance-blocked; machine down)
- `PS` — Partial Shutdown (partial operation, sometimes recorded with reason in Notes)
- `FS` — Full Shutdown (down all day)
- `CLOSED` — Holiday / no work
- (blank) — no data recorded

## §3 — Kelsey capture items resolved by the data

### §3.1 — B10-1 (VBA modules)

Extracted 41 VBA modules from `xl/vbaProject.bin`. **Zero business logic.** Only three unique procedures, all variations of the same intent:

- `Module1.CreateDailySheets_February` — copies TEMPLATE sheet 28× to create daily sheets for February
- `Module2.CreateDailySheets_February_SAFE` — improved version with ScreenUpdating off + table name collision resolution
- Numerous `Sheet##.cls` copies of the SAFE version — harmless duplicates (VBA embedded on individual sheet objects from macro re-runs)

**Nothing operational to replicate in Vision.** B10-1 is answered: no freight, consolidation, billing, or reporting logic in VBA. All macros are utility template-copying.

### §3.2 — B10-3 (DAY6 `×5` quirk)

**Resolved.** DAY6 uniquely adds a **9th commodity block: COTTON** at cols 68–75 (BR–BW). Row 51 header sequence on DAY6: `TRASH · METAL · WOOD · FOAM · TOPPERS · CARDBOARD · PLASTIC · SHODDY · COTTON`. Every other DAY has 8 commodity blocks; only DAY6 has 9. Row 52 of DAY6 col 68+ shows a cotton block header (`Date | Site | Commodity | Weight | BOL# or Check # | DR3# | Haul# | revenue`) with `no entries found` in row 53.

This aligns exactly with **ADR-0037 Addendum B's daily-log-9 taxonomy** (`trash / toppers / foam / metal / wood / cardboard / plastic / shoddy / cotton`). DAY1–5 and DAY7–31 are missing cotton — the template wasn't updated at the start of June to include it; DAY6 was the day it got added ad-hoc.

The "×5" note Kelsey wrote is still worth verifying with her — it may point to a specific formula multiplier inside the cotton block (e.g. `=weight*5` somewhere for a conversion), not the structural quirk itself. **Structural quirk fully understood; formula-level `×5` still needs Kelsey's walkthrough to confirm.**

### §3.3 — B10-4 (event units validity as inbound type)

**Partial answer from Events tab structure.** The Events sheet has a `Units` column (col E, row 3 header) alongside Date, Customer, County, Slip, Freight, Driver Hours, Drivers Wages, Labor Hours, Labor Wages, Mileage Reimb, Per Diem, Misc., ID#. This suggests events DO carry inbound-unit counts. Kelsey walkthrough still needed to confirm whether these units feed the running balance the same way as standard inbounds, or whether they're accounted separately.

### §3.4 — Fuel formula validation

The `Fuel` tab holds EIA PADD-5 diesel weekly prices (Begin Date / End Date / Price per Gallon). This is the exact data source for the CA fuel surcharge formula captured from Rick Q6: `(EIA West-Coast ULSD weekly rate ÷ 6.5 mpg) × miles driven`. Parser can extract these weekly prices to feed ADR-0040 fuel surcharge computation.

### §3.5 — Re-TRAC = MyMRC haul/materials number

Validated in `variables` col N: labeled `Re-Trac Random ID`, values match the `ID` column (col B). Kelsey Q3 answer confirmed structurally.

## §4 — Parser skeleton for Claude Code

Based on the analysis above, ADR-0048's promotion staging contract needs one parser per shape. Suggested modules:

### §4.1 — Woodland daily-log parser (feeds ADR-0048 + ADR-0049)

Location: `src/lib/audit/parsers/woodland-daily-log.ts`

Emits one `WorkbookImportRow` per record. Sections per ADR-0048 D1: `opening_inventory`, `daily_close`, `inbound`, `outbound`, `landfilled`, `dropoff`.

Approach: **read the category tabs, not the DAY sheets.** The category tabs (positions 0–14) are the already-aggregated views. DAY sheets are operator-entry forms that also feed the categories via formulas. Reading category tabs = reading the same numbers via a stable structure.

Per-section parsing:
- `inbound (trans charge)` → `June2026 inb trans charges` tab, header row 3, data row 4+
- `inbound (no trans charge)` → `June26 inb no trans charge`, header row 3, data row 4+
- `inbound (incentive)` → `June26 incentive_unpaid` left section
- `inbound (unpaid)` → `June26 incentive_unpaid` right section (offset from col N-ish, verify)
- `inbound (non-program)` → `NonProgram` tab
- `outbound (renovation)` → `June2026 Renovation` — iterate horizontal sections by commodity (WOOD, METAL observed; find rest by scanning row 2)
- `outbound (commodity)` → `June26 Commodities` — iterate sections; sub_category column populates the ADR-0037 Addendum B `sub_category` field
- `daily_close (processed)` → `June26 Processed`
- `opening_inventory` → DAY1 row 2 col L ("Starting inventory")
- Fuel weekly prices → `Fuel` tab (feeds ADR-0040, not ADR-0048)
- Site/rate lookup → `variables` tab (feeds `source_aliases` and `Source.canonical_mileage`)

Row-3-headers rule: always start reading at row 4 of a category tab; row 1 is title/#VALUE!, row 2 is section label, row 3 is column header.

Horizontally-partitioned tabs: detect section boundaries by scanning row 2 for non-empty cells (each non-empty col in row 2 marks the start of a new section with the same column layout as the primary).

Provenance: every row emits `site_name_raw` from the Site column (resolves via ADR-0037 `source_aliases` → `sources.id`). Rows where Site is empty are skipped.

### §4.2 — Terex parser (feeds ADR-0048 D3)

Location: `src/lib/equipment/parsers/terex-monthly.ts`

Emits `equipment_events` rows. Parsing strategy:

1. **Monthly sheet detection:** iterate all sheets, match names against patterns:
   - `^(Jan|Feb|March?|Apr|May|Jun|July?|Aug|Sept?|Oct|Nov|Dec)\s?(2[45]|2026)$` or `Jan 2026` variants
   - Skip: `Template*`, `OVERVIEW*`, `Combined *`, `Annual Cost`, `Maintenance*`, `diesel`, `Aug25(1)`
2. **Per-sheet:** month/year from row 1 col D/E. For each row 3+ where col A is a day number (1-31):
   - `event_date` = date(year, month, day)
   - `pocket_coil`, `springs`, `wood` = cols B, C, D respectively
   - `start_hours`, `end_hours`, `hours_used` = cols E, F, G
   - `units_per_hour` = col H (calculated; can be ignored — Vision recomputes)
   - `operator` = col I
   - `condition_code` = col J (enum: G, LOTO, PS, FS, CLOSED, empty)
   - `note` = col K (free text)
   - `event_kind` = `downtime` when condition_code ∈ (LOTO, FS) OR hours_used = 0 AND has_note; `note` otherwise
3. **Maintenance Log 2026 → separate feed:** parse as `equipment_events(kind='maintenance')` with cost fields
4. **Idempotency**: match on (site='woodland', event_date, kind, note-hash) per ADR-0048 D3

Field mapping table (for the schema):

```
event_date          date
kind                enum: 'note' | 'downtime' | 'maintenance'
pocket_coil_units   int?   (nullable — some days blank)
springs_units       int?
wood_units          int?
start_hours         decimal(8,2)?
end_hours           decimal(8,2)?
hours_used          decimal(6,2)?  (derived; store the raw for audit)
operator            text?
condition_code      enum
note                text?
maintenance_cost    money?         (only for kind='maintenance')
maintenance_credit  money?
source              enum: 'import'
import_id           uuid            (per ADR-0048 provenance)
```

### §4.3 — Fixture data expectations

For test fixtures based on real bytes:

- Woodland: DAY1 opening inventory = 1423; June-end close = 4062 (per ADR-0048 D2 assertion)
- Terex: `Jun26` row 3 col B (day 1) = 168 (Pocket coil units); row 3 col E-F = 2306.75 / 2315.45 (hour meter)
- Fuel: `Fuel` row 3 (first weekly price) = 3/2/2026 – 3/8/2026 at $4.534/gal

## §5 — Blocker list update

Down from 3 items to 2 pending Bill actions:

1. `RESTIC_PASSWORD` 1Password confirmation (P1-4) — Claude Code to build 1Password automation into a future handoff
2. ~~Three files for ADR-0048 promotion~~ **partially unblocked** — Woodland + Terex files received and analyzed; Eugene Jun 24–30 log still outstanding
3. Kelsey walkthrough scheduling — Bill schedules 7 walkthroughs before 8/1

## §6 — Actions for Claude Code

1. Read this handoff, confirm the analysis matches when the actual files arrive on titan
2. Implement `src/lib/audit/parsers/woodland-daily-log.ts` per §4.1 against the fixture rules in §4.3
3. Implement `src/lib/equipment/parsers/terex-monthly.ts` per §4.2
4. Wire both parsers into the existing ADR-0048 promotion pipeline (`workbook-promotion.ts`, `equipment/import.ts`)
5. Extend Addendum B taxonomy to include `cotton` on the outbound commodity enum (per §3.2 finding — cotton is the 9th commodity per Addendum B design; the June workbook confirms it operationally on DAY6)
6. Add a fixture-based unit test proving Woodland June close = 4062 via the parsed data (ADR-0048 D2 assertion)
7. Once files arrive on titan (Bill will scp), run ADR-0048 promotion in dry-run mode and post the preview counts

## §7 — Actions for Bill

Two small ones:

1. **scp the two files to titan.** Path: `~/DR3-Vision/tests/fixtures/adr-0048/` or `~/DR3-Vision/.fixtures/workbooks/` (whichever fits repo conventions — Claude Code can advise). Files are in Bill's Claude workspace under `/mnt/user-data/uploads/`.
2. **Chase Eugene Jun 24–30 daily log.** Rick or whoever owns Eugene's daily records. Same drop path as the other two.

Nothing this blocks tonight — Bill's crashing. Files can move whenever he's back.
