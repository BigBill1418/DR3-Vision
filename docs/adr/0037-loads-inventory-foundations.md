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

## Post-acceptance implementation notes (2026-07-03)

Recorded per CLAUDE.md documentation discipline — these are the points where the
implementation added to or clarified the accepted text above. No accepted
decision was reversed.

### Deviations / additions applied

- **Investigation 1a finding (verify gate):** on `main` there was **no** verify
  action at all — `submitted → verified` existed only as an entry in the
  load-service `ALLOWED_PRIOR` state table, with no function, route, UI, or
  program/non-program columns. The mission §8 "shipped" fallback was not shipped.
  So the D2 `program_unit_count`/`non_program_unit_count` columns ARE the
  persistence, and this build adds the server-side verify gate
  (`src/lib/loads/verify-gate.ts` + `POST /api/manager/<site>/loads/<id>/verify`)
  that enforces `program + non_program == total_units` in a transaction with an
  audit row.
- **Investigation 1b finding (processed-units vs. existing daily flow):** the
  ADR-0030 daily production total is a query over `bonus_daily_entries` (per
  processor) + `bonus_reporting_adjustments`. `processed_units_daily` is a NEW,
  distinct **site-level billing** record — it does not duplicate those payroll
  tables and does not touch payroll math. Its entry surface lives beside the
  existing admin production surfaces (`/admin/processed-units`, super-admin).
- **Survey amendment — program/non-program pool split (Rick Albritton, survey
  Q11; applies to OR + CA):** `processed_units_daily` carries
  `program_units_processed` + `non_program_units_processed` (total derived, never
  stored; billing reads program only); `renovator_shipments` and `landfilled_units`
  carry `program_units` + `non_program_units` (sum == whole/units, validated); the
  D6 running balance is pool-aware and returns `{ program, nonProgram, total }`.
- **Survey amendment — CA fuel formula captured (Rick Albritton, survey Q6):** the
  CA `fuel_surcharge` seed `params` now carries the formula
  `(eia_rate_usd_per_gal / mpg) * miles_driven`, mpg 6.5, EIA West-Coast-ULSD
  index. `rate_cents` stays null and `computeFuelSurchargeCents` still refuses —
  the per-haul EIA-rate × miles calculator is P2 billing scope.
- **`source` provenance on all six tables (D8):** D4's field lists for
  `renovator_shipments`/`landfilled_units` did not spell out `source`, but D8
  requires every table carry business-date + `source` provenance for the ADR-0039
  retro-audit; a `RecordSource` enum (`manual`/`mymrc`/`import`) is on all of them
  and on the snapshot extension.
- **`locked_at` on the four CRUD-lite tables:** the deliverable requires
  "edit-before-any-lock." A nullable `locked_at` column is the lock signal the
  edit guard checks. (No locking workflow is wired yet; the column + guard exist.)
- **Inventory anchor pool attribution (Q-3):** physical snapshots carry no
  program/non-program split, so the running-balance DB adapter attributes the
  whole physical anchor to the PROGRAM pool by default (the pure computation stays
  general). See docs/QUESTIONS.md Q-3.

### Two decisions kept deliberately open (as the ADR intended)

- `outbound_materials.allocation_pct` remains a nullable placeholder — nothing
  computes from it.
- CA fuel-surcharge computation remains refused (formula captured, calculator is
  P2).

### NOT implemented — mission Addenda A/B (routed to Bill) — SUPERSEDED 2026-07-03

> **Superseded:** Bill ruled 2026-07-03 to adopt Addendum B; the model below was
> reconciled against it in a follow-up build. See "Post-acceptance revision —
> Addendum B (2026-07-03)" at the end of this ADR and docs/QUESTIONS.md Q-4
> (ANSWERED). The text below is preserved as the historical record of the decision
> point.

After acceptance, ADR-0036 mission **Addendum A** and **Addendum B** were merged
(PR #47, workbook reverse-engineering of `JUNE 2026 DAILY LOG WOODLAND.xlsm`).
They propose a materially different D4/D5/D6 model than this ADR — e.g. dropping
`renovator_shipments` in favor of an `outbound_materials.sub_category`, a
different `commodity` taxonomy, `Source`-driven program/non-program with a
`source_aliases` table, a `consumer_dropoffs.kind` enum, and a restructured daily
close. Those changes were **not** implemented in this build: they conflict with
the accepted ADR-0037 decisions above and with the explicit named deliverables,
and they arrived as coordinator relays (no user authority) and as a moving target
(A corrected by B) mid-build. They are surfaced for Bill in docs/QUESTIONS.md Q-4
with a recommendation to commission an ADR-0037 revision if the Addendum-B model
is the intended target; the current core (rules resolver, incentive cap,
running-balance engine, verify gate, audit/PII disciplines) carries straight over
to that model.

## Post-acceptance revision — Addendum B (2026-07-03)

**Status of this section:** operator-directed revision (Bill, 2026-07-03; no
further approval required per the requirements order). ADR-0036 mission **Addendum
B** (PR #47, `docs/handoffs/2026-07-03-adr-0036-addendum-b-daily-log-reverse-engineering.md`)
corrects Addendum A's category model and supersedes the conflicting parts of the
accepted ADR-0037 text above. This section itemizes every change vs the accepted
decisions; the accepted text (D1–D8) is preserved above as the historical record.
The **one** ADR-0037 migration (`20260703b_loads_inventory_foundations`) was
regenerated in place — it had never deployed anywhere, so this is a single coherent
migration, not a corrective second one (clean-replay re-verified on PG16).

### Changes vs the accepted text

- **D4 outbound restructure (Addendum B1).** `renovator_shipments` is **DROPPED**
  (model, DDL, service `src/lib/loads/renovator.ts`, routes, UI panel, tests) and
  folded into `outbound_materials` as `sub_category = renovation`. The
  `OutboundCommodity` enum is re-based to the **daily-log 9** (verbatim `list!I`):
  `trash, toppers, foam, metal, wood, cardboard, plastic, shoddy, cotton` (the
  accepted `landfill/steel/biomass/wte/…` were billing-workbook blocks, not the
  daily-log commodities the office captures). New `OutboundSubCategory` enum
  (`renovation, baled, shredded`). `outbound_materials` gains nullable `whole_units`
  + `program_units` + `non_program_units`: a **renovation** row is a whole-unit sale
  (`program + non_program == whole_units` when `whole_units` is present) and feeds
  the running balance's WholeUnitsSold term; **baled/shredded** rows are weight-based
  commodity sales (unit columns null; never subtract units). The daily-log-9 →
  billing-workbook-11 block mapping (trash→Landfill vs WTE is destination-driven) is
  **NOT built** — OPEN per Addendum B10-5.
- **D3 drop-off kinds (Addendum B1).** `consumer_dropoffs` gains
  `kind enum(incentive, unpaid, illegal)` NOT NULL. Incentive computation applies
  **only** to `kind = incentive`; `unpaid` / `illegal` rows never carry an
  `incentive_cents`. `LoadSourceType` gains `event`.
- **B7 site-driven program-ness.** `Source` gains `is_non_program`,
  `is_trans_charge`, `canonical_mileage`, plus a new `source_aliases(id, source_id,
  alias UNIQUE, created_at)` table for the workbook's heavy spelling drift. The
  verify gate's DEFAULT program/non-program split now derives from the load's source
  flag (non-program source → units default to the non-program pool; a manager
  override wins). The `program + non_program == total_units` check is unchanged.
- **D5 daily close (Addendum B4).** `processed_units_daily` is restructured:
  `program_units_processed`/`non_program_units_processed` → `stripped_program` /
  `stripped_non_program` (the entered quantities); adds `saved_units Decimal(7,1)?`
  (captured but **EXCLUDED from all inventory math** — semantics open, B10-2),
  `material_ticket_number`, `employees_count`, `processors_count`,
  `pocketcoil_estimate`. The super-admin gate, close/audit, and post-close block are
  unchanged. The close surface **DISPLAYS derived** whole-units-sold + landfilled
  (from renovation outbound rows + `landfilled_units` for the site/date) for
  confirmation — never entered twice.
- **D6 running balance (Addendum B4).** Equation is now
  `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`, program and
  non-program ledgers computed separately. WholeUnitsSold reads the
  renovation-sub-category outbound rows (the folded-in renovator channel);
  `saved_units` is excluded. Tests updated to the worked shapes incl. Rick's
  150 program + 25 non-program stripping day.
- **D1 seeds (Addendum B5).** New rule kinds: `driver_hourly` 12500¢ (CA),
  `general_labor_hourly` 9000¢ (CA), `per_diem_nightly` 27500¢ (CA),
  `unit_weight_estimate` params `{lbs:55, estimate_only:true}` (both sites). CA
  `fuel_surcharge` params gains `trigger_usd_per_gal: 5.05`. CA `processing_rate`
  becomes a full effective-dated schedule (2025 = 1600¢ / 2026 = 1650¢ / 2027 =
  1700¢). **No** mattress/foundation categories anywhere. **No** DR3#/Material#
  sequence issuance (OPEN per Addendum B10-6 — the existing TODO note stands).

### What carried over unchanged

The `state_program_rules` resolver + OR-fuel structural disallow, the pure incentive
daily-cap function, the pool-aware running-balance engine, the verify gate's
transaction + audit discipline, the CRUD-lite edit-before-lock guards, the D7
activation gate (admin-only until the ops gates close), and the CIP-PII disciplines
(`person_name` never exported) all carried straight over, as Q-4 predicted.

### Deliberately still open (Addendum B10)

- Daily-log-9 → billing-workbook-11 outbound→invoice block mapping (B10-5).
- `saved_units` semantics (B10-2).
- DR3# / Material# sequence issuance rule (B10-6).
- CA `fuel_surcharge` COMPUTATION remains refused (formula + $5.05 trigger captured;
  the per-haul EIA-rate × miles calculator is P2 billing scope).
- `outbound_materials.allocation_pct` remains a nullable placeholder.

## Post-acceptance hardening addendum (2026-07-03)

A P1 observability/correctness hardening pass over the merged ADR-0037/0038 code (see
CHANGELOG "Fixed — 2026-07-03") is non-architectural — no decision here is reopened —
with **one behavior change worth recording** because it changes an API contract:

- **D2 verify gate no longer defaults billing attribution blind.** The accepted text
  defaulted a load's program/non-program split from its source's `is_non_program`
  flag when the manager supplied no explicit split (Addendum B7). That default now
  requires a source to exist: if `inbound_loads.source` is **NULL** and no explicit
  split is supplied, `verifyLoad` throws a typed `VerifyGateError('no_source_for_default')`
  (HTTP 422) instead of silently crediting the whole load to the program (billed)
  pool. Rationale: billing pool attribution is money — a sourceless load has no basis
  to pick a pool, and a silent all-program default over-bills the MRC program. A
  manager-supplied explicit split still verifies a sourceless load; a source-driven
  default now emits an info log (`{loadId, defaulted:true, source flag}`). The
  `program + non_program == total_units` reconciliation is unchanged.

Other items in the pass (structured non-2xx logging, MyMRC `run_id` correlation +
loud ledger/detail failure logging, the D6 daily-close negative-balance warn-and-
confirm guard, the D1 ambiguous-effective-dated-rule guard, the D3 dropoff incentive
typed failures, the `listProcessedUnits`/`upsertScrapedHauls` N+1 removals, and the
manager-list pagination clamp) are additive hardening with no contract change.
