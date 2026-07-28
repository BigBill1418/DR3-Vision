# ADR-0062: Equipment master seed from the SVdP machine list, and its site mapping

**Date:** 2026-07-28
**Status:** Accepted
**Supplements:** ADR-0046 Amendment 5 (AP equipment linking), ADR-0017 (admin surfaces)

## Context

`equipment` is the option set behind the AP Approve panel's equipment
multi-select (ADR-0046 Amendment 5 / D-M5-6). In production it was **empty**.
Every one of the 12 `ap_equipment_links` rows written since AP go-live is
`is_not_equipment_related = true` — not because approvers judged the invoices
non-equipment, but because the picker offered **nothing to pick**.

The registry is described throughout the AP code as "admin-managed", and
`src/app/api/ops/ap/equipment/route.ts` is deliberately read-only because
"creation is admin-only". But no admin create surface was ever built: the only
route under `/api/admin/equipment` is the Terex _history_ importer
(`equipment_events`, ADR-0048 D3), which is a different table. So there was no
path — UI or API — to populate the master at all.

On 2026-07-28 Bill dropped `DR3 Machine List (2).xlsx` on `/admin/file-drop`
(file-drop `580024f8`, sha256 `4ffff995…`): the SVdP-wide fleet register,
**554 assets across 35 locations**, columns
`Unit # | Make | Vin/Serial | Location/Department | Type | Status | Ownership | Notes`.

## The problem this ADR resolves

The workbook is **SVdP parent-org wide**, but `equipment.site_id` is an FK to
`sites`, and only two site rows exist (`eugene`, `woodland`). The workbook's
location breakdown:

| Location group                                                            | Rows      |
| ------------------------------------------------------------------------- | --------- |
| OTR (unqualified over-the-road fleet)                                     | 190       |
| OTR California                                                            | 89        |
| Cleveland Warehouse (Eugene, OR)                                          | 71        |
| _(blank)_                                                                 | 36        |
| Seasonal Storage                                                          | 21        |
| **DR3 Woodland**                                                          | **21**    |
| DR3 Livermore                                                             | 16        |
| Car Lot / DR3 Stockton                                                    | 15 each   |
| General Stores / Maintenance / Egan / Lindholm / retail stores / programs | remainder |

Two facts drove the decision:

1. Only **21 rows** are tagged `DR3 Woodland`.
2. **No row is tagged `DR3 Eugene`.** The Eugene-Oregon entries are all SVdP
   parent-org sites (Cleveland Warehouse, Car Lot, Seneca, Chad Dr programs,
   retail stores). Cleveland Warehouse has its own shear machine (`EQ65`), which
   _hints_ it might be the DR3 Eugene operation, but nothing in the workbook or
   the repo confirms it.

Loading only the 21 unambiguous Woodland rows would leave Eugene's picker empty
and the AP problem half-solved. Guessing that Cleveland Warehouse _is_ DR3
Eugene would push 71 possibly-non-DR3 assets into a DR3 site's approval books.

## Decision

**Load all 554 rows, mapped by jurisdiction** — the axis the charter already
uses to separate the two sites (Eugene = Oregon / DEQ / SB 1576; Woodland =
California / CalRecycle):

```
California            → woodland   (DR3 Woodland, DR3 Livermore, DR3 Stockton, OTR California)
everything else       → eugene     (Oregon SVdP facilities, unqualified OTR fleet, blank locations)
```

Result: **eugene 413, woodland 141**.

This is operator-directed. Bill's instruction (2026-07-28): _"you can load all of
this in for all sites — just no better way for now."_ It is explicitly a coarse
mapping, **not** a claim that Cleveland Warehouse is DR3 Eugene. It makes the
whole fleet selectable at approval time, which is strictly better than an empty
picker, and it is cheap to refine when a real DR3-Eugene asset list arrives.

### Stockton and hard rule #1

15 rows sit at the Stockton facility. CLAUDE.md hard rule #1 forbids the string
"Stockton" in user-facing code, docs, UI strings, **or seed data**.

The `equipment` model stores only `display_name`, `category`, `site_id`,
`is_active` — **there is no location column**. Those assets therefore load
without the word "Stockton" entering any stored or rendered string; their unit
numbers (`EQ43`, etc.) carry no site identity. No location text from the
workbook is persisted for any row. The rule is satisfied by construction rather
than by dropping the assets.

### Normalization rules

- **`display_name`** = `"<Unit #> — <Make> <Type>"`, falling back to the bare
  unit number. Collisions within a site get a `(#n)` suffix (5 unit numbers
  repeat across the workbook).
- **`category`** (`vehicle|forklift|baler|terex|other`) from Type/Notes/Make.
  Shear machines map to **`terex`** — that is the category the `equipment_events`
  log already uses for the Woodland shear (`EQ74`). "Sheer" is a recurring
  workbook misspelling and is matched too.
- **91 rows have a blank Type.** Rather than dumping all of them into `other`,
  the make is used as the class signal (Great Dane / Fruehauf / Strick /
  Wabash = trailers; Freightliner / Volvo = tractors; Ford / Toyota = light
  vehicles), and `F##` unit numbers resolve to `forklift` (cf. Woodland
  F60/F61/F62). **29 rows** with neither Type, Make, Notes nor a recognisable
  unit convention stay `other` — an honest "unknown", not a guess.
- **`is_active = false`** for Scrapped / To Be Scrapped / Sold / Inactive /
  Out of Service / Transferred to Car Lot for Sale (**33 rows**). They stay in
  the registry so historical AP links can resolve, but `listSiteEquipment`
  filters them out of the approver's picker. "Pending Inspection" stays active.
- **Ownership** (Owned / Leased / Rented) has no column in the model and is
  **not** persisted. It is a maintenance attribute, not an approval-time one.

### Mechanism

`scripts/seed-equipment-master.mjs` — one-shot, idempotent, audited.
Idempotency is keyed on `(site_id, display_name)`: a re-run updates
`category`/`is_active` in place when they drift, inserts only genuinely new
rows, and never duplicates or hard-deletes. Every insert and update writes an
`audit_log` row (hard rule #6) with `actor_label='system:equipment-seed'` and
the source sha256 in the `after` payload.

The script splits parse from write (`--emit-json` / `--json`) because the
deployed image is a Next standalone build: it ships `@prisma/client` but **not**
`exceljs`. The JSON carries the parsed rows and the source sha so provenance
survives the hop.

## Alternatives considered

- **Load only the 21 `DR3 Woodland` rows.** Rejected — correct but leaves
  Eugene's picker empty, so half of AP approvals still can't reference
  equipment. The empty picker is the problem being fixed.
- **Map Cleveland Warehouse → DR3 Eugene.** Rejected as an unverified
  assumption that would file 71 possibly-non-DR3 assets against a DR3 site.
- **Add a `location`/`facility` column and load the real 35 locations.**
  Deferred, not rejected — it is the right long-term model and would let the
  picker group by real facility, but it is a schema change plus a picker
  redesign, and it collides with hard rule #1 the moment a Stockton row is
  rendered. Revisit with the admin surface (C-27).
- **Persist Ownership / VIN.** Deferred — no columns exist, and neither is used
  at approval time. VIN is the natural key if a future import needs to reconcile
  against a refreshed workbook.

## Consequences

- The AP Approve panel now offers **521 active options** (eugene 385,
  woodland 136). Approvers can link a real asset instead of being forced into
  "Not equipment-related".
- The mapping is **coarse and known to be coarse**. An Oregon-jurisdiction
  reading of "eugene" means the unqualified OTR fleet and every SVdP Lane County
  facility appear in Eugene's picker. That is intended for now; it is a
  data-quality debt tracked as **C-28**.
- **There is still no admin UI to maintain this registry** (**C-27**). Every
  future fleet change needs another run of this script until that ships.
- Re-running the script against a refreshed workbook is safe and is the intended
  update path.

## References

- CLAUDE.md hard rules #1 (Stockton), #2 (site separation), #6 (append-only audit)
- ADR-0046 Amendment 5 — `ap_equipment_links`, the Approve-panel multi-select
- ADR-0048 D3 — Terex `equipment_events` importer (a different table)
- `docs/OPEN-ITEMS.md` C-27 (missing admin surface), C-28 (coarse site mapping)
