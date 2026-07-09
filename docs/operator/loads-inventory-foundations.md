# Loads & Inventory Foundations (ADR-0037) — operator/office guide

_Last updated: 2026-07-03. Audience: office staff, managers, super-admin (Bill).
These are **desktop office/manager surfaces**, not operator iPad surfaces — the
iPad inbound flow is untouched by this work._

This is the P1 groundwork that takes the loads / inventory / commodity layer from
built-but-dormant to production, CA-first. Every rate and program rule is **data**
(`state_program_rules`), never code. Every record carries a business date +
provenance so the P1 retro-audit (ADR-0039) can run over any historical window.

## Activation gate (read this first)

Per ADR-0037 **D7**, the schema and these surfaces merge, but the manager
loads/inventory surfaces are **admin-only for now**. A plain site manager will see
a "Not yet activated" screen until the two Bill-owned ops gates close:

- one recorded restore drill (P1-3), and
- `RESTIC_PASSWORD` confirmed off-box (P1-4).

Flip the gate in one place — `assertLoadsInventoryActivated` in
`src/lib/loads/record-guards.ts` (change the role check) — once those close. The
super-admin **Processed Units** surface is not affected by this gate (it is
already super-admin-only).

## The surfaces

### 1. Processed Units — daily close (super-admin, office desktop)

Route: **/admin/processed-units** · Dashboard tile: **Processed Units** ·
Visible to: **super-admin only** (Bill).

This is **the number billing bills from** (ADR-0037 D5). One row per site per day.
This is the **daily close** (Addendum B4).

- Enter **stripped — program** and **stripped — non-program** units. The total is
  shown derived — never a separate input.
- The **stripped program split is the billing basis**: MRC is billed on program
  units only. Example (Rick Albritton, survey Q11): a 175-unit day with 150 program
  units on the floor is reported to MyMRC as "150 Program + 25 non-program" and MRC
  is **billed only the 150**.
- Also captured at close: **saved units** (recorded but **excluded** from all
  inventory math — its meaning is still open, Addendum B10-2), **material ticket #**,
  **# employees**, **# processors**, and the **pocketcoil estimate**.
- **Whole units sold** and **landfilled** for the day are shown **derived** (from
  the day's renovation outbound rows + landfilled-unit rows) for confirmation — you
  never type them here.
- **Close a day** to lock it (writes an audit row). After close, edits are
  **blocked** — corrections follow the amendment path (ADR-0028 style), never an
  in-place edit.

This is **distinct** from two things it is often confused with:

- the **iPad operator inbound flow** (untouched), and
- the **per-processor bonus daily entries** (`bonus_daily_entries`, which drive
  payroll). Processed-units is a **site-level billing** record; it does not touch
  payroll.

### 2. Loads & Inventory — manager CRUD-lite (admin-only for now)

Route: **/dashboard/&lt;site&gt;/loads-inventory** · Dashboard tile:
**Loads & Inventory** · Visible to: **admin only** (D7 gate).

Three record types, each with create + list + edit-before-lock, all site-scoped:

- **Consumer drop-offs** (workbook Paid-Unpaid tab; CA CIP). Each drop-off has a
  **kind**: only **incentive** drop-offs compute an incentive
  (`units × collector_incentive`, capped at the daily cap per person per day —
  currently 5 units/person/day for CA); **unpaid** and **illegal** drop-offs carry
  no incentive.
  - ⚠ **PII:** the drop-off "dropped off by" name is MRC Personal Data (charter
    Exhibit I / ADR-0010). It appears on this access-controlled manager surface,
    but it is **never** included in any CSV/export.
- **Outbound materials** — two axes: **commodity** (the daily-log 9: trash, toppers,
  foam, metal, wood, cardboard, plastic, shoddy, cotton) × **sub-category**
  (renovation / baled / shredded).
  - **Renovation** = a whole-unit sale (the old renovator channel). Enter whole
    units + a program / non-program split (they must equal whole units). Renovation
    units come out of inventory (they subtract from the running balance) and can
    never be billed as processed.
  - **Baled / shredded** = weight-based commodity sales. Enter weight (+ optional
    bale count → avg-per-bale is shown derived). These **never subtract units**.
- **Landfilled units** (whole-unit disposal; reason bed-bug / soiled /
  water-logged / other). Program + non-program must equal units.

At the top of the page is the **running balance** (ADR-0037 D6): program /
non-program / total on hand. It is one shared computation (Addendum B4):

```
End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled

on hand = latest physical count
        + verified inbound loads + consumer drop-offs
        − stripped (processed) − renovation whole units sold − landfilled units
```

…all since the latest physical count. **Baled / shredded commodities never subtract
units** — they are post-deconstruction material, and deconstruction is what
`stripped` already counts. `Saved` units are captured but excluded. A physical count
becomes the new anchor and records the delta vs. the computed balance (never
silently absorbed).

### 3. Inbound verify gate (program / non-program split)

The manager verify step now enforces, server-side, that
`program + non-program == total_units` before an inbound load can reach
`verified`. This split doubles as the MRC segregation documentation for
co-processed volume (Woodland post-Stockton). Route:
`POST /api/manager/<site>/loads/<id>/verify`.

**Site-driven default (Addendum B7):** program-ness is a property of the collection
**site**, not the commodity. If the manager verifies without supplying a split, the
default comes from the load's source: a **non-program source** puts all units in the
non-program pool; a program source puts all in program. The manager can always
override by entering an explicit split (which must still sum to the total). Sources
carry `is_non_program` / `is_trans_charge` / a canonical mileage, and a
`source_aliases` table resolves the workbook's heavy spelling drift so historical
data can be joined.

> **Note (ADR-0037 finding 1a):** before this work there was no verify action at
> all — the `submitted → verified` transition existed only in a state table with
> no implementation. This build is that action + its enforcement.

## Rates & rules are data (`state_program_rules`)

Seeded rules (resolved by `src/lib/program-rules/resolver.ts`):

| Site | Rule | Value |
|---|---|---|
| Woodland (CA) | processing_rate | $16.00 (2025) → $16.50 (2026) → $17.00 (2027) / unit (effective-dated) |
| Eugene (OR) | processing_rate | $17.00 / unit |
| Eugene (OR) | satellite_collection_rate | $2.25 / unit |
| Woodland (CA) | collector_incentive | $3.00 / unit, cap 5 units/person/day |
| Woodland (CA) | fuel_surcharge | formula-driven, trigger $5.05/gal (see below) |
| Woodland (CA) | driver_hourly | $125.00 / hr |
| Woodland (CA) | general_labor_hourly | $90.00 / hr |
| Woodland (CA) | per_diem_nightly | $275.00 / night |
| Both | unit_weight_estimate | 55 lbs / unit — **estimate only** (MRC reporting uses actual scale weights) |

**OR fuel surcharge is structurally impossible.** No `fuel_surcharge` rule is ever
seeded for Eugene, **and** the resolver throws if asked for one against an
Oregon-jurisdiction site — two independent layers, so a future seeding mistake
still can't silently bill it.

**CA fuel surcharge** formula is captured (Rick Albritton, survey Q6; Addendum B3):
`(EIA West Coast PADD-5 diesel rate ÷ 6.5 mpg) × miles driven`, applied when CA
diesel exceeds the **$5.05/gal** trigger. But **computation is refused** in P1 — the
per-haul EIA rate lookup + miles input is P2 billing scope. The resolver returns the
rule; asking it to compute a fuel amount throws a typed error. Raw values can still
be entered.

## What is NOT in this build

MyMRC ingestion (ADR-0038) · the 3-way audit + retro-audit engine and historical
workbook import (ADR-0039) · invoice/Summary generation, container rentals, COR
generator, Great Plains export (P2) · rate/recovery alerts (P3). See ADR-0037
"Out of scope" for the full sequence.

**Deliberately still open (Addendum B10):** the daily-log-9 commodity → billing-
workbook-11 block mapping (trash → Landfill vs WTE is destination-driven; B10-5) ·
the `saved` units semantics (B10-2) · DR3# / Material # sequence issuance (B10-6) ·
CA fuel-surcharge computation (P2). These are captured as data / structure but no
logic computes from them yet.

## Physical inventory count — program / non-program pool split (ADR-0037 §3, rollup §1.4)

When you record a physical inventory count, enter the **program** and
**non-program** unit pools separately (MRC is billed on program units only). The
entry surface shows a live running total: the two pools must add up to the physical
count total, or the save is refused with a plain-language message. A count entered
with the split is stored as `pool_attribution = 'measured'`.

- Rows counted before this change are marked `'legacy'` (all units attributed to the
  program pool). They still work — the running balance falls back to legacy
  attribution for a legacy anchor — but clean, billed-accurate pool data starts once
  counters enter both fields.
- The running balance uses the measured split as its anchor whenever the latest
  physical count is `'measured'`; otherwise it uses legacy attribution. Either way
  `program + non-program = total`.

