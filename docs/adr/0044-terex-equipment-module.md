# ADR-0044 — P4: Terex equipment module (downtime/cost log + derived throughput + trend view)

**Status:** Accepted (2026-07-04, approved by Bill)
**Date:** 2026-07-04
**Relates to:** mission record §2.1(3)/§6-P4; survey build-inputs §D3 (Bethany: machine downtime reaches the board with no data; Juan: downtime reported by word-of-mouth; Janette: a side spreadsheet holds Terex productivity + machine notes — "Terex is down" was found handwritten in a numeric cell of the daily log)
**Series:** P4, after 0043

## Context

The Terex is the throughput bottleneck and its operational record lives in a side
spreadsheet plus hallway conversation. The mission scopes P4 tightly: throughput
**derived** from data Vision already captures, a cost/downtime **entry surface**,
and a **trend view** for equipment strategy. This ADR adds one capture table and
two read surfaces — throughput itself needs NO new capture (the daily close
already records stripped units and `pocketcoil_estimate`).

## Decisions

### D1 — `equipment_events`: one log, Terex-first but not Terex-hardcoded

```
equipment_events(id, site_id, equipment_code String default 'terex',
    event_date @db.Date, kind enum(downtime, maintenance, repair, cost, note),
    hours_down Decimal(5,2)?, cost_cents Int?, vendor String?, notes String?,
    source RecordSource, created_by, locked-free (editable; history via audit), …audit)
```

`equipment_code` is a plain string (seeded UI filter 'terex') — a second machine
becomes a data value, never a migration. Manager-scoped entry (site-scoped, hard
rule #2) beside the loads-inventory surfaces; every write audited. Juan's
word-of-mouth path becomes: floor reports to office (unchanged human flow),
office logs it in 30 seconds with hours-down and a note.

### D2 — Throughput: derived only, one source of truth

Throughput reads `processed_units_daily` (stripped program+non-program per day)
— the number the office already closes daily. NO separate throughput entry
exists (a second entry path would recreate the two-artifact drift class, §B8).
Derived series exposed by a pure provider: units/day, units/run-hour where
downtime hours exist (`day_hours_assumed − hours_down` with the assumption
explicit in config, default 8h, labeled), 7/30-day rolling means.

### D3 — Trend view

`/dashboard/[site]/equipment`: throughput trend (daily bars + rolling mean),
downtime overlay (red bands from `kind=downtime` events), cost series (monthly Σ
`cost_cents`), and the `pocketcoil_estimate` overlay (Juan Q4: pocket coils slow
the line — the correlation becomes visible instead of anecdotal). CSV export.
English-first office surface; onClick; site-scoped. A small "equipment" tile on
the site dashboard shows last-event + 7-day units/day.

### D4 — Deliberately out

No work-order workflow, no maintenance scheduling, no alerting (a chronic-downtime
alert can become an audit-engine M-code later if the data shows a pattern worth
paging on — data first), no depreciation/asset accounting (cost_cents is
operational spend context, not bookkeeping — GP remains the ledger of record).

## Consequences

One additive table + one page + one tile; downtime and cost stop evaporating into
side spreadsheets; the board's "equipment failure and function" ask (Bethany Q1)
gets a real series; the throughput number is the SAME number billing bills — no
new truth introduced.

## Test plan (summary)

Event service CRUD + audit rows + site scoping · derived-throughput provider
(days without closes, downtime-hour math incl. the labeled 8h assumption, rolling
windows) · pocketcoil overlay data shape · tile provider · migration
clean-replay (CI).

## Post-acceptance implementation notes (2026-07-05)

Shipped per D1–D4. Files: migration `prisma/migrations/20260710_equipment_events`
(+ the `// ADR-0044 — equipment` end-block in `prisma/schema.prisma`); service
`src/lib/equipment/service.ts`; derived provider `src/lib/equipment/throughput.ts`;
tile provider `src/lib/equipment/tile.ts`; routes `src/app/api/manager/[site]/equipment/{route,[id]/route}.ts`;
UI `src/app/dashboard/[site]/equipment/{page,EquipmentClient}.tsx`; launcher tile +
site-dashboard tile.

- **NO hard delete (D1 + hard rule #6).** The model has no `locked_at` (freely
  editable, history via an `audit_log` row on every write). Removal is a
  **soft-void**: `voided_at`/`voided_by` set, a `soft_delete` audit row written,
  the row retained and excluded from every derived series + the tile. The API maps
  HTTP `DELETE` → soft-void (not a physical delete); a voided row cannot be edited.
  Re-voiding is idempotent (no second audit row).

- **`hours_down` shape (D1).** Meaningful ONLY for `downtime`/`maintenance`/`repair`;
  a `cost`/`note` row carrying it is rejected (422). `cost_cents >= 0`, integer.
  Any kind may additionally carry a cost (a repair with a vendor invoice).

- **DECISION — downtime hours for run-hour + red bands use `kind=downtime` ONLY.**
  D2's `units/run-hour = units/day ÷ (assumed_day_hours − hours_down)` and D3's red
  bands must describe the same "downtime". Maintenance/repair hours are captured
  but are *planned* interventions, not line-stopping downtime, so they are NOT
  folded into the run-hour denominator or the bands. If the board later wants
  planned-hours folded in, it is a one-line change in `throughput.ts`
  (`downtimeByDay` filter) — flagged here so the choice is explicit, not implicit.

- **`assumed_day_hours = 8` (D2).** A documented module constant
  (`ASSUMED_DAY_HOURS` in `throughput.ts`), surfaced to the UI legend by its label
  — NOT a config table (overkill for one number, per D2). Changing it is a
  one-line edit; it is never silently baked into a stored value.

- **Throughput is DERIVED, never captured (D2).** The provider only READS
  `processed_units_daily` (units/day = `stripped_program + stripped_non_program`)
  and the equipment log. There is no throughput-entry path anywhere.

- **Manager-scoped, NOT behind the ADR-0037 D7 activation gate.** Equipment is its
  own surface; it uses `requireManagerForSite` directly (manager-on-own-site or
  admin / all-sites manager). It is not admin-gated like loads-inventory.

## Operator follow-ups (non-blocking)

1. **Second machine.** `equipment_code` is a plain string (default `terex`). A
   second machine is a data value — pass `equipmentCode` on entry and add it to the
   UI filter; no migration. The trend page + tile accept an `equipmentCode` query
   filter today but default to all equipment at the site.
2. **`pocketcoil_estimate` overlay scale.** The overlay is drawn on its OWN axis (a
   shape-correlation cue for Juan's Q4 pocket-coil-slows-the-line hypothesis), not
   the units axis. If the board wants a quantified correlation (not just a visible
   shape), that is a follow-on analysis, deliberately out of P4 scope (D4).
