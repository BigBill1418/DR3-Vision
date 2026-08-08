# ADR-0087 — VLM equipment identity, normalization policy, and the decision register

**Date:** 2026-08-08
**Status:** **Proposed — NOT accepted, NOT implemented.** Decision-ready for Bill. The item-level human calls live in the companion register (`docs/plans/2026-08-08-vlm-equipment-decision-register.md`); this ADR fixes the *policy* those calls are made under.
**Extends:** ADR-0062 (equipment master seed), ADR-0063 (`/admin/equipment` + site+name unique index), ADR-0075 (equipment merge model, `merged_into_id`), ADR-0046 Amendment 9 (AP equipment-request escape hatch).
**Supersedes:** nothing, but §5 D5 corrects a doc error in ADR-0075 D5 (the Terex merges it describes as done were never executed — `merged_into_id` is NULL on all 566 rows as of 2026-08-06).

---

## 1. Context

DR3's Equipment list (566 rows) was seeded 2026-07-28 from a workbook export of the VLM database's `equipment` table (`svdp_rescue.equipment`, 631 rows, MariaDB — queried via the `vlm-replica-db` replica on CHAD-HQ; the `vlm-dockerhost` and `vlm-rescue` hosts are down). 519 of VLM's 626 distinct unit numbers are present in DR3. Bill's directive (2026-08-06): normalize the VLM trailer/vehicle naming and make the VLM→DR3 equipment population durable.

A full read-only survey (2026-08-06) plus VIN verification (2026-08-06/08) established the facts this ADR rests on:

1. **The sync problem is re-sync + dedup + anti-drift, not initial population.** The AP request-resolution path creates equipment rows with no similarity check: 4 duplicates were minted on 2026-08-06 alone, plus maintenance notes stored as assets ("fix trailer 95 and 5308").
2. **VLM's `unit` column is not unique, even conceptually.** VIN checks proved the trailer fleet and the vehicle fleet share the bare-number space: unit `13` is simultaneously a 1991 Comet trailer (VIN `1C0V28012MS038154`) and a 2002 Ford F150 (VIN `1FTRW07L32KB62511`). Same for `66` (trailer + Corolla) and `95` (two distinct trailers, Wabash + Fruehauf).
3. **Separators are load-bearing.** `21`, `21-27`, `21-48` are three distinct assets (dash = trailer-length disambiguation, confirmed by the type field on 26 of 28 dashed units). `Truck 9` and `Truck #9` are two different trucks (GMC box truck vs VIN'd Chevy C2500). Any normalizer that strips `-` or `#` silently merges real assets.
4. **True duplicates exist but are few**: `M104` ×2 is one Ford E350 double-entered (one row's "VIN" `DA81337` is the tail fragment of the other's full VIN); `f9`/`F-9` is one Hyster forklift; `DV2547`/`DV-2547` is very probably one Hyundai trailer entered twice with complementary fields.
5. **The tracking history is the long tail**: 88% of `trailer_tracking_1` rows match equipment exactly, but 683 distinct near-miss spellings (`G-30`/`G 30`→`G30`, letter-O `To8`→`T08`, HTML-escaped `41 &amp; 42`), 492 numeric "ghost" units with history but no equipment row, and a 6-value `-ACC` suffix family (332 rows) of unknown meaning.
6. **An extract pipeline already exists**: `vlm-cdc` tails `svdp_rescue` into `vlm-analytics-db` (`analytics.equipment`, keyed on `legacy_id`, carries `deleted_at`, ~20 min fresh). Caveat: the projection currently drops VIN and plate.

Two sessions of chat-table approvals made the meta-problem obvious: **decisions made in conversation don't survive, don't scale to 492-row worksheets, and can't be consumed by tooling.** Bill's direction (2026-08-08): "we need a better way to lock this in and figure this out." That better way is this ADR + the register.

## 2. Decision D1 — identity: `vlm_legacy_id`, never `display_name`

Add a nullable `vlm_legacy_id` column to DR3 `equipment` with a partial unique index (`WHERE vlm_legacy_id IS NOT NULL`). Backfill it for the ~519 already-matched rows via the canonical key (D2). The sync key is VLM's own primary key; a VLM rename becomes an *update*, not a new row. `display_name` remains a human label and a per-site uniqueness constraint — it is never again a join key.

Merged rows keep their `vlm_legacy_id`: when two VLM rows describe one asset, both DR3 rows carry their respective legacy ids and one is merged into the other (ADR-0075 model), so future sync updates land on the merge graph, not on resurrected duplicates.

## 3. Decision D2 — the canonical match key

Computed for lookup/aliasing only. Never displayed, never written back to VLM.

```
canonical_key(x) = UPPER(x)
                   → trim + collapse internal whitespace to nothing
                   → PRESERVE '-'  and '#'          ← both proven load-bearing (§1.3)
                   → fold O→0 and I→1 only when adjacent to a digit
```

**Amendment over the 2026-08-06 survey draft:** the survey's key stripped `#`. The `Truck 9`/`Truck #9` VIN check proved `#` distinguishes real assets, so it is preserved, same as `-`.

**Hard rule: the key proposes, corroboration disposes.** A key collision (or an alias-map hit) is a *review item*, never an automatic merge. A merge may only be executed when VIN, or make+model+year, corroborates that both rows are the same physical asset. This rule exists because both separators have already been caught disambiguating real assets.

## 4. Decision D3 — sync architecture

Nightly additive upsert from `analytics.equipment` (the existing CDC output) into DR3 `equipment`, keyed on `vlm_legacy_id`:

- New VLM row → insert (display name per the seed's `displayName()` pattern; category per D6 taxonomy; site per location mapping).
- Changed VLM row → update in place.
- VLM `deleted_at` → `is_active = false`. **Never hard-delete** — `ap_equipment_links` is financial-approval evidence (`onDelete: Restrict`).
- Rollout: dry-run mode (diff report only) before writes are enabled.

VLM stays the operators' system of record. Nothing in VLM has to change for this to ship; VLM-side cleanups (the register's punchlist) improve the data but are not prerequisites.

## 5. Decision D4/D5 — stop the drift; use the merge tool

**D4:** wire the already-built `findSimilarEquipment` / `canonicalizeName` into the AP request-resolution path (today it guards only the admin screen). Resolving a request against a near-match must surface the existing row before offering row creation. This closes the hole that minted the 2026-08-06 duplicates.

**D5:** the ADR-0075 merge capability gets its first real exercise on the register's confirmed duplicates (starting with DR3's split `F9` / `F9 — Hyster Forklift`). Doc correction: ADR-0075 D5's claim that the Terex near-duplicates were merged is wrong — no merge has ever been executed.

## 6. Decision D6 — canonical type taxonomy

VLM's 39 free-text `type` strings collapse to a controlled vocabulary (`trailer-28/31/48/53`, `trailer-flatbed`, `semi-tractor`, `box-truck`, `truck`, `rolloff-truck`, `garbage-truck`, `flatbed-truck`, `yard-jockey`, `van-cargo`, `van-passenger`, `bus`, `car`, `forklift`, `baler`, `shear`, `dolly`, `pallet-tipper`, `stacker`, `vehicle-lift`, `hot-melt`, `other`), which then maps deterministically onto DR3's 5-value `EquipmentCategory` enum (all rolling stock → `vehicle`; `forklift` → `forklift`; balers → `baler`; terex → `terex`; rest → `other`). The mapping worksheet (`type_vocab.csv`) ships 36/39 prefilled; `Vehicle`, `Van`, and blank need calls.

## 7. Decision D7 — the decision register mechanism

Human judgment calls are recorded as **data, in the repo**, not as chat approvals:

- Worksheets live in `docs/plans/vlm-equipment-register/*.csv`, generated from the replica by the SQL files committed beside them (`sql/*.sql`). Each row carries empty `decision` and `notes` columns.
- **Contract:** tooling may only act on rows whose `decision` is non-empty. Blank = pending. The allowed decision vocabulary per worksheet is defined in the register doc.
- **Bulk rules:** the register doc has a bulk-rules section ("ghosts: `archive` all with `last_seen < 2024-01-01`") that tooling expands into per-row decisions before execution, so a 492-row worksheet does not require 492 edits.
- Decisions are made by editing the CSV/doc in a PR (or directly on `main` for Bill); git history is the audit trail of who decided what, when.

## 8. Consequences

- Schema change to DR3 `equipment` (one nullable column + partial unique index) — additive, no behavior change until the sync ships.
- The seed script is retired as a population path once the sync is live; `/admin/equipment` remains the manual write path for non-VLM assets.
- The two-site mapping stays coarse (VLM has 42 equipment-bearing locations; DR3 has 2). Accepted for now; revisit if DR3 grows sites.
- VLM-side data quality (146 blank types, location-table dirt) is improved opportunistically via the register punchlist, not blocked on.
- We cannot write to VLM from the fleet: the CHAD copy is a replica, and the operator account on the `vlm-trailer` primary has no grants. VLM-side fixes are executed by Bill/staff in the VLM app (or after primary credentials are provisioned).

## 9. Alternatives considered

- **Chat-approval ad hoc (status quo)** — rejected: decisions don't persist, don't scale, and can't drive tooling.
- **Mass-rename VLM units to a clean convention** — rejected: separators are load-bearing, drivers know the current numbers, and the primary isn't writable from here anyway. Normalize the lookup, preserve the label.
- **Workbook re-seed (re-run `seed-equipment-master.mjs`)** — rejected: keys on `display_name`, no provenance, recreates the drift.
- **In-app reconciliation UI** — deferred to the roadmap: the register + bulk rules covers the current volume; build UI only if the long tail proves recurrent.

## 10. Sequencing

0. Bill decides the register items (7 collision groups + worksheets, bulk rules welcome).
1. Migration: `vlm_legacy_id` + partial unique index; backfill via canonical key; manual review of backfill misses.
2. One-time reconciliation: execute decided register rows (DR3 additions, merges, deactivations).
3. D4 similarity gate in the AP request-resolution path.
4. Nightly sync in dry-run; then enable writes.

## 11. Sources

- `svdp_rescue.equipment` / `trailer_tracking_1` / `locations` on `vlm-replica-db` (CHAD-HQ), queried 2026-08-06 and 2026-08-08 (replication healthy, `Seconds_Behind_Master: 0`).
- `dr3_vision.equipment` on `dr3-vision-postgres` (CHAD-HQ), queried same dates.
- `prisma/schema.prisma` (Equipment @ 4434), `scripts/seed-equipment-master.mjs`, ADR-0062/0063/0075, ADR-0046 Amendment 9.
- VIN verification transcript: units 13/66/95/M104/DV2547/F9/Truck 9, 2026-08-06 and 2026-08-08.
