# ADR-0037 — Loads & inventory foundations (P1 groundwork: schema activation, commodity model, processed-units close, program rules)

**Status:** Accepted (2026-07-03, approved by Bill)
**Date:** 2026-07-03
**Relates to:** mission record `docs/handoffs/2026-07-03-adr-0036-build-mission-…`, 2026-06-23 readiness handoff, PROJECT-CHARTER §4.4/§6/§6.5, ADR-0011 (processor form), ADR-0030 (daily production report), ADR-0032 (reporting-only adjustments), ADR-0033 (guards), ADR-0035 (migration invariant)
**Series:** first of three P1 ADRs — 0037 foundations (this), 0038 MyMRC ingestion rebuild, 0039 3-way audit + retro-audit

## Context

Kelsey Ruhland departs 2026-08-01. P1 requires the loads/inventory layer to go from
built-but-dormant to production **CA-first**, because both the 3-way audit (ADR-0039)
and billing generation (P2) read from it. What exists today: `expected_loads`,
`inbound_loads` (rich dock workflow), `load_stacks/photos/concerns`,
`site_inventory_snapshots`, `mymrc_reconciliations` — all with **0 operational rows**
(feed never worked; ingestion rebuild is ADR-0038). What does NOT exist: any outbound
/ commodity model, a processed-units record billing can bill from, consumer drop-off
(incentive) records, a renovator channel, or a rates/rules table. The July Woodland
workbook (§4 of the mission record) is the parity target.

## Decisions

### D1 — `state_program_rules`: every rate and program rule is data, never code

Effective-dated, site-scoped rules table, same resolution pattern as
`processor_bonus_rules` (named resolver, strict for live dates):

```
state_program_rules(id, site_id, rule_kind, effective_from, effective_to?,
                    rate_cents?, params jsonb?, created_by, created_at, …audit)
```

Seeded rule kinds (from the locked mission §3): CA `processing_rate` 1650¢ ·
OR `processing_rate` 1700¢ · OR `satellite_collection_rate` 225¢ ·
CA `collector_incentive` 300¢ with `params.daily_cap_units = 5` (per person per day)
· CA `fuel_surcharge` — **placeholder rule with `params.formula = null`** until the
Kelsey July capture lands (computation refuses to run while null; entry of raw values
still possible). **OR fuel surcharge is structurally disallowed**: no
`fuel_surcharge` rule kind is ever seeded for Eugene AND the resolver throws
`RuleStructurallyDisallowedError` if asked — both layers, so a future seeding mistake
still can't silently bill it. Money is **integer cents** (repo convention from the
bonus system); weights stay integer lbs (charter Q22).

### D2 — `inbound_loads` additive extensions (workbook Inbound tabs + segregation)

- `retrac_id String?` (indexed) — Re-TRAC is the universal external join key on every
  workbook record type; kept **distinct** from `external_mymrc_haul_id` (different
  systems).
- `slip_number String?` — workbook Slip # (present on every inbound tab).
- `transport_charged Boolean @default(false)` — splits the two Inbound tabs.
- `freight_cents Int?`, `fuel_surcharge_cents Int?` — load-level transportation
  charges (CA); fuel entry validated against D1 (an OR load can never carry one).
- `program_unit_count Int?` / `non_program_unit_count Int?` — the Q8 verify-gate
  split (`program + non_program == total_units` enforced at verify). ⚠ The mission
  §8 calls this fallback "shipped" but the columns are absent from
  `prisma/schema.prisma` on main — implementation step 1 verifies where the shipped
  gate actually persists and reconciles; if it is UI-only, these columns land here.
  The **non-program segregation ledger** (workbook "Inbound Non Program Units" tab)
  is a query over these columns — compliance-critical for Woodland co-processing.

### D3 — `consumer_dropoffs` (workbook Paid-Unpaid tab; CA CIP)

Public drop-offs are not dock loads — separate table, not `inbound_loads` rows:

```
consumer_dropoffs(id, site_id, dropoff_date, person_name, slip_number, units Int,
                  incentive_cents Int?, check_number String?, paid_at?, retrac_id?,
                  source enum(manual|mymrc|import), …audit)
```

`incentive_cents` computed via D1 (`units × collector_incentive`, capped at
`daily_cap_units` per person per day — cap enforcement is a named pure function with
real-Decimal/int tests). ⚠ **CIP data is MRC Personal Data** (charter Exhibit I /
ADR-0010): `person_name` (+ any future phone/plate/signature fields) is
PII — excluded from exports by default, breach-notification scope, 10-business-day
deletion-on-termination. This ADR carries only the fields the workbook needs
(name, check #); the fuller CIP check-in log (phone/plate/signature) stays V2.2.

### D4 — `outbound_materials` + `renovator_shipments` + `landfilled_units`

Three shapes, matching how the workbook actually records outbound:

- `outbound_materials(id, site_id, ship_date, commodity enum, weight_lbs Int,
  ticket_number?, retrac_id?, bale_count Int?, allocation_pct Decimal(5,2)?,
  buyer?, source enum(manual|mymrc|import), …audit)` — commodity taxonomy exactly
  per mission §4: `landfill, steel, biomass, wte, wood, toppers, foam, cardboard,
  plastic, cotton`. `allocation_pct` is a **nullable placeholder** (mission decision
  2.2 #2 — semantics pending Kelsey; nothing computes from it until answered).
  Avg-per-bale is derived at read time (`weight_lbs / bale_count`), never stored —
  one source of truth per the 06-23 lesson.
- `renovator_shipments(id, site_id, ship_date, buyer, dr3_number?, retrac_id?,
  whole_units Int, wood_lbs Int?, steel_lbs Int?, foam_lbs Int?, …audit)` — distinct
  channel (whole units, not commodity weights); **included in recovery-rate math**
  per MRC rules (feeds P3 alerts and OR's broader recycling-rate formula).
- `landfilled_units(id, site_id, disposal_date, units Int, slip_number?,
  reason enum(bed_bug, soiled, water_logged, other), …audit)` — whole-unit disposal
  (workbook Landfilled Units block); different shape from weight-based commodities.

### D5 — `processed_units_daily`: the number billing bills from

Mission §3: billing basis is **processed units, not inbound**. One row per site per
day: `processed_units_daily(id, site_id, production_date, units_processed
Decimal(7,1), source enum(manual|mymrc|import), entered_by, closed_at?, …audit)`.
Entry surface is **office desktop, super-admin gated** (mission §3); closing a day
writes an audit row; corrections after close follow the amendment pattern
(ADR-0028-style justification), never in-place edits. Implementation step 1 maps
this onto whatever the existing ADR-0030 daily-close flow already persists — extend,
don't duplicate ("daily close remains a button click", mission §5). Decimal(7,1)
matches the bonus system's half-unit precision.

### D6 — Inventory = ONE computed running balance, reconciled to physical counts

Per the operator decision recorded 2026-06-22 and the readiness checklist:

- **One shared pure function** (`src/lib/inventory/running-balance.ts`):
  `onHand(site, asOf) = anchor.units + Σ inbound (verified inbound_loads.total_units
  + consumer_dropoffs.units) − Σ processed (processed_units_daily) − Σ whole-unit
  outbound (renovator_shipments.whole_units + landfilled_units.units)` since the
  anchor. Weight-based `outbound_materials` do NOT subtract units (they are
  post-deconstruction commodities — deconstruction is what `processed` counts).
- `site_inventory_snapshots` gains `snapshot_kind enum(physical, computed)` +
  `reconciled_delta Int?` + provenance. A **physical count** becomes the new anchor;
  the delta vs. the computed balance is recorded and audited, never silently
  absorbed. Existing indoor/outdoor/in-processing fields unchanged (CA storage-limit
  warnings 3,500/5,000 and OR 6,000 read from them; warn-only at 90%/100%, never
  blocking — mission §5).
- **Acceptance anchor:** the June 2026 Woodland close must reproduce **4,062 units**
  (Pool-A snapshot) once historical data is loaded — this is a §7(b) criterion.
- Every quantity edge is a named boundary with real-`Decimal` tests + an e2e path —
  no second divergent computation of the same truth (the 06-22→23 incident class).

### D7 — Activation gates (readiness checklist, enforced before feature exposure)

Schema can merge behind flags, but no loads surface activates beyond what is already
shipped until: P0 guardrails deployed ✅ (live since 06-24) · CI correctness gate ✅
(ADR-0033/0035, live) · scraper anomaly detection + hardened logout detection (lands
in ADR-0038, gates the FEEDS) · **one recorded restore drill (P1-3)** and
**RESTIC_PASSWORD confirmed off-box (P1-4)** — both still open, owner Bill, tracked
here as blocking ops actions for activation (not for merging schema).

### D8 — Retro-audit compatibility (design constraint from mission §2.2 #4)

Every table above carries a business date + `source` provenance and no
created-at-coupled logic, so ADR-0039's retro-audit can run over ANY historical
window (including the accepted 8/1→ship gap and prior months' workbooks). Historical
workbook ingestion itself (staging tables, import identity) is ADR-0039 scope.

## Out of scope (later ADRs in the locked sequence)

MyMRC Aura/UI-API ingestion + anomaly alerting (**ADR-0038**) · 3-way audit engine,
discrepancy surface, retro-audit + historical workbook checks (**ADR-0039**) ·
invoice/Summary generation, events module, `container_rental_sites` + Rick's
manager-scoped write, COR generator, GP export boundary (**P2**) · rate/recovery
alerts (**P3**) · vendor-invoice approval (post-P1).

## Consequences

- Six new tables + one extended, all **additive** (ADR-0035 clean-replay; every
  migration replays on empty PG16 in CI).
- Billing (P2) becomes a read-side rendering problem over D1–D5 — no new capture
  surfaces later.
- The §4.1 sum-range-drift defect class dies at the root: totals are queries, not
  cell ranges.
- Two decisions stay deliberately open without blocking (nullable `allocation_pct`,
  null CA fuel formula) and two ops actions gate activation (restore drill,
  RESTIC_PASSWORD).
- i18n: operator-facing surfaces en/es/ur per hard rule #4; the office-desktop
  super-admin surfaces (D5) may ship English-first (manager-portal precedent,
  charter v0.16).

## Test plan (summary)

Rule-resolver matrix incl. `RuleStructurallyDisallowedError` for OR fuel ·
incentive daily-cap pure function (cap boundary, multi-dropoff same person same day)
· running-balance property tests (anchor + inbound − processed − whole-unit outbound;
snapshot reconcile records delta) · verify-gate split math · Decimal boundary tests
with real `Prisma.Decimal` on every count/weight/money edge · migration clean-replay
(CI gate, automatic) · e2e: dropoff→incentive→balance and inbound→verify→balance.
