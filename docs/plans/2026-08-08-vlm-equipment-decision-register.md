# VLM equipment decision register

**Date opened:** 2026-08-08 · **Policy ADR:** ADR-0087 · **Status: OPEN — awaiting Bill's decisions**

This register is the single place where human calls about VLM↔DR3 equipment identity are recorded. **Decisions live here as data; tooling executes only what is decided here.** Chat approvals don't count until they land in this file or its worksheets. Edit directly (Bill: on `main` is fine) or via PR; git history is the audit trail.

**How to decide:** fill the `decision` column of a worksheet row (vocabulary below), or write a bulk rule in §4 — one line can decide hundreds of rows. Blank decision = pending. Anything ambiguous: put the question in `notes` and leave `decision` blank.

---

## 1. The 7 unit-number collision groups (evidence: VIN-verified 2026-08-06/08)

Decision vocabulary: `approve` (execute exactly the recommended action) / `amend: <what to do instead>` / `reject`.

| # | Group | Verdict (evidence) | Recommended action | **DECISION** |
|---|---|---|---|---|
| G1 | `13` ×2 | Two real assets: 1991 Comet 28ft trailer (Cleveland Warehouse) vs 2002 Ford F150 (Maintenance). Different VINs. | VLM: keep both. DR3: **add** `13 — Ford F150` (vehicle, Eugene). | |
| G2 | `66` ×2 | Two real assets: 1991 Strick 28ft trailer vs 2021 Toyota Corolla. Different VINs. | VLM: keep both. DR3: **add** `66 — Toyota Corolla` (vehicle, Eugene). | |
| G3 | `95` ×2 | Two real trailers: 2005 Wabash (at DR3 Woodland, CA) vs 1984 Fruehauf (Store Loads, Eugene). Different VINs + plates, both Active. | VLM: keep both; **optional renumber** of one — two active trailers sharing "95" is live driver-facing ambiguity. DR3: **add** `95 — Wabash 28 Ft Roll Up Door Trailer` at **Woodland**. | |
| G4 | `M104` ×2 | One vehicle double-entered: both 2010 Ford E350s at Maintenance; row `1101830259`'s "VIN" `DA81337` is the tail fragment of row `1502300383`'s full VIN `1FBSS3BL6ADA813374`. | VLM: keeper = `1502300383` (full VIN, plate 753 PBQ); retire fragment row `1101830259`. DR3: none (single row already); map its `vlm_legacy_id` to the keeper. | |
| G5 | `DV2547` / `DV-2547` | Probable double-entry (high confidence, not VIN-proven): complementary halves — `DV2547` has VIN/make/year (2004 Hyundai, OTR); `DV-2547` has only plate `HV64611` + a dangling location FK. | VLM: keeper = `DV2547`; copy plate `HV64611` onto it; retire the shell. Confirm via plate lookup or eyes-on first if wanted. DR3: none. | |
| G6 | `f9` / `F-9` | One Hyster forklift double-entered: same location (Car Lot, Eugene); `F-9` fully typed, `f9` a blank shell. | VLM: keeper = `F-9` (id in note below); retire `f9` shell. DR3: **merge** bare `F9` row into `F9 — Hyster Forklift` via `merged_into_id` (first real use of the ADR-0075 tool). | |
| G7 | `Truck 9` / `Truck #9` | Two real trucks: `Truck #9` = 1993 Chevy C2500 dually (VIN'd, Car Lot); `Truck 9` = 1995 GMC box truck (Pending Inspection, Egan). The `#` is what distinguishes them. | VLM: keep both, do not strip the `#`; optional renumber of the GMC for cleanliness. DR3: none — both rows already exist, disambiguated by make. | |

Row-id note (G6): keeper `F-9` is VLM equipment id `425501964`.

## 2. Standing questions (free-form answers welcome, right here)

- **Q1 — `-ACC` suffix:** what does it mean (`901-ACC`, `945-ACC`, … — 6 values, 332 tracking rows, see `vlm-equipment-register/acc.csv`)? Should ACC variants be assets, or aliases of their base unit?
  **ANSWER:**
- **Q2 — ghost default:** for the 492 numeric tracking units with no equipment row (`ghosts.csv`), is the default `archive` (keep history, no asset row) acceptable, with exceptions decided per-row/bulk?
  **ANSWER:**
- **Q3 — G3/G7 optional renumbers:** do them, or live with the shared numbers?
  **ANSWER:**

## 3. Worksheets (`docs/plans/vlm-equipment-register/`)

Regenerate any worksheet with its SQL in `sql/` against `vlm-replica-db` on CHAD-HQ. Decided rows are never regenerated away — regeneration merges on the key column, preserving `decision`/`notes`.

| File | Rows | One row per | Decision vocabulary |
|---|---:|---|---|
| `ghosts.csv` | 492 | numeric tracking unit with no equipment row | `archive` / `backfill-inactive` / `backfill-active` / `investigate` |
| `aliases.csv` | 48 | tracking spelling → candidate equipment unit (fold-matched; **candidates only** — fold strips separators, so each needs a human eye) | `approve` / `reject` / `investigate` |
| `blank_types.csv` | 146 | equipment row with blank `type` | a class from ADR-0087 D6 taxonomy, or `scrap` / `unknown` |
| `type_vocab.csv` | 39 | distinct VLM `type` string | confirm/correct `proposed_class` (36 prefilled; `Vehicle`, `Van`, blank need calls) |
| `acc.csv` | 6 | `-ACC` tracking value | per Q1 |

## 4. Bulk rules (tooling expands these into per-row decisions before executing)

Write rules as: `<worksheet>: <decision> WHERE <condition on columns>`. Later rules override earlier ones; per-row explicit decisions always win over bulk rules.

```
# examples (not active until uncommented/edited by Bill):
# ghosts.csv: archive WHERE last_seen < 2024-01-01
# aliases.csv: approve WHERE uses >= 50
```

## 5. Execution log (append-only; tooling/sessions record what was executed when)

_(empty — nothing executed yet; execution begins per ADR-0087 §10 after decisions land)_
