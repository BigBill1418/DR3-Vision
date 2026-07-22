# Loads & Inventory Foundations (ADR-0037) — operator/office guide

_Last updated: 2026-07-22. Audience: office staff, managers, super-admin (Bill).
These are **desktop office/manager surfaces**, not operator iPad surfaces — the
iPad inbound flow is untouched by this work._

This is the P1 groundwork that takes the loads / inventory / commodity layer from
built-but-dormant to production, CA-first. Every rate and program rule is **data**
(`state_program_rules`), never code. Every record carries a business date +
provenance so the P1 retro-audit (ADR-0039) can run over any historical window.

## Activation gate (read this first)

Per ADR-0037 **D7**, the manager loads/inventory surfaces are gated by the ADR-0047
per-site `loads_inventory` rollout surface. **It went `live` for both Woodland and
Eugene on 2026-07-22**, so managers and operators at both sites can use these pages
today. Admins always pass the gate; a site whose surface is `pilot`/unregistered sees
a "Not yet activated" screen.

The flip is **data**, not code: an admin flips it at `/admin/rollout` (audited,
reversible, no deploy). Do NOT edit `assertLoadsInventoryActivated` in
`src/lib/loads/record-guards.ts` to change exposure — it reads that surface. The
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

### 2. Loads & Inventory — manager CRUD-lite

Route: **/dashboard/&lt;site&gt;/loads-inventory** · Dashboard tile:
**Loads & Inventory** · Visible to: **site managers + admins** (D7 gate, live at both
sites since 2026-07-22).

Three record types, each with create + list + edit-before-lock, all site-scoped
(plus the paper-bootstrap **Bulk daily inbound** tab — see the paper workflow below):

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


---

## The paper daily workflow (pre-iPad bootstrap) — ADR-0037 Phase 3

Woodland and Eugene run the floor on **paper daily logs**. There are no operator
iPads on the dock yet, so nothing writes per-load inbound records. Phase 3 makes the
whole Loads & Inventory surface operable from those paper logs — a manager types the
day's aggregates, and the running balance stays arithmetically honest.

### The six input streams, and who enters what

| # | Stream | Where | Who |
|---|---|---|---|
| 1 | Physical count (program / non-program split) | Loads & Inventory → **Physical count** | Site manager |
| 2 | Consumer drop-offs (incentive / unpaid / illegal) | Loads & Inventory → **Consumer drop-offs** | Site manager |
| 3 | Outbound materials (renovation whole units; baled / shredded weight) | Loads & Inventory → **Outbound materials** | Site manager |
| 4 | Landfilled units (bed-bug / soiled / water-logged / other) | Loads & Inventory → **Landfilled units** | Site manager |
| 5 | Inbound loads | Loads & Inventory → **Bulk daily inbound** (paper) *or* the iPad dock flow (later) | Site manager (paper) / operator + manager verify (iPad) |
| 6 | Daily close — processed (stripped) units | **/dashboard/&lt;site&gt;/processed-units-close** to enter/amend · **/admin/processed-units** to close + lock | Manager enters · **Bill closes** |

### 5. Bulk daily inbound — the paper substitute for per-load capture

Route: Loads & Inventory → **Bulk daily inbound** tab.

Enter the day's inbound as **one aggregate row per site per day**: total units plus
the **program / non-program split** (they must sum to the total — the server refuses
otherwise, because the program pool is what MRC is billed on). Optionally record the
paper daily-log slip / page number.

- The row is written with `load_source_type = 'paper_bulk'` and `count_mode = 'total'`.
  That provenance tag is permanent and visible in the list — a paper aggregate is
  never mistaken for a verified dock capture (no BOL, no photos, no transporter, no
  unload timings).
- It counts toward the running balance exactly like a verified inbound load, because
  the same program/non-program invariant the dock verify gate enforces is enforced
  here before the write.
- **Re-entering a date amends that day** — it never stacks a second row. Fix a
  miscount by typing the day again.
- When the iPads come online, simply stop entering bulk days: per-load rows take over,
  the historical `paper_bulk` rows stay queryable as-is, and no data migration is
  needed. Never enter both for the same day — that would double-count the inflow.

### 6. Daily close — managers enter, Bill closes (§3.3 Option B)

Route (manager): **/dashboard/&lt;site&gt;/processed-units-close** — linked from the top
of Loads & Inventory.
Route (Bill): **/admin/processed-units** — unchanged, super-admin only.

- The **manager enters** the day's stripped units (program / non-program), saved units,
  material ticket #, headcount, and pocketcoil estimate — and may **amend the day as
  many times as needed** while it is open.
- **Only Bill closes and locks a day.** There is no close control on the manager page
  and no manager close API — closing exists in exactly one super-admin-gated place.
  After close, every write to that day is refused (`409 closed`) and corrections
  follow the amendment path, never an in-place edit.
- Whole units sold + landfilled are **derived** from the day's renovation-outbound and
  landfilled rows on both surfaces — never typed twice.

### A manager's day, on paper

1. **Morning** — count the floor and enter a **physical count** (program + non-program).
   That becomes the anchor the balance runs from.
2. **Through the day** — enter events as they happen: drop-offs, outbound, landfilled.
3. **End of day** — enter **Bulk daily inbound** (the day's total in, split
   program / non-program) and the **daily close** (stripped units) on the
   processed-units-close page.
4. **Check** — the three tiles at the top of Loads & Inventory should track the paper
   log. A drift means an input stream was missed; the next physical count records the
   delta rather than silently absorbing it.
5. **Bill** — reviews and **closes** the day at `/admin/processed-units`.

### Ongoing capture model — pick ONE (§3.1, operator decision pending)

Both patterns are supported by the same surfaces; the difference is operational
discipline, not code. Bill picks one and it becomes the standing instruction to
Morena, Janette and Rick.

**Option A — anchor-daily.** A physical count every morning, before the shift starts.

- The balance restarts from a known-good number every day, so drift can never
  accumulate past 24 hours.
- Inbound accuracy matters less — a missed bulk-inbound entry shows up as that day's
  reconciled delta and is corrected the next morning.
- Costs one count per site per morning, every day, forever.
- **Recommended for the first month** while the capture habit is forming.

**Option B — backfill-and-run.** A physical count as a periodic anchor (weekly, or
monthly), with the balance running on inbound + outbound arithmetic in between.

- Far less counting labor.
- Requires that **every** stream be entered every day — especially bulk daily inbound.
  One missed day silently biases the balance until the next anchor.
- Drift is discovered late (at the next count) and is harder to attribute to a day.
- **Move here once the numbers hold up** against verified in/out for a full month —
  weekly anchor first, monthly only if weekly proves boring.

Whichever is picked: a physical count **always** records `reconciled_delta`
(physical − computed). The drift is written down, never absorbed.
