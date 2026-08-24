# Phase 0 parity audit — the Woodland daily-log workbook → Vision

**Date:** 2026-08-19 (Pacific). **Status:** DRAFT — reported to Bill, gates the h276 Phase 1 build.
**Scope:** handoff `docs/handoffs/2026-08-19-h276-eod-surface-retire-woodland-workbook.md`, §PHASE 0.
**Repo state:** `main` @ `edb195f`. Read-only audit; nothing was built.

## What was measured, and how

| Source         | Method                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live workbook  | `AUGUST 2026 DAILY LOG WOODLAND.xlsm`, downloaded from Kelsey Ruhland's OneDrive via the ADR-0049 `graphFilesTransport` (`Files.Read.All`, `MSGRAPH_MAIL_*` creds). 736,669 bytes, `lastModified` 2026-08-19 16:23 PDT. Parsed with `exceljs`, reading the Excel Table (ListObject) refs so row counts are the sheet's own ranges, not eyeballed. |
| July reference | `JULY 2026 DAILY LOG WOODLAND.xlsm`, same transport, `lastModified` 2026-08-04 15:56 PDT (finalized month).                                                                                                                                                                                                                                       |
| Vision DB      | Production Postgres (`dr3-vision-postgres` on CHAD-HQ, container IP `172.23.0.4`, matching the app's `DATABASE_URL` host `postgres:5432`) via the standing tunnel `127.0.0.1:15432`.                                                                                                                                                              |
| Code           | `prisma/schema.prisma`, `src/`, `scripts/`, `docs/adr/` at `edb195f`.                                                                                                                                                                                                                                                                             |
| Runtime probe  | Isolated scratch database `h276_probe` (`prisma db push`, dropped after use). Prod data untouched.                                                                                                                                                                                                                                                |

**Correction to the handoff's read path.** The handoff pointed at `docIngestGraph(prisma).downloadItem(...)`. That is the wrong transport. The workbook is reached through the **workbook-sync** connection: `workbook_sources` row → `drive_upn = kelsey.ruhland@svdp.us`, `folder_path = DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland`, `naming_pattern = {MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`, `is_syncing = true`, last successful poll 2026-08-19 16:17 PDT. The month **and the folder** roll over on the pattern (ADR-0102).

---

## 0. Headline findings

Six findings change the Phase 1 build. Each is expanded below.

1. **F-1 — The workbook double-counts, chronically, and its own billing totals inherit it.** Three tabs carry exact whole-row duplicate pairs in both July and August. The sheet's `Transportation Total` and `Fuel Surcharge` equal the _duplicated_ sums. **The handoff's Phase 2 acceptance criterion — "the month rollup reproduces the Summary / Trans Summary tabs" — must be withdrawn.** Matching the sheet would reproduce a defect.
2. **F-2 — The handoff's volume table does not reproduce.** Five of seven figures are wrong; two are wrong in the direction that would have under-built a real daily channel (`Commodities` ~13× understated, `NonProgram` stated as zero but is a daily channel).
3. **F-3 — Eight identifying/billing columns on `inbound_loads` have a schema home and have NEVER been written.** Measured across all 743 rows in prod: `dr3_number`, `external_mymrc_haul_id`, `bol_number`, `retrac_id`, `slip_number`, `freight_cents`, `fuel_surcharge_cents`, `import_id` are 100% NULL, and `transport_charged` is `false` on every row. This is the "home exists in schema, no capture path" class the audit existed to catch — and it covers most of the `inb trans charges` tab.
4. **F-4 — The entire CA inbound freight + fuel-surcharge invoice leg is structurally empty and fails silently.** `resolveTransportationInputs` selects `where transport_charged = true`; nothing ever sets it; the loop runs zero times and no error is raised.
5. **F-5 — `workbook-promotion.ts` throws at runtime on any inbound promotion.** Empirically proven, not inferred. TypeScript does not catch it.
6. **F-6 — Three reference tables that the sheet depends on are EMPTY in prod:** `fuel_prices` (0), `container_rental_sites` (0), `account_haul_rates` (0). Their homes, write paths and admin surfaces all exist; the data was never loaded.

---

## 1. Row-volume reality check

Counts are **data rows inside the sheet's own ListObject ranges**, excluding `Total` rows. "distinct" = exact whole-row de-duplication.

| Tab                                | Handoff (claimed July) | **July 2026 measured**                                                                               | **August 2026 measured (1st–19th)**                                                            | Verdict                              |
| ---------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| `inb no trans charge`              | 93                     | **302 raw / 151 distinct**                                                                           | **186 raw / 93 distinct**                                                                      | ✗ wrong                              |
| `inb trans charges`                | 19                     | **98 raw / 49 distinct**                                                                             | **48 raw / 25 distinct**                                                                       | ✗ wrong                              |
| `Commodities` (outbound, 9 blocks) | 8                      | **175** (trash 65, wood 51, metal 46, foam 8, toppers 3, cardboard 1, plastic 1, shoddy 0, cotton 0) | **102** (trash 40, wood 27, metal 27, foam 4, plastic 3, toppers 1, cardboard/shoddy/cotton 0) | ✗ wrong by ~13–20×                   |
| `NonProgram`                       | 0                      | **12**                                                                                               | **18**                                                                                         | ✗ wrong — it is a live daily channel |
| `incentive_unpaid`                 | 1                      | incentive **1** / unpaid **41 raw / 21 distinct**                                                    | incentive **0** / unpaid **22 raw / 11 distinct**                                              | ✗ wrong — unpaid is ~daily           |
| `Renovation` (9 blocks)            | 1                      | **4** (wood 2, foam 1, whole-units-non-program 1)                                                    | **2** (foam 1, whole-units-non-program 1)                                                      | ✓ near-zero confirmed                |
| `Container Rentals`                | 42                     | —                                                                                                    | **41**                                                                                         | ✓                                    |

**Consolidated month tabs (the sheet's own de-duplicated union, and the best single sizing number):**

|                       | July                    | August (to 19th)            |
| --------------------- | ----------------------- | --------------------------- |
| `{Month}All.Inbound`  | 229 rows / 229 distinct | **144 rows / 144 distinct** |
| `{Month}All.Outbound` | 183 rows / 183 distinct | **107 rows / 106 distinct** |

**Vision's own August 1–19 Woodland inbound count: 113 rows** (`inbound_loads`, non-voided, `arrived_at` in window) — 95 `b2b_haul/submitted`, 14 `mymrc_haul/verified`, 3 rejected, 1 arrived. Against the sheet's 144. The two do not agree and neither is obviously the truth; **reconciling 144 vs 113 is a prerequisite to trusting either surface, and is not in the h276 scope today.**

### What this does to the UI sizing

The handoff's design brief — "inbound gets the heaviest affordance; outbound is light at 8 rows; non-program/incentive/renovation get collapsed add-lines" — is **half right**:

- **Inbound (~144/mo) — heaviest affordance.** Confirmed.
- **Outbound commodities (~107–183/mo) — the SECOND heaviest, not light.** It needs a real add-line with a commodity selector, not a token affordance. It is also 9 separate per-commodity tables in the sheet with **two different column sets** (`wood` and `foam` have no `Outbound Unit #`).
- **NonProgram (12–18/mo) and unpaid dropoff (11–21/mo) — near-daily, not near-zero.** A collapsed add-line is defensible for volume, but these must not be treated as exceptional. NonProgram's discriminator is the literal string `NP` in the `trans charge` column.
- **Renovation (2–4/mo) and incentive (0–1/mo) — genuinely near-zero.** Collapsed add-line is right.

---

## 2. F-1 — The workbook double-counts, and its totals inherit it

Measured, both months, exact whole-row equality across every column:

| Tab                                                     | July raw → distinct | August raw → distinct | Duplicated?                 |
| ------------------------------------------------------- | ------------------- | --------------------- | --------------------------- |
| `inb no trans charge`                                   | 302 → 151           | 186 → 93              | **every row exactly twice** |
| `inb trans charges`                                     | 98 → 49             | 48 → 25               | 23 of 25 doubled            |
| `incentive_unpaid.unpaid`                               | 41 → 21             | 22 → 11               | **every row exactly twice** |
| `NonProgram`, `Commodities`, `Renovation`, `{Month}All` | —                   | —                     | **not duplicated**          |

The duplicates are interleaved per day-block (August rows 4–11 are all 08-03; rows 12–19 repeat them byte-for-byte), and the Excel Table ranges span both copies — so every `SUM`/`SUBTOTAL` over those tables counts each haul twice.

**It reaches the money.** Computed from the sheet's own cells:

| Figure                                | Sum over RAW rows       | Sum over DISTINCT rows | What the sheet's Summary asserts      |
| ------------------------------------- | ----------------------- | ---------------------- | ------------------------------------- |
| Aug Transportation Total              | **51,800**              | 25,900                 | **51,800** ← raw                      |
| Aug Fuel Surcharge                    | **3,880.4791692307685** | 1,940.24               | **3,880.4791692307685** ← raw         |
| Jul Transportation Total              | **112,150**             | 56,075                 | **112,150** ← raw                     |
| Jul Fuel Surcharge                    | **9,759.805138461534**  | 4,879.90               | **9,759.805138461534** ← raw          |
| Aug `inb no trans charge` units / lbs | **17,298 / 951,390**    | 8,649 / 475,695        | Total row: **17,298 / 951,390** ← raw |
| Aug unpaid dropoff units / lbs        | **322 / 17,710**        | 161 / 8,855            | Total row: **322 / 17,710** ← raw     |

July's `End Of Month Trans Invoice` reads **135,209.81**; on distinct rows the transportation + surcharge components would be roughly half.

**Calibration.** What is proven: the rows are byte-identical pairs, in a finalized month as well as a live one, and the sheet's totals sum over both copies. What is _not_ proven: which figure DR3 actually invoiced MRC. It is possible — though I found no mechanism for it — that the duplication is deliberate and the per-row rate is a half-rate. **Bill/Kelsey should check July's transportation invoice against 112,150 vs 56,075 before anything else here is acted on.** If the invoice says 112,150, the sheet is over-billing; if 56,075, then the Summary tab is not what feeds the invoice and we need to find what does.

**Build consequence (must be decided before Phase 2):** the handoff's success criterion _"the month-to-date rollup reproduces the Summary / Trans Summary tabs"_ is unusable as written. Replace it with: _the rollup equals the sum of the sections it displays, computed once (ADR-0110), and any divergence from the sheet's Summary is reported as a reconciliation line, not eliminated._

---

## 3. The parity table

Legend — the four verdicts, kept strictly distinct:

- **MAPPED** — home + a write path + a surface a human can drive.
- **write-path-without-surface** — something writes it (usually a machine), but no human can enter or correct it.
- **home-without-write-path** — the column exists in `schema.prisma`; nothing in `src/` or `scripts/` ever writes it.
- **NO HOME** — no column anywhere.

A ⛔ marks a column that is _additionally_ NULL on 100% of prod rows.

### 3.1 `inb trans charges` — freight inbound (25 distinct rows in Aug)

Real header (row 3, live): `Date · Site · inbound unit # · LBS. (55 per Unit) · BOL # or Check # · DR3 # · Haul # · Freight Rate · Mileage · Mileage_Table.Assignment · ID · Fuel Surcharge · Total` + a `Mid-month billing totals` block (`Freight · Fuel Surcharge · Total`). Note `ID` and the mid-month block are **not in the handoff's column list**.

| Column                   | Home                                                                                                      | Capture path                                                                                                                                         | Surface                                                                                   | Verdict                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                     | `inbound_loads.arrived_at`                                                                                | MyMRC bridge (`inbound-bridge.ts:238-256`, ADR-0089 `recycler_reported_delivery_date ?? docking_appointment_date`), dock capture, bulk/floor inbound | `/operator/[site]/queue`, `/operator/[site]/inbound`, `/dashboard/[site]/loads-inventory` | **MAPPED**                                                                                                                                                                                                                                                            |
| Site                     | `inbound_loads.source_id` → `sources.name`                                                                | inherited from `expected_loads` (MyMRC scrape)                                                                                                       | read-only                                                                                 | **MAPPED** (per-load); the bridge's day-aggregate rows carry no `source_id`                                                                                                                                                                                           |
| inbound unit #           | `inbound_loads.total_units` (+ `program_unit_count`/`non_program_unit_count`)                             | `finishUnload`, bridge, bulk, floor                                                                                                                  | operator stack counter, `/operator/[site]/inbound`                                        | **MAPPED**                                                                                                                                                                                                                                                            |
| LBS (55/unit)            | `inbound_loads.weight_lbs`                                                                                | `captureWeight`, `correctWeight`                                                                                                                     | operator weight stage                                                                     | **MAPPED but semantically different** — Vision stores a **scale reading**; the sheet stores `units × 55`. `UNIT_WEIGHT_ESTIMATE_LBS = 55` exists (`src/lib/rates/types.ts:16`) but is applied only to _landfilled_ units, never to inbound. Populated on 25/743 rows. |
| BOL # or Check #         | `inbound_loads.bol_number` (BOL only)                                                                     | MyMRC scrape → `expected_loads.bol_number`, copied at `load-service.ts:300`. No human writer.                                                        | none                                                                                      | ⛔ **write-path-without-surface**; the **"Check #" half has NO HOME**                                                                                                                                                                                                 |
| DR3 #                    | `inbound_loads.dr3_number`                                                                                | `verify-gate.ts:211-223`, CA-only, via `issueDocumentNumber`                                                                                         | none — zero hits for `dr3_number` under `src/app`; never even displayed                   | ⛔ **write-path-without-surface**                                                                                                                                                                                                                                     |
| Haul #                   | `expected_loads.external_mymrc_haul_id` (NOT NULL) / `inbound_loads.external_mymrc_haul_id` (nullable)    | MyMRC scrape writes the _expected_ column only                                                                                                       | 5 read-only ADR-0090 surfaces via `haulNumberOf()`                                        | **MAPPED, display-only** — no entry or correction path. The inbound-side column is ⛔ and its documented writer does not exist (see §5).                                                                                                                              |
| Freight Rate             | rate tables `transport_rate_tiers`, `account_haul_rates`; per-load `inbound_loads.freight_cents`          | rates via `/api/admin/billing-rates/*`; per-load amount derived at invoice time (`generation-inputs.ts:293`)                                         | `/admin/billing-rates/tiers`, `/admin/billing-rates/haul-rates`                           | **MAPPED as a rate**; the per-load column is ⛔ dead. **`account_haul_rates` holds 0 rows.**                                                                                                                                                                          |
| Mileage                  | `sources.canonical_mileage`                                                                               | **nothing** — DDL only (`20260703b/migration.sql:68`), no create/update anywhere, not seeded                                                         | read-only tile at `/dashboard/billing-variance`                                           | **home-without-write-path**                                                                                                                                                                                                                                           |
| Mileage_Table.Assignment | —                                                                                                         | —                                                                                                                                                    | —                                                                                         | **NO HOME.** `woodland-freight.ts:11` says so outright ("no Assignment table exists yet") and pins all Woodland freight to Primary as a transitional rule; that resolver has no non-test caller.                                                                      |
| ID _(undocumented)_      | `sources` / `container_rental_sites` external id — the `Re-Trac Random ID` from `variables!Mileage_Table` | —                                                                                                                                                    | —                                                                                         | **NO HOME** as an inbound-row column                                                                                                                                                                                                                                  |
| Fuel Surcharge           | `inbound_loads.fuel_surcharge_cents`                                                                      | **nothing** — zero references in `src/` incl. tests. Value derived at invoice time by `computeFuelSurchargeCents` (`fuel.ts:114`)                    | input surface only: `/admin/billing-rates/fuel-prices`                                    | **home-without-write-path** (column ⛔ dead; value derived)                                                                                                                                                                                                           |
| Total / Freight          | no column — derived into `invoice_lines`                                                                  | `src/lib/invoices/generate.ts`                                                                                                                       | invoice surfaces                                                                          | derived                                                                                                                                                                                                                                                               |
| Mid-month block          | —                                                                                                         | —                                                                                                                                                    | —                                                                                         | **NO HOME** — Vision has no mid-month billing snapshot concept                                                                                                                                                                                                        |

**The CA fuel-surcharge formula, confirmed from both sides.** The sheet states it on the `Events` tab: _"Fuel Surcharge may be added if CA exceeds $5.05/gal, use the following formula: (EIA gas rate / 6.5 miles per gal) × miles driven."_ `src/lib/billing-rates/fuel.ts:145` implements `cents = Math.round((usdPerGal / mpg) * miles * 100)`, applied iff `price > trigger` **strictly** ($5.05 exactly does not apply), with `trigger_usd_per_gal` and `mpg` from `state_program_rules` and `miles` from `sources.canonical_mileage`. A missing week throws `MissingFuelPriceError` (422), never a silent $0. **Both of its data inputs are empty in prod** (`fuel_prices` 0 rows; `canonical_mileage` never written).

### 3.2 `inb no trans charge` — the 93-row workhorse

Real header: `Date · Site · commodity · inbound unit # · LBS. (55 per Unit) · BOL # or Check # · DR3 # · Haul # · Office Use Only · trans charge`.

Date / Site / units / LBS / BOL / DR3 / Haul are identical to §3.1. The two distinct columns:

| Column           | Home                                                                                                                                                                                                                                                                          | Capture path                                                                                                                                                                                                                           | Surface | Verdict                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------- |
| **commodity**    | **none on `inbound_loads`** — confirmed against the model's full field list and the generated `InboundLoadCreateManyInput`. `commodity` exists only on `OutboundMaterial`, `RecyclingRate`, `MymrcHaulsMirror` (mirror-only, never bridged) and the doc-ingest absorbed rows. | The DAY-grid parser reads a `commodity` cell but only as a **channel classifier** (`"inbound units"` → `inbound_loads`; `"unpaid/incentive/illegal drop off"` → `consumer_dropoffs`). The literal value is discarded for inbound rows. | —       | **NO HOME**                                 |
| **trans charge** | `inbound_loads.transport_charged Boolean @default(false)`; classifier `sources.is_trans_charge`                                                                                                                                                                               | **nothing writes either.** Repo-wide grep finds only reads (`generation-inputs.ts:272`, `leg-fetchers.ts:105`) plus DDL.                                                                                                               | none    | ⛔ **home-without-write-path**              |
| Office Use Only  | —                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                      | —       | **NO HOME** (sheet-internal scratch column) |

Observed values in the live `commodity` column: `inbound units`, `Illegal Drop off`, `Unpaid Consumer Drop off`, `Incentive drop off`, `event units` (from the `list` tab's INBOUND commodity picklist). So the column is a channel label, not a material — which is why "no home" is the correct verdict rather than a missing enum.

### 3.3 `incentive_unpaid`

Two side-by-side blocks: `incentive` (A3:K5, cols include `Outbound Unit #`) and `unpaid` (M3:T26). Target: `consumer_dropoffs`.

`ConsumerDropoffKind` verbatim (`schema.prisma:2441-2455`): `incentive`, `unpaid`, `illegal`, `floor_public`, `floor_incentive`. **`unpaid` exists.**

| Column                        | Home                                                         | Capture path                                              | Surface                                                                                                                            | Verdict                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Date                          | `consumer_dropoffs.dropoff_date`                             | operator floor / manager                                  | `/operator/[site]/dropoff` (floor kinds only); `/dashboard/[site]/loads-inventory` → Consumer drop-offs (incentive/unpaid/illegal) | **MAPPED**                                                                                                                   |
| Site                          | `consumer_dropoffs.site_id`                                  | both                                                      | both                                                                                                                               | **MAPPED**                                                                                                                   |
| commodity                     | —                                                            | the value _is_ the `kind`; discarded after classification | —                                                                                                                                  | **NO HOME** (degenerate — the information it carries is mapped)                                                              |
| inbound unit #                | `consumer_dropoffs.units`                                    | both                                                      | both                                                                                                                               | **MAPPED**                                                                                                                   |
| LBS (55/unit)                 | —                                                            | —                                                         | —                                                                                                                                  | **NO HOME** (sheet-derived)                                                                                                  |
| BOL # / Check #               | Check # → `consumer_dropoffs.check_number`; **BOL # → none** | manager `createDropoff`/`updateDropoff`                   | manager tab                                                                                                                        | split **MAPPED / NO HOME**                                                                                                   |
| DR3 # · Haul # · trans charge | —                                                            | —                                                         | —                                                                                                                                  | **NO HOME** on dropoffs                                                                                                      |
| **Outbound Unit #**           | —                                                            | —                                                         | —                                                                                                                                  | **NO HOME — vestigial.** Named as such in `docs/handoffs/2026-07-03-adr-0036-addendum-b-daily-log-reverse-engineering.md:47` |
| 2nd Date/Site block (UNPAID)  | same table, `kind='unpaid'`                                  | manager                                                   | manager tab                                                                                                                        | **MAPPED**                                                                                                                   |

**Premise correction.** The handoff routes this tab to "the ADR-0085 dropoff capture (`floor_incentive`/unpaid)". That conflates two disjoint surfaces. The iPad offers **only** `floor_public`/`floor_incentive`, which are label-only by CHECK constraint — no money, no name, no slip. The manager desktop offers **only** `incentive`/`unpaid`/`illegal`. The workbook's tab — which carries check numbers and named payees — maps to the **manager** form, not the iPad flow.

**Prod:** `consumer_dropoffs` holds **6 rows total**, against 11 unpaid dropoffs in August alone and 21 in July.

### 3.4 `NonProgram`

Same inbound columns; the discriminator is the literal `NP` in `trans charge`.

Program/non-program is captured at four grains: `sources.is_non_program` (the classifier), `inbound_loads.program_unit_count`/`non_program_unit_count` (per load), `pool-routing.ts:45` (the routing map), and `site_inventory_snapshots.program_units`/`non_program_units` (the anchor). Per-load counts are **MAPPED** and populated (635/743 rows).

**Flag: the classifier has no UI.** `sources.is_non_program` is written by seed only; there is no `/admin/sources` route anywhere in the page tree. A new non-program source can be classified only by editing the seed or by hand-SQL.

**Note on the target ADR.** The handoff cites "the pool split (ADR 2026-07-23)". No such ADR exists. The pool split is **ADR-0037 §3 amendment** (`0037-loads-inventory-foundations.md:402-427`, plus the §3.2 amendment at `:490-493` that created `pool-routing.ts`). The two 2026-07-23 documents are _plans_, feeding **ADR-0059** (inbound bridge) and **ADR-0058** (processed bridge).

### 3.5 `Renovation` — 9 per-commodity tables, 2 rows in August

Not one flat table: `wood__reno`, `metal__reno`, `foam__reno`, `toppers__reno`, `cardboard__reno`, `plastic__reno`, `shoddy__reno`, `cotton__reno`, `whole_units__non_program`. Target: `outbound_materials.sub_category = 'renovation'` (`OutboundSubCategory`: `renovation`, `baled`, `shredded`).

| Column                              | Home                                                                   | Capture path                         | Surface                                                  | Verdict                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Date                                | `outbound_materials.ship_date`                                         | `createOutbound` (`outbound.ts:231`) | `/dashboard/[site]/loads-inventory` → Outbound materials | **MAPPED**                                                                  |
| Site                                | `site_id` (route-derived)                                              | same                                 | same                                                     | **MAPPED**                                                                  |
| commodity                           | `commodity` (9-value enum)                                             | same                                 | form select                                              | **MAPPED**                                                                  |
| sub category                        | `sub_category`                                                         | same                                 | form select                                              | **MAPPED**                                                                  |
| LBS                                 | `weight_lbs`                                                           | same                                 | form                                                     | **MAPPED**                                                                  |
| **BOL #**                           | —                                                                      | —                                    | —                                                        | **NO HOME** on `outbound_materials`                                         |
| **DR3 #**                           | —                                                                      | —                                    | —                                                        | **NO HOME** anywhere on the outbound leg                                    |
| Material #                          | `outbound_materials.ticket_number`                                     | `createOutbound`                     | form field "Ticket #"                                    | **MAPPED by convention only** — nothing enforces the `M-######` format here |
| whole units / program / non-program | `whole_units`, `program_units`, `non_program_units` (validated to sum) | same                                 | renovation-only fields                                   | **MAPPED**                                                                  |

Renovation is the only sub-category that feeds the running balance's `WholeUnitsSold` term; `baled`/`shredded` are weight-only and balance-neutral.

### 3.6 `Commodities` — outbound, 9 per-commodity tables, ~107/mo

Blocks: `trash_2`, `wood`, `metal`, `foam`, `toppers`, `cardboard`, `plastic`, `shoddy`, `cotton`. **`wood` and `foam` have no `Outbound Unit #` column**; the other seven do.

**The assigned question — absorbed reference data, or a real entry path? Answer: both legs exist, they never meet, and only one is human-driven.**

|                                     | Leg A — doc-ingest absorb                                                       | Leg B — manager entry              |
| ----------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| Tables                              | `doc_outbound_load_rows` (831 rows), `doc_outbound_commodity_rows` (1,699 rows) | `outbound_materials` (**0 rows**)  |
| Writer                              | `outbound-absorb.ts:190/194` (`createMany`, `status:'staged'`)                  | `outbound.ts:231` `createOutbound` |
| Trigger                             | machine sweep (`doc-ingest-sweep` cron + Graph webhook)                         | human click                        |
| Human role                          | confirm/discard a whole staged version (a **status flip**, not data entry)      | full field-level entry             |
| Promotes into `outbound_materials`? | **never**                                                                       | n/a                                |

`outbound-reconcile.ts:43` states it outright: _"READ-ONLY. This module opens no write path of any kind."_

**There is no iPad outbound entry surface.** Every `src/app/operator/**` route was enumerated — `count`, `dropoff`, `hauls`, `inbound`, `processed`, `today`, `queue`, `queue/conflicts`, `load/[id]`, `[userId]`. No outbound route exists. The handoff's "+ iPad outbound entry" premise is **false**; outbound entry is manager-desktop only.

| Column              | Home                                                                                                              | Capture path     | Surface                                                     | Verdict                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Date                | `outbound_materials.ship_date` / `doc_outbound_load_rows.shipment_date`                                           | both legs        | loads-inventory; `/admin/doc-ingest/outbound` (ratify only) | **MAPPED**                                                                                                  |
| Site                | both legs                                                                                                         | both             | both                                                        | **MAPPED**                                                                                                  |
| commodity           | `outbound_materials.commodity` (enum) / `doc_outbound_commodity_rows.commodity` (verbatim string)                 | both             | both                                                        | **MAPPED** — two unreconciled vocabularies                                                                  |
| sub category        | `outbound_materials.sub_category`                                                                                 | manager only     | form                                                        | **MAPPED**. Doc-ingest stores `disposition` verbatim instead and explicitly never maps it.                  |
| **Outbound Unit #** | —                                                                                                                 | —                | —                                                           | **NO HOME** — vestigial; used only as the header fingerprint distinguishing `commodities` from `renovation` |
| LBS                 | `outbound_materials.weight_lbs` / `doc_outbound_load_rows.total_weight_lbs`                                       | both             | both                                                        | **MAPPED**                                                                                                  |
| **BOL #**           | `doc_outbound_load_rows.bol_id` — **reference leg only**; no column on `outbound_materials`                       | absorb (machine) | none                                                        | **write-path-without-surface**, and **NO HOME** on the operational row                                      |
| **DR3 #**           | —                                                                                                                 | —                | —                                                           | **NO HOME.** `section-extractors.ts:342` documents the offset and then never reads it.                      |
| Material #          | `doc_outbound_load_rows.external_materials_id` (the ADR-0104 join key) **and** `outbound_materials.ticket_number` | absorb / manager | both                                                        | **MAPPED across two unlinked columns in two unlinked tables**                                               |

### 3.7 `Processed`

Real geometry (live): beginning balances (`Program 0 / NON 633`); per-day columns `DAILY TOTAL(INBOUND UNITS) · DAILY Program(STRIPPED) · Daily Non Program(Stripped) · PROGRAM(INBOUND) · NON-MRC(INBOUND) · Sold Units · Landfilled · M-number`; a parallel mid-month block; a `STRIPPED UNITS` column; and a `RUNNING INVENTORY TOTALS` block (`beginning balance · Total · Program · Non-program · inventory check (should be zero)`). August month-to-date row 40: inbound 14,290 · stripped program 11,317 · stripped non-program 1,901 · program inbound 12,135 · non-MRC inbound 2,155 · sold 30 · landfilled 5 · stripped 13,218. Closing: **818 program / 852 non-program units in inventory**.

| Column                                       | Home                                                                                      | Capture path                                                              | Surface                                                                                           | Verdict                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Beginning balances (program / non-program)   | `site_inventory_snapshots.program_units` / `.non_program_units` + `pool_attribution`      | iPad count, hold-release, `POST /api/manager/[site]/snapshots`, promotion | `/operator/[site]/count`, loads-inventory → Physical, `/admin/inventory/anchors`                  | **MAPPED**                                                                                       |
| DAILY Program / Daily Non Program (stripped) | `processed_units_daily.stripped_program` / `.stripped_non_program`                        | 4 writers (below)                                                         | `/dashboard/[site]/processed-units-close`, `/admin/processed-units`, `/operator/[site]/processed` | **MAPPED**                                                                                       |
| PROGRAM / NON-MRC inbound                    | `inbound_loads.program_unit_count` / `.non_program_unit_count`                            | verify-gate, bulk, bridge                                                 | `/operator/[site]/inbound`                                                                        | **MAPPED**                                                                                       |
| DAILY TOTAL inbound                          | derived from `inbound_loads`                                                              | —                                                                         | —                                                                                                 | derived                                                                                          |
| Sold Units                                   | derived from `outbound_materials` where `sub_category='renovation'` — never entered twice | `createOutbound`                                                          | shown at close for confirmation                                                                   | derived                                                                                          |
| Landfilled                                   | `landfilled_units.units` (+ pool split)                                                   | `landfilled.ts:86/134`                                                    | loads-inventory → Landfilled                                                                      | derived at close                                                                                 |
| M-number                                     | `processed_units_daily.material_ticket_number`                                            | resolved by **content**, not header (`section-extractors.ts:407-428`)     | processed-units surfaces                                                                          | **MAPPED**                                                                                       |
| `inventory check (should be zero)`           | —                                                                                         | —                                                                         | —                                                                                                 | **NO HOME** — the sheet's self-audit cell has no Vision equivalent. Worth reproducing; see G-11. |

**Running balance (ADR-0110).** One computation only: `computeRunningBalance` (`running-balance.ts:222`), DB-bound `onHand()` (`:357`). Formula: `End = Start(anchor) + Inbound + Drop-offs − Stripped − WholeUnitsSold − Landfilled`. `getEodInventorySnapshot` delegates both day balances to `onHand` — it does **not** recompute. Pinned by `eod-onhand-equivalence.test.ts` with unreachable sentinels and an assertion on `onHand`'s arguments.

**Banner condition** (`eod-inventory.ts:95`, `:242-243`) — `EodInventoryState = 'negative' | 'healthy' | 'stale' | 'zero'`:

```ts
const pools = [args.totalOnHand, args.programOnHand, args.nonProgramOnHand];
if (pools.some((v) => v !== undefined && v < 0)) return 'negative';
```

Three properties the EOD screen must preserve: negative is checked **before** freshness; **either pool** trips it, not just the total; and the figure is **replaced** by the banner, never shown beside it, with the days-remaining projection suppressed outright. Intake staleness is separate and additive (`inboundStale`, `:431`, > 96 h on `arrived_at`) and still renders the figure, flagged.

### 3.8 `Container Rentals` and `Fuel` — audited only, out of the daily flow

**Container Rentals.** Header (live): `Date · Location · ID · Trailers · Trailer Size · Rental Amount Due · Container Drop Off · Facility`. Home `container_rental_sites`; write paths `createRental`/`updateRental` (`admin-rates.ts:433`,`:487`), each wrapping write + audit in one `$transaction`; surface **`/admin/billing-rates/rentals`**. **Verdict: MAPPED.**

- **Premise correction:** the handoff says the `yard_list` admin surface is where these are edited. It is not. `yard_list` gates `/dashboard/[site]/yard`, which _reads_ rentals for context and writes only `yard_trailers` — stated at `src/lib/yard/service.ts:66-68`.
- ⛔ **`container_rental_sites` holds 0 rows in prod.** Seeded empty by design pending Rick settling the $10,800-vs-$10,500 discrepancy.
- ⚠️ **Hard-rule collision.** The live `Facility` column contains **`DR3 Stockton` on 15 of 41 rows** (plus `DR3 Woodland` 25 and a casing variant `Dr3 Woodland` 1). CLAUDE.md hard rule #1 forbids "Stockton" in any user-facing code, doc, UI string or seed data. Any surface that renders this tab verbatim would violate it. Filter to the current site and normalize casing.

**Fuel.** Header: `Begin Date · End Date · Price per Gallon` (weekly CA No 2 Diesel, PADD-5), 24 rows. Home `fuel_prices` with `enum FuelPriceSource { eia_api, manual }`, `week_of @unique @db.Date`. `eia_api` path: `runFuelFetchTick()`, cron Tue 06:00 America/Los_Angeles. `manual` path: `upsertManualFuelPrice()` → **`/admin/billing-rates/fuel-prices`**, `requireRateManager`. Manual wins — the cron skips rows whose `source = 'manual'`. **Verdict: MAPPED, with a real manual-entry surface.**

- ⛔ **`fuel_prices` holds 0 rows in prod.** The cron container restarted 2026-08-19 12:18 PDT and scheduled its next run for 2026-08-25 06:00 PDT, so nothing will land for six days. Until then every fuel-surcharge computation raises `MissingFuelPriceError`. The sheet's `Fuel` tab is currently the only place these prices exist.

### 3.9 Tabs the handoff did not list

Reading the live file surfaced four tabs absent from the Phase 0 scope:

- **`Events`** (17 rows) — `Date · Customer · County · Slip · Units · Freight · Driver Hours · Drivers Wages · Labor Hours · Labor Wages · Mileage Reimb · Per Diem · Misc. · ID# · Notes · Fuel`, plus the authoritative rate reference: stop charge per trailer by collection zone (0–25 mi $425 · 26–50 $600 · 51–100 $925 · 101–200 $1,450 · 201–300 $2,000 · 301–400 $2,500 · 401–500 $3,000), the fuel-surcharge formula, General Labor $90/person-hour, Driver $125/person-hour, Per Diem $275/person-night. **This tab feeds the Summary's `Event Misc` and `Event Trans` lines ($2,500 in August).** It is inside the billing flow and has no Phase 0 mapping. **G-12.**
- **`variables!Mileage_Table`** (61 rows) — `Account Name · Destination · Haul Rate · Mileage · Assignment · Re-Trac Random ID · Container Rental Rate · # of Containers Per Month · Storage Container Type`. This is the source for both `Mileage_Table.Assignment` (no home) and `sources.canonical_mileage` (home, never written). Also contains `DR3 Stockton` destinations.
- **`list`** (157 rows) — the picklists: 157 inbound sites, 97 no-trans sites, 16 non-program sites, 47 trans-charge sites, 10 outbound commodities (`trash, toppers, foam, metal, wood, cardboard, plastic, shoddy, cotton, whole units`), 4 sub-categories (`renovation, baled, shredded, whole units`), 5 inbound commodity labels, vendors.
- **`{Month}All`** — the de-duplicated consolidated month tables (see §1). The single best sizing reference and the natural comparand for a Vision rollup.

---

## 4. Flagged gaps, each with a proposed resolution

Ordered by whether they block Phase 1.

### Blocking — decide before building

| #       | Gap                                                                                                                                                                                                                            | Proposed resolution                                                                                                                                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-1** | **The sheet double-counts and its Summary totals inherit it (F-1).**                                                                                                                                                           | **Not a code change — a decision.** Bill/Kelsey verify July's actual transportation invoice against 112,150 vs 56,075. Then **withdraw the "rollup reproduces the Summary tabs" acceptance criterion** and replace it with "rollup = sum of the sections, computed once (ADR-0110); divergence from the sheet is a reported reconciliation line." |
| **G-2** | **`transport_charged` has no writer** ⛔ — so the freight/no-freight split, the single distinction between the two heaviest tabs, cannot be represented in Vision.                                                             | **New write affordance.** Set it at the verify gate from `sources.is_trans_charge`, and expose it as an editable checkbox on the EOD inbound add-line. Requires G-3 first.                                                                                                                                                                        |
| **G-3** | **`sources.is_trans_charge`, `sources.is_non_program` and `sources.canonical_mileage` are seed-only, with no admin surface at all.**                                                                                           | **New admin surface `/admin/sources`** — list + edit the three flags plus mileage. Small, and it unblocks G-2, the NP channel and the whole fuel-surcharge leg. Seed it from `variables!Mileage_Table` (61 rows) and the `list` tab (157 sites).                                                                                                  |
| **G-4** | **`inbound_loads` has no `commodity` column**, and the sheet's `commodity` cell is a channel label (`inbound units` / `Illegal Drop off` / `Unpaid Consumer Drop off` / `Incentive drop off` / `event units`), not a material. | **No new column.** Model it as the existing channel routing: `inbound units` → `inbound_loads`; the three drop-off labels → `consumer_dropoffs.kind`; `event units` → the Events channel (G-12). Record this explicitly so a future reader does not re-open it as a missing enum.                                                                 |
| **G-5** | **`workbook-promotion.ts` throws on any inbound promotion (F-5).**                                                                                                                                                             | **One-line fix:** delete `source: 'import' as const` from the `inboundLoad.createMany` payload at `workbook-promotion.ts:1172`; provenance already rides on `import_id` per ADR-0048. Then add a test with a **real** Prisma client — both existing promotion tests inject hand-rolled fakes, which is why this survived since 2026-07-06.        |
| **G-6** | **`Commodities` is ~107 rows/mo across 9 commodity blocks with two different column sets — not "8 rows, light".**                                                                                                              | **Resize Phase 1.** Outbound gets a real add-line: commodity select (10 values), sub-category select (4), weight, ticket #, and `Outbound Unit #` only for the seven blocks that have it. Do not build 9 separate panels — one add-line with a commodity selector reproduces all 9.                                                               |
| **G-7** | **`NonProgram` (12–18/mo) and unpaid drop-off (11–21/mo) are near-daily, not near-zero.**                                                                                                                                      | Keep them as add-lines, but **not collapsed by default** and **included in the gap-flag set**. Renovation (2–4/mo) and incentive (0–1/mo) stay collapsed.                                                                                                                                                                                         |

### Non-blocking, but must be recorded

| #        | Gap                                                                                                                                                                                                                                                                                                                                                                                 | Proposed resolution                                                                                                                                                                                                                                                                                                                                                     |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G-8**  | **`dr3_number`, `bol_number`, `external_mymrc_haul_id`, `retrac_id`, `slip_number` are 100% NULL in prod** ⛔ — five of the sheet's identifying columns. `dr3_number` has a write path (CA verify gate) that has never fired: the `document_sequences` counter still reads `next_value = 5000`, untouched since 2026-07-04, while the sheet is at DR3 # 4,755 and climbing ~11/day. | **New write affordance on the EOD inbound add-line** for BOL/Check #, DR3 # and Haul #. **And a sequencing decision for Bill:** Vision would start issuing DR3 numbers at 5000 while the sheet is at 4755 — they collide around late October. Either reseed the counter above the sheet's year-end ceiling, or have Vision take over numbering at a named cutover date. |
| **G-9**  | **`sources.canonical_mileage` never written; `Mileage_Table.Assignment` has NO HOME.** Together these make the fuel-surcharge and freight legs uncomputable.                                                                                                                                                                                                                        | Mileage: covered by G-3. Assignment: **new column** `sources.haul_assignment` (`primary`/`secondary`/`tertiary`) — the sheet has only these three values and `woodland-freight.ts` already pins to Primary as an admitted transitional hack.                                                                                                                            |
| **G-10** | **Three reference tables empty in prod (F-6):** `fuel_prices` 0, `container_rental_sites` 0, `account_haul_rates` 0. All three have homes, write paths and admin surfaces.                                                                                                                                                                                                          | **Data loading, not building.** Load `fuel_prices` from the sheet's `Fuel` tab (24 weekly rows) via `/admin/billing-rates/fuel-prices` before the next invoice run; `container_rental_sites` is blocked on Rick's $10,800/$10,500 answer; `account_haul_rates` from `variables!Mileage_Table`.                                                                          |
| **G-11** | **The sheet's `inventory check (should be zero)` cell has no Vision equivalent.**                                                                                                                                                                                                                                                                                                   | **Small, high-value addition:** show `total − (program + non_program)` on the EOD Processed section, expected zero, flagged when not. It is the sheet's own self-audit and costs one line.                                                                                                                                                                              |
| **G-12** | **The `Events` tab was never in Phase 0 scope**, yet it feeds the Summary's `Event Misc` and `Event Trans` lines and carries the authoritative stop-charge/labour/per-diem rate schedule.                                                                                                                                                                                           | **Scope decision for Bill.** Events are a distinct billing channel (collection events, driver/labour hours, per diem). Recommend a **Phase 3** — do not bolt it onto the EOD screen. Until then the workbook cannot go fully dark.                                                                                                                                      |
| **G-13** | **`outbound_vendors` and `recycling_rates` are seed-only with no admin surface**, and `createRecyclingRate` (`recycling-rates.ts:291`) is an orphan function with zero callers. The outbound form's recycler picker is fed from `outbound_vendors`; the ADR-0055 recycled/landfilled split resolves against `recycling_rates`.                                                      | **New admin surface** for both, or at minimum a seed. Otherwise a manager opening the outbound add-line gets an empty recycler dropdown and a NULL stewardship split — degraded, and silently. (`OPEN-ITEMS.md:1111` / S-7 already records `recycling_rates` as empty in prod.)                                                                                         |
| **G-14** | **`Container Rentals` contains `DR3 Stockton` on 15/41 rows** — a CLAUDE.md hard-rule-#1 collision for any surface rendering it.                                                                                                                                                                                                                                                    | Filter to the viewing site; normalize `Dr3 Woodland` → `DR3 Woodland`. Never render the sheet's `Facility` column verbatim.                                                                                                                                                                                                                                             |
| **G-15** | **Vision holds 113 inbound rows for Aug 1–19; the sheet holds 144.**                                                                                                                                                                                                                                                                                                                | **Reconciliation task, out of h276 scope but named here.** Neither number can be trusted as the month rollup's basis until the 31-row delta is explained.                                                                                                                                                                                                               |

### Defects found in passing (not parity gaps, but they touch the build)

| #       | Defect                                                                                                                                                                                                                                                                               | Note                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **D-1** | Outbound `bolNumber` is captured into staging (`section-extractors.ts:370`) then **dropped at promotion** (`workbook-promotion.ts:604-615`) — the `inbound` case reads it, the `outbound` case does not.                                                                             | Matters if the EOD screen reuses the importer.        |
| **D-2** | DAY-grid outbound promotion **hardcodes `subCategory: 'baled'`** (`section-extractors.ts:365`). Any renovation arriving that way is imported as baled and silently drops out of the unit close.                                                                                      | Same.                                                 |
| **D-3** | `processed_units_daily` has **four** write sites, not three — the fourth is `workbook-promotion.ts:1137` (`createMany`, no `skipDuplicates`, no precedence pre-check; raises P2002 and rolls back — loud, which is defensible).                                                      | See §5.                                               |
| **D-4** | `CHANGELOG.md:820` still asserts in the present tense that _"`processed_units_daily` keeps its one writer (workbook-sync, ADR-0049)"_ — directly contradicting `src/lib/bonus/saves-inventory.ts:34`.                                                                                | Correct it before the EOD build reads it as guidance. |
| **D-5** | `upsertProcessedUnits` leaves `source` unchanged on update (`OPEN-ITEMS.md:1005`), so a human edit to a MyMRC-created day is silently overwritten by the next bridge run.                                                                                                            | **Any EOD gap-fill write inherits this.**             |
| **D-6** | `haul-number.ts:15-16` and ADR-0090:64-65 both claim the MyMRC bridge stamps `inbound_loads.external_mymrc_haul_id`. The live `UPSERT_SQL` (`inbound-bridge.ts:238-256`) inserts no such column — its rows are per-(site, day) aggregates. `haulNumberOf()`'s second branch is dead. | Documentation drift, not a functional break.          |
| **D-7** | `retracId` and `buyer` are accepted by the outbound zod schema and `createOutbound` but the UI never sends either.                                                                                                                                                                   | Dead parameters.                                      |

---

## 5. F-5 in full — the promotion bug, proven

**The call** (`src/lib/audit/workbook-promotion.ts:1155-1179`):

```ts
await tx.inboundLoad.createMany({
  data: candidates.inbound.map((i) => ({
    site_id: scope.siteId,
    source_id: i.sourceId,
    ...
    source: 'import' as const,
    import_id: pid,
  })),
});
```

**No `source` field exists on the model.** `InboundLoad.source` is the `Source?` _relation_ (the collection site), not a `RecordSource` enum. Confirmed against the generated `InboundLoadCreateManyInput` — 44 fields, no `source`. Every sibling in the same transaction _does_ have one (`ProcessedUnitsDaily`, `OutboundMaterial`, `LandfilledUnit`, `ConsumerDropoff`). **ADR-0048 says so explicitly** (`:86-92`): _"`inbound_loads` has no `RecordSource` column… inbound promotion provenance rides on the new `import_id` column alone."_ The code contradicts its own ADR.

**TypeScript does not catch it.** `npx tsc --noEmit` exits 0 with zero output, twice (once with `--incremental false` to defeat the build cache). The file is in scope. The suppression is Prisma's signature: `SelectSubset` maps only the top-level keys (`data`, `skipDuplicates`) and lets `T['data']` through, so excess-property freshness is gone before the nested check happens.

**Runtime: it throws.** Verified empirically on an isolated scratch DB:

```
PROBE THREW -> PrismaClientValidationError: Invalid `prisma.inboundLoad.createMany()` invocation:
  ... Unknown argument `source`. Did you mean `source_id`? Available options are marked with ?.
rows landed: []
```

The control call (identical payload minus `source`) failed _later_, on a foreign-key constraint — proving the `source` failure occurs at **argument validation**, strictly before the query is sent. So it is **not** silently discarded: it aborts the enclosing `$transaction`, and no inbound, outbound or processed row lands.

**Prod corroboration:** `import_id` is NULL on **all 743** `inbound_loads` rows — the inbound promotion path has never landed a row.

**Why it survived:** both promotion tests (`workbook-promotion.test.ts:105,134`; `workbook-promotion.source-link.test.ts:130,146`) inject hand-rolled fake Prisma clients, so the real client has never validated this call in CI. Introduced `87a605be`, 2026-07-06, PR #77.

---

## 6. Conventions brief for the Phase 1 builder

**Route.** `src/app/dashboard/[site]/eod/page.tsx` + `src/app/api/manager/[site]/eod/route.ts`. There is **no `src/app/manager/` directory** — `manager` is an API namespace only. 20 of 24 dashboard pages are under `[site]`. Nearest precedent: `dashboard/[site]/processed-units-close/page.tsx`. Next 15 async params:

```ts
type Props = { params: Promise<{ site: string }> };
export default async function EodPage({ params }: Props) {
  const { site: siteCode } = await params;
```

plus `export const dynamic = 'force-dynamic';`.

**Auth.** `requireManagerForSite` (`src/lib/auth-helpers.ts:45`) **throws a `Response`** (401/403/404) — right for API routes. **On a page use `checkManagerForSite`** (`:88`), which returns `{ ok } | { ok:false; status }`; 13 of 20 `[site]` pages do. Site reach, verbatim (`:61-69`):

```ts
if (
  role === 'manager' &&
  session.user.primary_site_id !== site.id &&
  session.user.all_sites !== true
) {
  throw new Response('forbidden', { status: 403 });
}
```

Admin _powers_ stay `role === 'admin'` only (`:210`) — `all_sites` never unlocks `/admin/*`. Do not copy `dashboard/[site]/page.tsx:51-53`, which re-implements the reach check inline.

**Rollout gate (CLAUDE.md #12 / ADR-0047).** A new manager-visible surface must be born `pilot`: add a code to `UI_SURFACE` (`src/lib/notify/rollout.ts:66-131`), insert a `rollout_surfaces` row, gate with `isUiSurfaceLive(UI_SURFACE.X, siteId)`. Precedent: `processed-units-close/page.tsx:13,40-49`. Staff mail only via `notifyStaff()`.

**i18n — English-first is correct here.** `LOCALES = ['en','es','ur']`, JSON dictionaries per locale in `operator.json` / `manager.json`, parity CI-enforced by `src/i18n/locale-parity.test.ts`. But only **4 of 24** dashboard pages import `@/i18n`, versus every operator surface. The office-desktop exception is documented: ADR-0017:117-118 ("the admin surface stays English-only for v1, matching the manager portal's current state"), and in-file declarations on `[site]/equipment`, `[site]/invoices`, `[site]/cor`, `[site]/audit`, `[site]/ops`. **Ship English-first**, but put strings in a `messages.ts` table (precedent `src/app/admin/messages.ts`) for cheap conversion. Anything that will ever render on the iPad must go into all three locale JSONs or the parity test fails.

**`onClick` not `<form>`.** Source is **CLAUDE.md hard rule #10 only** — no ADR of its own, no lint rule (`eslint.config.mjs` is 24 lines, `next/core-web-vitals` + `next/typescript`, no custom rules). Enforcement is one hand-written test (`MrcScrapeForm.test.tsx:69-71`). The rule **is** held: exactly 3 real `<form>` elements exist in `src/`, all under `/bonus`, **zero** under `/dashboard` or `/operator`.

**Pacific day.** Everything lives in `src/lib/time.ts`. Two kinds, never mixed:

- **Calendar-day column** (`@db.Date`, e.g. `production_date`) → key with `appToday()` / `dayKeyUTCFromISO()`; render with `pacificDateLabel()` / `dayISO()` **in UTC**. Do not re-shift a stored `@db.Date` through Pacific or it moves back a day (`time.ts:29-32`).
- **Instant column** (`created_at`, `closed_at`) → bound with `currentPacificDayWindow(now)` → `{ start, endExclusive }`. `time.ts:229-230`: _"Do NOT introduce a second day-key definition."_

Also: `monthStartOfDayKey` / `appCurrentMonthStart` for the month rollup; `pacificDayStartInstantPlus` for DST-correct ±N days. **"Today" is not site-parameterised** — both sites are Pacific. Two existing divergences, do not copy: `[site]/compliance/page.tsx:95-105` hand-rolls `startOfUtcDay` (UTC midnight, off by 7–8 h), and `[site]/reconciliation/page.tsx:93` renders an instant's UTC day.

**`processed_units_daily` precedence — the rule, verbatim** (`src/lib/bonus/saves-inventory.ts:34-37`, echoed in ADR-0083:105):

> "That table has THREE writers under a precedence rule (`source='mymrc' AND closed_at IS NULL` wins)."

Enforced in `UPSERT_SQL` (`src/lib/mymrc/processed-bridge.ts:132-147`) via the `ON CONFLICT … WHERE` guard. The writers: (1) `processed-units.ts:196/263` daily close, `source='manual'`; (2) `processed-bridge.ts:132`, `source='mymrc'`, cron; (3) `workbook-sync/upsert.ts:155/182`, `source='import'`; **(4) — undocumented — `workbook-promotion.ts:1137`, `source='import'`, from `/admin/audit/workbook/[importId]`.** Any EOD write must respect the precedence, never assume a lock, and must contend with D-5.

**Migration for `eod_day_close`.** Dir `prisma/migrations/YYYYMMDD_adrNNNN_snake_slug/migration.sql` — the `DD` field is a **monotonic lexical counter, not a calendar day** (August runs `20260801…` → `20260850…`, passing 31). **Your next dir is `20260851_adr0NNN_eod_day_close`.** Lexical order is load-bearing (ADR-0035; CI replays the whole set against an empty PG16). Style: comment block first, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`, a `CHECK` at the table even when the service validates, and `COMMENT ON COLUMN … 'ADR-NNNN — …'`. Model on `20260849_adr0107_equipment_start_end_hours/migration.sql`.

**Enums, not string unions** — 82 `enum` blocks in the schema. Declare `enum EodCloseOutcome { clean exception }`. Table shape: copy `ProcessedUnitsDaily` (`schema.prisma:2757-2797`) — uuid PK, snake_case columns, `@@map`, `DateTime @db.Date` for the day, `@@unique([site_id, close_date])`, actor columns as bare `String?` user ids with **no FK** (precedent stated at `schema.prisma:1216-1218`).

**Audit + reason.** `writeAudit(args, { tx })` (`src/lib/audit.ts:32`) — always pass `tx` so the state flip and its audit row commit or roll back together. `AuditAction` is a 5-member enum (`insert|update|delete|soft_delete|restore`) and ADR-0017:124-127 says **do not extend it** — new semantics reuse `update` and are distinguished by the `before`/`after` JSON. The reason pattern (ADR-0106 D3, implemented `equipment/daily-throughput.ts:88,487-505`): a backdated write without a reason is refused **422 and nothing is written** — no row, and no audit row claiming one; minimum 4 chars; the reason goes on the **audit** row (`prior_day: true`, `prior_day_reason`), and a same-day write's audit payload gains **no extra keys**. For `eod_day_close`: `exception_note` on the row (it describes the day); `reopened_by/at/reason` on the row **and** in a `writeAudit({action:'update', …}, {tx})`.

**Tests.** Vitest 2.1.2, `globals: false` (import `describe/it/expect` explicitly), colocated `*.test.ts(x)` or `__tests__/`; jsdom via a `// @vitest-environment jsdom` pragma. **Playwright has zero tests** — no config, no specs; `playwright` is a runtime dep for MyMRC scraping, and CI never runs it. CLAUDE.md's "`npx playwright test` green" is satisfiable only vacuously. Write Vitest.

---

## 7. Verdict on the Phase 0 question

**Can the workbook be retired safely today? No — but the gaps are enumerable and mostly small.**

- **Fully mapped, safe to retire now:** `Processed`, `Renovation`, the `Fuel` and `Container Rentals` reference tabs (subject to loading their empty tables), and the mapped subset of `Commodities`.
- **Mapped but with no human write path for the sheet's identifiers:** both inbound tabs — five identifier columns and the entire freight/mileage/surcharge block. G-2, G-3, G-8, G-9 close this.
- **Genuinely unmapped:** `Mileage_Table.Assignment`, `Outbound Unit #` (vestigial, safe to drop), outbound `BOL #` and `DR3 #`, the mid-month billing block, the `inventory check` cell, and the whole `Events` channel.
- **Newly discovered risk that outranks the parity question:** the sheet's own totals double-count (F-1), Vision and the sheet disagree by 31 inbound rows (G-15), and the promotion path throws (F-5).

**Recommended gate before Phase 1 starts:** answer G-1 (the invoice check), fix G-5 (one line), and decide G-3 (the `/admin/sources` surface, which unblocks four other gaps). Everything else can proceed in parallel with the build.
