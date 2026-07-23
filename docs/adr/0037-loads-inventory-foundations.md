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
  - consumer_dropoffs.units) − Σ processed (processed_units_daily) − Σ whole-unit
    outbound (renovator_shipments.whole_units + landfilled_units.units)`since the
anchor. Weight-based`outbound_materials`do NOT subtract units (they are
post-deconstruction commodities — deconstruction is what`processed` counts).
- `site_inventory_snapshots` gains `snapshot_kind enum(physical, computed)` +
  `reconciled_delta Int?` + provenance. A **physical count** becomes the new anchor;
  the delta vs. the computed balance is recorded and audited, never silently
  absorbed. Existing indoor + in-processing fields unchanged, following the
  **ADR-0037 addendum (2026-07-22)** removing outdoor from Vision per DR3
  operational compliance (see "Addendum — outdoor storage removed" below). The CA
  storage-limit warning reads the **indoor** cap (3,500) and OR the **total on-site**
  cap (6,000); warn-only at 90%/100%, never blocking — mission §5. The contracted CA
  5,000-unit **outdoor** allowance is not exercised and is no longer modelled.
- **Acceptance anchor:** the June 2026 Woodland close must reproduce **4,062 units**
  (Pool-A snapshot) once historical data is loaded — this is a §7(b) criterion.
- Every quantity edge is a named boundary with real-`Decimal` tests + an e2e path —
  no second divergent computation of the same truth (the 06-22→23 incident class).

### D7 — Activation gates (readiness checklist, enforced before feature exposure)

Schema can merge behind flags, but no loads surface activates beyond what is already
shipped until: P0 guardrails deployed ✅ (live since 06-24) · CI correctness gate ✅
(ADR-0033/0035, live) · scraper anomaly detection + hardened logout detection (lands
in ADR-0038, gates the FEEDS) · **one recorded restore drill (P1-3)** ✅ MET
(`d4917d0`, ran + passed twice 2026-07-22 against real R2 snapshot `f6eb8cf8`) and
**RESTIC_PASSWORD confirmed off-box (P1-4)** ✅ CONFIRMED 2026-07-22 (Fleet 1Password
item "DR3-Vision backups — restic + R2 repo", SHA-256 matches on-box). Both ops
preconditions are now satisfied.

**GO-LIVE 2026-07-22 — `loads_inventory` flipped `pilot → live` for Woodland +
Eugene** (audited, `flipped_by` = Bill). Managers/operators are now activated at
both sites; they reach the surface via the ungated "Loads & inventory" nav link on
`/dashboard/[site]`. Reversible via the inverse flip. `outbound.ts` `allocation_pct`
semantics remain "pending Kelsey" (nullable, does not touch the running balance) —
capture before her 2026-08-01 departure.

**Amendment (2026-07-21) — the D7 switch is now data-driven, not hardcoded.**
The activation gate `assertLoadsInventoryActivated` no longer hardcodes
admin-only. It reads the per-site **`loads_inventory` ADR-0047 rollout surface**:
`pilot` (the seeded default) ⇒ admin-only (identical to the historical behavior);
`live` ⇒ operators/managers activated for that site. Admins always pass (no DB
read). Default/unset/unregistered/read-error ⇒ admin-only (fail-closed via
`isUiSurfaceLive`), so a fresh deploy exposes nothing until an admin flips it.
The gate is `async` and the single chokepoint `requireActivatedManager` awaits it
with the site context (all 14 manager loads routes thread through that one call —
no route signature changed); the loads-inventory dashboard page consults the same
surface. This does **not** relax the ops preconditions above — the restore drill +
off-box `RESTIC_PASSWORD` remain Bill's go/no-go for _approving_ the flip; the
change only moves the switch from a code deploy to an audited admin action at
`/admin/rollout` (flip `loads_inventory` → `live` per site, with a criteria note).
Registered by migration `20260729_adr0037_loads_inventory_rollout_surface`
(additive) + `prisma/seed.mjs`.

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
  - `program_units` + `non_program_units`: a **renovation** row is a whole-unit sale
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

## §3 amendment — D6 physical-snapshot pool split (planning rollup 2026-07-08 §1.4)

The D6 running balance already returns `{ program, nonProgram, total }`, but the
**physical snapshots** that anchor it carried no pool split — the DB adapter
attributed the whole anchor to the program pool (Q-3). This amendment records the
split at the source. `site_inventory_snapshots` gains (migration
`20260715_pool_split`):

- `program_units Decimal(7,1)?`, `non_program_units Decimal(7,1)?`
- `pool_attribution TEXT NOT NULL DEFAULT 'measured'` — `'measured'` (both pools
  entered) or `'legacy'` (pre-amendment; all counts attributed to the program pool).

**Validation** (service layer, typed `PoolSplitMismatchError`, HTTP 422): when
`pool_attribution = 'measured'`, `program_units + non_program_units` MUST equal the
physical count total, checked with `Prisma.Decimal`. The physical-count entry UI
gains the two pool fields + a live running-total helper and a plain-language
mismatch message.

**Backfill:** existing rows migrated to `pool_attribution = 'legacy'`,
`program_units = total`, `non_program_units = 0` (attributed-all-to-program per
§1.4). Clean measured data starts once counters enter both fields.

**Balance:** `onHand()` uses the measured split as the anchor pool pair when the
anchor snapshot is `'measured'` with both pool fields present; otherwise it keeps
the legacy attribution (anchor → program, non-program = 0). This resolves the Q-3
"physical snapshots carry no pool split" note. `computeRunningBalance` and the
`{ program, nonProgram, total }` return shape are unchanged (backward-compatible);
`program + nonProgram === total` still holds.

## Post-acceptance note — 2026-07-09 (cotton is a PERMANENT template feature)

The Addendum-B daily-log-9 taxonomy already carried `cotton` (verbatim from
`list!I`), but its DAY-sheet placement read as a June anomaly: only DAY6 carried
a 9th COTTON outbound block (cols 68–75), so PR #87 treated it as an ad-hoc
mid-month template edit. The July workbook settles it: **DAY6 carries the same
9th cotton block in July too** — the "×5 quirk" Kelsey flagged is a permanent
structural feature of the template, not an anomaly (2026-07-09 rollup §3.1).
The parser layout expectation is encoded in
`src/lib/audit/workbook/day-sheet-layout.ts` (`commodityBlocksForDaySheet` —
DAY6 → 9 blocks, cotton last at col 68; every other DAY → 8). The formula-level
`×5` reading still needs Kelsey's walkthrough (open capture item).

## Amendment — 2026-07-18 (inventory + sources foundation; rollup 2026-07-17 §8.1)

Tune-and-launch amendment locking the corrected-June numbers and the site-billing
taxonomy. Ships with migration `20260725_adr0037_inventory_foundation`.

### Correct-arithmetic inventory close (§2.3, §1.1, §A.2)

The corrected June workbook (SHA `1eeeccb…`) closes to **3,977 (3,748 program + 229
non-program)**. Vision computes this in code (`src/lib/inventory/inventory-close.ts`
`computeInventoryClose`) via the CORRECT arithmetic — never the workbook's latently
buggy `D45`/`D48` formulas:

```
program_close     = program_open + program_inbound − program_stripped
non_program_close = non_program_open + non_program_inbound − non_program_stripped − saved_units
total_close       = program_close + non_program_close − sold − landfilled
```

The authoritative pool-level aggregates come from the workbook's own **Processed
sheet** (per-day F/G/D/E/H/I + opening D5/F5 + the `Saved` DAY box), NOT from
re-summing the DAY per-shipment grid. Re-summing the grid over-counts inbound by 85
units (isolated to DAY23's `NP`-marked Recology Healdsburg row, which the workbook's
`F = I38 − L39` accounting nets out); the Processed ledger is billing-truth. The parser
exposes `inventoryLedger` + `inventoryClose` on `ParsedWorkbook`, stages the ledger as
an `inventory_ledger` staging row, and the promotion close (D2) reads it so the ADR-0048
close assertion is the §2.3 close (`expectedCloseTotal` for June Woodland = 3977, was
4062). See `docs/parsers/woodland-daily-log-schema.md`.

- **§1.1 sequential depletion** (`sequentialDepletion` / `depleteSeries`): program units
  are stripped first; non-program is drawn only once the program pool is exhausted. June
  strips only program (E40 = 0), so this is a no-op for June but is the correct general rule.
- **§A.2 `saved_units`**: the DAY `Saved` box subtracts from the NON-PROGRAM pool
  (Kelsey's confirmed default). Now wired into the shared `computeRunningBalance` (was
  previously excluded from all inventory math).

### Sources — site-billing taxonomy (§3.2)

- `Source.site_type` (`SourceSiteType`: `mrc_inbound | cvp_retailer | collection_site |
third_party_inbound`) — picks the invoice-line set per site. Nullable (legacy seeds).
- `Source.active_billing` (default true) — false suppresses ALL invoice lines (Roseburg:
  non-program, seed inactive until they sign MRC).
- `Source.bill_trans` / `Source.bill_trailer` (default true) — per-source overrides of the
  site_type default (Cottage Grove: both false, per-mattress still charged).

### Pool routing (§3.2, §A.5)

`src/lib/inventory/pool-routing.ts` — the single map from an inbound channel to its
inventory pool. `mrc_program + collection + all drop-offs (incentive/unpaid/illegal) +
event` → PROGRAM pool; `non_program` → NON-PROGRAM pool. Rick: illegals are treated the
same as unpaid. Kelsey (§A.5): event units feed the program pool for inventory (event
BILLING is a separate structure). There is **no** new `illegal_dropoff` enum value —
`ConsumerDropoffKind.illegal` already carries that concept; the routing maps onto it
rather than duplicating it.

### Consumer drop-off traceability (§1.3)

`ConsumerDropoff.consumer_name` (nullable CIP PII, distinct from the required
incentive-payee `person_name`) and `ConsumerDropoff.incentive_amount_cents` (the explicit
unpaid/illegal Bye-Bye-Mattress check amount, default `units × 300`¢ = $3/unit at capture,
overridable; distinct from the rule-capped, incentive-kind-only `incentive_cents`). Wired
through the dropoffs service + manager API.

### Surfaces (§10.4) — status

- iPad daily-close `saved_units` field: already present (`ProcessedUnitsClient`); comment
  corrected (saved now subtracts from non-program, no longer "excluded from math").
- Write-in one-off non-program tag (free-text source at iPad inbound entry) and the
  `/admin/sources` `is_non_program` toggle: **no existing `Source`-model entry/admin
  surface** — deferred as follow-ups (the schema now supports them: `is_non_program`
  exists; `site_type`/`active_billing`/`bill_trans`/`bill_trailer` added here).

### §A.6 — Kelsey's Summary tabs are stale

`Summary!` / `Trans Summary!` are advisory parity only and NEVER feed billing aggregation
(the close reads the Processed ledger). Surfaced at parse time via the `[summary-stale]`
flag; `Trans Summary!` is routed to evidence-only.

## Amendment — 2026-07-21 (Addendum B rollup §2/§4/§5.2/§14 — Rick's provenance + unit-status model)

Rick/Bill's 2026-07-19/20 rollup (`docs/handoffs/2026-07-21-mrc-billing-addendum-rick-mary-kelsey-rollup-2026.md`) corrects and extends the P1 foundation. Schema shipped in migrations `20260730_adr0037b_addendum_b_schema` (DDL) + `20260730b_addendum_b_seeds` (DML). Event billing + TONU is split into its own **ADR-0056**.

### `site_type = svdp_internal_store` (§4)

Fifth `SourceSiteType` value for the 11 SVDP-run retail/warehouse locations (Division, Seneca, West Eugene, Chad Drive, Q Street, Main Street, Junction City, Oakridge, Garfield, CARS, Cleveland WH). They bring mattresses but are **not** MRC-approved collection sites: no per-mattress, no trans, no trailer, no MRC unit. Seeded `active_billing = false` (zero invoice lines); the `site-type-billing.ts` default set for this type is all-false (belt-and-suspenders). Also seeded **`is_non_program = true`** (money-safe default): Rick §4 — these stores "are not Collection sites in conjunction With the MRC", so their inbound mattresses are outside the MRC program and the verify-gate / promotion DEFAULT split routes their units to the NON-program (non-billable) pool rather than the program pool billed at UNITSMO (a manager can still override at verify). The flag lives in the shared `SVDP_INTERNAL_STORE_CLASSIFICATION` constant (`prisma/seed/addendum-b-data.mjs`), applied identically by the `20260730b` store INSERT and `seedSourceBillingClassification`, and pinned by `src/lib/seed/addendum-b-data.test.ts`.

### `provenance_agencies` table + `inbound_loads.provenance_agency_id` (§2)

Sponsors (a halfway house on Hwy 99 next to Lindholm) is **not** a source or a drop-off kind — it is the _agency of origin_ that delivered the mattresses, peer to Eugene Mattress Company and U-Haul. New `provenance_agencies` table (`id, name UNIQUE, notes, active`) + a nullable bare-scalar FK `inbound_loads.provenance_agency_id`. Provenance is orthogonal to billing: an agency never produces an invoice line. Seeds: Sponsors, Eugene Mattress Company, U-Haul.

### Unit-status ledger — Rick's model REPLACES Kelsey's §A.2 saved-units subtraction (§5.2)

Rick: _"Saved units are not removed from inventory until they are sent to a store."_ Kelsey's Addendum-A §A.2 immediate-subtraction model was operationally wrong.

**Repo-reality divergence (documented):** the ADR-0037 inventory is an **aggregate-ledger** architecture — there is **no** per-unit `unit_records` table (the handoff's `unit_records.*` is idealized spec language). The faithful shape is a **status-bucketed movement ledger**, `unit_status_movements`:

- `UnitStatus` enum `on_floor | saved | processed | sold | landfilled`; each row is a count of `units` crossing `from_status → to_status` at `status_changed_at`. A live per-status floor count is the signed sum of movements into vs out of each bucket. Intake rows carry `from_status = null`.
- `to_status = saved` does **not** decrement the live floor (units stay on the floor per Rick). Store transfer = a `saved → sold` movement carrying `store_destination_id` → the `svdp_internal_store` source. Two iPad ops: "Mark N as saved" and "Send N saved units to [store]".
- `landfilled_reason` **reuses** the existing `LandfilledReason` enum; the handoff's "wet" maps to `water_logged` (no duplicate enum). §11's Landfilled-Units commodity block (Bed Bug / Soiled / Wet) renders from this + `landfilled_units`.

**`processed_units_daily.saved_units` retraction — scope-bounded (money-safe):** the _live-floor subtraction_ semantics (Kelsey §A.2, `running-balance.ts` `onHand`) are retracted per Rick. The **column is retained**: it is the workbook daily-log capture field, and the **historical closed-month audit reconciliation** (`inventory-close.ts` + `workbook-promotion.ts`; the June **3,977** oracle) depends on the workbook's own subtraction — that historical parity is unchanged.

**APPLIED (2026-07-21, this rollup):** `onHand` no longer supplies `savedUnits` to `computeRunningBalance` — the LIVE running balance (and the §3 floor tile that reads it) now counts saved units as still on the floor per Rick §5.2. The `computeRunningBalance` `savedUnits?` parameter is retained (defaults to 0) and is fed ONLY by the historical audit path, whose behavior is unchanged. Pinned by `running-balance.test.ts` ("onHand does not subtract saved_units — live floor keeps saved units, §5.2") and the floor-tile test. The change is confined to `onHand`; `inventory-close.ts` and `workbook-promotion.ts` are deliberately untouched (the 3,977 oracle relies on the workbook's recorded subtraction).

**STILL DEFERRED (tracked for the inventory feature agent):** the `unit_status_movements` ledger has NO writer yet — the §15-2 iPad operations ("Mark N as saved", "Send N saved units to [store]" i.e. a `saved → sold` movement carrying `store_destination_id`) do not exist, so the ledger is currently empty and `onHand`'s live floor still derives saved-vs-on_floor from the aggregate close columns rather than the movement ledger. Rewiring `onHand` to consume `unit_status_movements` is a later, separate change; this ADR ships the schema + contract only. (Recorded here because the integrator owns `docs/OPEN-ITEMS.md`; fold into an OPEN-ITEMS entry at integration.)

### Source canonical MyMRC names + aliases (§1/§12)

Five OR collection sources renamed **id-preserving** (UPDATE, not re-insert — every `inbound_loads.source_id` FK survives) to Rick's canonical MyMRC portal spellings (incl. MRC's verbatim typo **"Glenwood Central Recieving Station"**). The retired verbatim seed names + month-to-month customer-name variants (§12) become `source_aliases` rows (the existing ADR-0037 B7 alias table — reused, not a new table), so historical workbook/MyMRC data still resolves. New OR rows: The Dalles (new MRC site), Rifes, Roseburg (non-program, `active_billing=false`, `is_active=false`, parked until MRC signature — activate = flip both true). The 4 OR sites Rick's §1 did not name (Short Mountain Landfill, Thompsons Sanitary Service, Stayton Community Center, Deschutes) are left at their current names pending his confirmation.

**Intake wiring (§12 parser requirement, §15 item 7).** All alias matching is case- and whitespace-insensitive (trim/lowercase/collapse-ws); canonical `sources.name` always beats an alias on a normalized-key collision; an unmatched name is NEVER guessed:

- **Resolver contract** (`src/lib/audit/types.ts` `SiteAliasResolver`, DB impl `src/lib/audit/workbook/site-alias.ts` `sourceAliasResolver`) now also returns the resolved **`sourceId`** so intake can _link_ the record, not just classify it.
- **Workbook ingest (ADR-0039)** — already wired via `api/admin/audit/workbook/route.ts` → `ingestWorkbook` → `resolveInboundSites`: an unknown name opens ONE deduped `unresolved_site` finding per distinct name (the operator-review queue); parsing continues, the row is staged, nothing is dropped.
- **Workbook promotion (ADR-0048)** — `decodeStagingRows` now resolves **every** inbound `site_name_raw` (previously an explicit program split bypassed resolution entirely, so promoted loads carried no source link and drifted names were silently accepted). The resolved `sources.id` is written to the promoted **`inbound_loads.source_id`** (restores the MyMRC reconciliation join for June/July promoted months). Any unresolved name — including one resolving to another site's source (hard rule #2) — refuses the whole promotion with `PromotionUnresolvedSourceError`, listing every offender once; the operator seeds the missing alias and re-runs.
- **MyMRC scraper upsert (ADR-0038)** — `src/lib/mymrc/upsert.ts` keeps the exact-verbatim `sources.name` match primary, then falls back to a site-scoped normalized lookup over canonical names + `source_aliases` (built only when a name misses; the module cannot import the audit resolver — `tsconfig.mymrc.json` compiles it standalone — so normalization is duplicated in lock-step). Alias-resolved names are surfaced in `UpsertSummary.alias_resolved_source_names` + a once-per-run info log; unmatched names keep the existing `source_id=null` + `source_name_at_sync` + warn behavior.
- **Live workbook-sync bridge (ADR-0049)** is untouched: it upserts site-level `processed_units_daily` rows and carries no customer names.

Alias coverage is locked by `src/lib/audit/workbook/addendum-b-alias-resolution.test.ts`, which resolves the seeded `SOURCE_ALIASES` pairs (from `prisma/seed/addendum-b-data.mjs`) end-to-end through the DB-backed resolver. Rifes and Roseburg have no §12-observed variants; their canonical names resolve directly (no alias rows needed).

### Kelsey AP-approver auto-remove date (§7)

`ap_approvers` Kelsey row `active_until` moved 2026-08-01 → **2026-08-08** (vacation → transfer extended one week). Migration UPDATE guarded by the old value (idempotent; clean no-op on a fresh CI DB); seed.mjs mirrors it.

### Addendum — outdoor storage removed from Vision (2026-07-22)

Per Bill's directive on 2026-07-22 — *"we will also remove the units outdoor we are
never allowed to store units outside. this can't be in the system."* — the outdoor
storage concept is removed from Vision entirely: `site_inventory_snapshots.units_outdoor`
and `sites.max_units_outdoor` are dropped, the physical-count UI no longer offers an
outdoor field, and the running balance / audit legs / COR prefill sum
`indoor + total + in_processing` only. DR3 never stores units outside; the MRC
contract's 5,000-unit outdoor allowance at Woodland is a contracted allowance that is
not exercised (annotated in `docs/MRC-CONTRACTS.md`).

Migration: `prisma/migrations/20260806_remove_outdoor_from_site_inventory_snapshots`.
The pre-migration audit on production (2026-07-22) returned **0 rows** with a non-zero
`units_outdoor` (1 snapshot row total, `units_outdoor` NULL), so no data fold was
required; the migration nevertheless folds any non-zero outdoor into indoor and writes
an `audit_log` row per fold (`actor_label = 'adr-0037-outdoor-removal'`) so it is
correct on any database that carries outdoor counts.

**Storage-limit warning classification (compliance metric 6, `src/lib/compliance.ts`).**
The three thresholds were classified against code, not contract prose:

- **CA 3,500 — INDOOR-specific** (`sites.max_units_indoor`; also drives the COR
  capacity banner's 90% warn at 3,150 in `src/app/dashboard/[site]/cor/page.tsx`).
  **Preserved.**
- **CA 5,000 — OUTDOOR-specific** (`sites.max_units_outdoor`; its only consumer was
  the metric-6 capacity sum). **Removed** with the column.
- **OR 6,000 — TOTAL-based** (`sites.max_units_total_on_site`, off-site prohibited).
  **Preserved.**

Consequence to note: metric 6 previously graded Woodland against the *sum* of the
indoor and outdoor caps (8,500). It now grades against the indoor cap alone (3,500),
so a real on-site count near the June close (3,977) grades **red**. That is the honest
reading of DR3's actual operating constraint — indoor capacity — and is surfaced for
Bill's confirmation rather than papered over with a synthetic total cap.

#### §A.4.5 — Storage-limit warning disposition (operator-CLEARED, 2026-07-23)

Bill confirmed the storage-limit warning split. This is the FINAL disposition for the
three thresholds Phase 5's investigation classified; it closes the "surface for Bill's
confirmation" item above.

| Site | Threshold | Keyed on | Kind | Disposition |
|---|---|---|---|---|
| Woodland (CA) | **3,500** | `sites.max_units_indoor` | INDOOR | **PRESERVED** — real indoor capacity; drives compliance metric 6 (CA) and the COR capacity banner's 90 % warn (3,150). |
| Woodland (CA) | **5,000** | `sites.max_units_outdoor` | OUTDOOR | **REMOVED** — DR3 is never allowed to store units outside (Bill, 2026-07-22). Column dropped by migration `20260806_remove_outdoor_from_site_inventory_snapshots`; the only warning consumer was the metric-6 capacity sum, so no outdoor-keyed warning survives. |
| Eugene (OR) | **6,000** | `sites.max_units_total_on_site` | TOTAL | **PRESERVED** — real total on-site capacity (off-site prohibited); drives compliance metric 6 (OR). |

Verified live (2026-07-23, `dr3-vision-postgres`): `sites` holds `woodland.max_units_indoor = 3500`,
`eugene.max_units_total_on_site = 6000`, and `woodland.max_units_outdoor = 5000` (the
value the deploy's `20260806` migration retires with the column). No runtime code path
warns on the outdoor cap after Phase 5 — `metric6StorageInventory`
(`src/lib/compliance.ts`) sums `max_units_total_on_site + max_units_indoor` only, and the
COR banner (`src/app/dashboard/[site]/cor/page.tsx`) reads `max_units_indoor` only; the
remaining `outdoor` mentions in code are removal-rationale comments, not warnings.

### §B7.1 — Definitive non-program classification rule (Rick/Morena, 2026-07-23)

The FINAL word on the program vs non-program split (the MRC billing basis — billed on
PROGRAM units only). Supersedes the pre-existing implicit "explicit flag only" model.

**A mattress source is NON-program if EITHER:**

1. **Explicit list** — it is a "charging" collection site. CA (Woodland): Golden Bear,
   Monte Diablo, San Martin, Martinez, Petaluma, Sonoma, Annapolis, Healdsburg, Vasco,
   Brentwood. OR (Eugene): Roseburg (pre-existing), Recyclops.
2. **Out-of-state** — the units' GENERATED-location `state` is known and differs from the
   recycler's operating state (Woodland = CA, Eugene = OR). This is where the mattresses
   were generated, not the hauler's HQ. A NULL/blank state is UNKNOWN → falls back to the
   explicit flag only; it is never treated as out-of-state.

Default = program when neither applies.

**Implementation.** One shared pure helper `isSourceNonProgram(source, recyclerState)`
(`src/lib/inventory/source-classification.ts`); recycler state from `sites.jurisdiction`
via `recyclerStateForJurisdiction`. Both classification paths call it — the verify-gate
default split (`verify-gate.ts`) and the workbook-promotion alias resolver
(`site-alias.ts`) — so the rules never drift. `defaultProgramSplit` stays a pure
boolean→split mapping; the caller passes the effective determination. paper_bulk carries
an explicit split (no source) and has no classification point.

**Seeding.** The 10 CA + Recyclops (Eugene) are seeded `is_non_program=true`,
`site_type=collection_site`, `active_billing=false` (zero MRC invoice lines — money-safe,
matching Roseburg / the SVDP internal stores), `state` CA/OR, `is_active=true`. All 10 CA
sites are in-state, so only the explicit flag classifies them (the out-of-state rule cannot
catch an in-CA site — this is exactly why the explicit list is required). Aliases:
`Recology Sonoma`→Sonoma, `Recology Healdsburg`→Healdsburg (the only surviving MyMRC/June-
workbook variants; Golden Bear appears verbatim). Idempotent migration
`20260809_adr0037_nonprogram_charging_sources` + seed parity
(`seedNonProgramChargingSources` / `NONPROGRAM_CHARGING_SOURCES`). Applied LIVE to PROD in
one transaction with an `audit_log` row per insert (`actor_label='adr-0037-nonprogram-sources'`):
this is an explicit operator directive (its own approval per the ADR-0057 D4 exception), so
these sources bypass the reconcile queue and are audited instead.

**Deferred (needs Rick's data, out of scope here):** the trans-charge BILLING setup for
these charging sites (`is_trans_charge` + canonical mileage + rate tiers) — left at the
`false` default so no false trans-charge variance rows are produced. Separately, the
unwired ADR-0057 `CA_SOURCE_DISAMBIGUATION` constant still marks Golden Bear / Recology
Sonoma / Recology Healdsburg `inCatalog:false`; it has no runtime consumer today, so there
is no dup-insert risk, but it should be reconciled (`inCatalog:true`) when that classifier
is wired.
