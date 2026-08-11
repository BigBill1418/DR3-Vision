# ADR-0059 — MyMRC hauls → inventory INBOUND bridge (the second leg)

**Status:** Accepted (2026-07-23)
**Date:** 2026-07-23
**Sibling:** ADR-0058 (the PROCESSED / `Stripped` leg) — this is its `Inbound`-term counterpart; same patterns, one critical inversion.
**Relates to:** ADR-0037 (loads & inventory / running balance — the `Inbound` term, `inbound_loads`, `paper_bulk`), ADR-0038 + ADR-0057 (MyMRC ingestion, mirror tables, reconcile-queue write gate), ADR-0048 (workbook `import` source), `#166` (paper_bulk manager inbound path)
**Build spec:** `docs/plans/2026-07-23-mymrc-inbound-inventory-bridge.md`

> ## ⚠ SUPERSEDED ON ONE POINT BY ADR-0089 (2026-08-10)
>
> **The decision this ADR made stands. One factual premise underneath it did not.**
>
> This document keys inbound on `docking_appointment_date` and accepts a tradeoff
> (§0, §4 D4, §Consequences) that the 2,301 undated Delivered General hauls are
> "all pre-anchor and inert for the live floor", and that "the live/forward path
> is fully covered". **Both claims are false, and ADR-0089 shows why:**
>
> - `Docking_Appointment_Date__c` is a **SCHEDULING** field — populated only when
>   a haul books a dock slot. Route collections never book one, so all 886 hauls
>   carrying a `Collection_Source__c` were undated and silently skipped on the
>   LIVE path, not the historical one.
> - Those hauls were never dateless. They carry
>   `Recycler_Reported_Delivery_Date__c`, which was catalogued in our own
>   2026-07-22 Phase-0 discovery doc and requested nowhere in the code. Am.1
>   proves it populated on 12/12 Delivered hauls probed.
> - 35 **post-anchor** Delivered hauls (639 program + 1,790 non-program units,
>   133,595 lb) never reached the floor. The skip was not inert: it drove the
>   Woodland floor to −1,671.
> - `freshness.ts` keyed on the same wrong column, so the COR gate would have
>   certified a feed it could not see.
>
> **Current behaviour:** the bridge and the freshness guard both key on
> `COALESCE(recycler_reported_delivery_date, docking_appointment_date)` per
> ADR-0089 D1–D3. The appointment date is a fallback only — and per ADR-0089
> Am.1 §3 it disagrees with the true delivery by up to 6 days even when present.
>
> Nothing below is rewritten; read it as the record of what was decided on
> 2026-07-23 and why, then read ADR-0089 for what is true now.

## Context

`onHand` (`src/lib/inventory/running-balance.ts`) computes inventory as
`anchor + Inbound + dropoffs − Stripped − wholeUnitsSold − landfilled`. ADR-0058 wires the
`Stripped` leg from `mymrc_processed_mirror`. The `Inbound` leg is fed only by manual
`paper_bulk` manager entries (`#166`) and (future) iPad per-load dock captures — neither
running yet at scale — so on-hand does not rise from real intake, only fall from processing.

Bill's directive (verbatim intent): _"Inbound needs to be entered somewhere — can't you get
that from the haul count on the MyMRC portal today? I believe we already have this data on
hand. THEN when the iPads come online we verify that data for confirmation day-to-day."_ So:
**MyMRC haul counts become PROVISIONAL inbound now; iPad floor-confirmation upgrades them to
confirmed later; manual `paper_bulk` stays as fallback/override.**

The prior architectural caution was "hauls = a schedule, not a receipt — don't bridge
haul→inbound." **Resolved against the live prod DB (CHAD-HQ, 2026-07-23) — the caution is
refuted for `Status='Delivered'` hauls:**

- `mymrc_hauls_mirror` has a **`Status__c` lifecycle**: `Confirmed` (scheduled appointment,
  `Recycler_Program_Unit_Count__c` = **0**) → `Delivered` (**received; actual recycler count
  filled in**). 7,174 `Delivered` (645,402 program / 15,356 non-program) vs 35 `Confirmed`
  (all 0). Delivered hauls are **genuine receipts**, not schedules.
- **`disappeared_at` is inverted vs the processed mirror.** The haul list view is a rolling
  window; **7,191 of 7,215 rows are `disappeared_at`-stamped** (real Delivered hauls scroll
  off within a day of delivery). The processed mirror keeps all history (0 disappeared). So
  the inbound bridge filters on **`status='Delivered'`** and **does NOT exclude
  `disappeared_at`** — the single most important divergence from ADR-0058.
- **Two haul types:** `type='General'` (B2B truck inbound — 6,182 Delivered, 629,973 program)
  is this leg's source; `type='Consumer Dropoff'` (992 Delivered, 15,022 dropoff units) is a
  SEPARATE leg (`onHand`'s `dropoffUnits` / `consumer_dropoffs`) and is excluded.
- **Cross-validation:** Delivered-General inbound program (629,973) = **0.970 ×** processed
  program (649,428) — received ≈ 97% of stripped, a net drawdown matching the physical anchor
  trajectory (3,977 on 2026-06-30 → 2,483 on 2026-07-22). The two MyMRC legs reconcile.
- **Date coverage caveat:** only 3,881 of 6,182 Delivered General hauls carry a
  `docking_appointment_date` (the delivery-day key); 2,301 have none (list-only payload). All
  dated hauls are ≤ 2026-07-21 — every one ≤ the 2026-07-22 anchor. Undated hauls are skipped;
  the historical backfill is partial but **inert for the live floor** (see D4).

## Decisions

### D1 — Bridge `mymrc_hauls_mirror` (Delivered, General) → `inbound_loads`, aggregated per (site, delivery day)

A new bundle-safe module `src/lib/mymrc/inbound-bridge.ts` (Prisma injected, no `@/`, same
contract as `reconcile-feed.ts` / ADR-0058's `processed-bridge.ts`) aggregates mirror rows
where `status='Delivered' AND type='General' AND site_id IS NOT NULL AND
docking_appointment_date IS NOT NULL`, SUMMing `program_unit_count` / `non_program_unit_count`
per `(site_id, docking_appointment_date::date)`, keyed to `arrived_at` =
**Pacific-midnight of the delivery day** (`pacificMidnightInstantOfDayISO`, exactly as
`bulk-inbound.ts`). It writes `total_units` / `program_unit_count` / `non_program_unit_count`
/ `status='verified'` / `count_mode='total'` / `load_source_type='mymrc_haul'` and nothing
else. **Grain is per-day aggregate, not per-haul** (D2 rationale).

### D2 — Per-day aggregate grain (not per-haul), coexisting with `paper_bulk` via a DB-enforced single-row invariant

`onHand` sums EVERY verified inbound row for a day regardless of `load_source_type`, so a
per-haul MyMRC row plus a manager `paper_bulk` aggregate for the same day would double-count.
The grain is therefore **one synthesized aggregate row per (site, Pacific delivery day)**,
identical to `paper_bulk`. A **generalized partial unique index** —
`(site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')` — makes two
aggregate inbound rows per site/day **physically impossible**, with **no change to `onHand`'s
money path**. Bill's confirmation unit is also the day ("day-to-day"). Money-safe double-count
protection comes from this unique index + absolute-value SET (never increment); per-haul
traceability is preserved via the mirror (query by site + delivery day), so the aggregate row
leaves `external_mymrc_haul_id` null.

### D3 — Idempotent, precedence-guarded upsert (paper_bulk / confirmed always wins)

Per aggregated day: a guard read skips any day already owned by a higher-precedence
`paper_bulk` row; else an `INSERT … ON CONFLICT (site_id, arrived_at) WHERE load_source_type
IN ('paper_bulk','mymrc_haul') DO UPDATE … WHERE load_source_type='mymrc_haul' AND
values-differ`. The bridge only ever touches rows it owns (`mymrc_haul`); a `paper_bulk` row
is left byte-identical with no error; absolute SET makes re-runs double-count-proof; the
`IS DISTINCT FROM` clause suppresses no-op churn. The reverse direction is enforced in
`upsertBulkInboundDay` (`bulk-inbound.ts`): a manager entry for a day **deletes any
`mymrc_haul` row first**, then writes the `paper_bulk` row (delete audited) — confirmation
supersedes provisional. Every real write emits an `audit_log` row
(`actor_label='mymrc-inbound-bridge'`) in the same transaction (hard rule #6).

### D4 — Provisional→confirmed state carried by `load_source_type`; one small migration

The provisional state IS `load_source_type='mymrc_haul'` (no extra column). Precedence:
iPad-confirmed per-load capture (future) > manual `paper_bulk` > `mymrc_haul` provisional. The
not-yet-built iPad confirmation endpoint's contract: confirming day D for site S must, in one
transaction, retire the `mymrc_haul` aggregate for (S, D) and install the confirmed inbound —
the same delete-then-write shape `upsertBulkInboundDay` uses. One migration is required (ADR-0058
needed none): add `mymrc_haul` to `enum LoadSourceType`, and generalize the paper_bulk partial
unique index to cover `('paper_bulk','mymrc_haul')`.

### D5 — Runs on the existing MyMRC scrape completion, hourly; anchor-safe full backfill

Invoked from `scripts/mymrc-scrape.mjs` right after ADR-0058's `bridgeProcessedToInventory`,
before `checkDeadman` — best-effort, non-fatal, same seam. Hourly path passes
`sinceDeliveryDate = today − 10 days`; a one-time `scripts/mymrc-inbound-bridge-backfill.mjs`
(`--dry-run` / `--backfill`) runs the full dated history once. Backfilling all history is
**provably inert for the live floor**: `onHand` sums inbound with `arrived_at ≥
Pacific-midnight of the day AFTER the anchor's Pacific day`; the latest Woodland anchor is
2026-07-22 and every bridged row is ≤ 2026-07-21, so **all are excluded — the current floor
changes by exactly 0.** Only post-anchor deliveries (2026-07-23+) add. Gated on a pre/post
`onHand(now)` byte-identical invariance assertion via ADR-0058's `guardInternalCron`
floor-probe route (reuse it; include it only if this leg ships first).

### D6 — Provisional inbound is honestly labeled in the report

`EodInventorySnapshot` gains a derived read-only `inboundProvisional` flag (true when the
day's balance includes a `mymrc_haul` inbound row — one cheap read of rows `onHand` already
sums, no arithmetic added). `renderEodInventoryHtml` labels such a day
**"Inbound: provisional — from MyMRC haul counts, pending floor confirmation,"** in the muted
tone, never as confirmed truth. The label drops automatically once a `paper_bulk`/iPad
confirmation replaces the provisional row. Times stay Pacific-labeled. The ADR-0058
tonight-accuracy caveat is relaxed ("inbound is provisional from MyMRC haul counts") since
inbound now feeds the balance.

## Options considered

- **Grain — (a) per-day aggregate [chosen], (b) per-haul `inbound_loads` rows keyed by
  `external_mymrc_haul_id`.** (b) matches the schema's `@unique` haul-id column and literal
  task wording, but `onHand` sums all inbound regardless of source type, so per-haul rows would
  double-count against a manager's `paper_bulk` aggregate for the same day, with no clean
  DB-level guard. (a) matches `paper_bulk`, matches Bill's day-to-day confirmation, and a
  generalized partial unique index makes double-count impossible without touching `onHand`.
  Deviation from the literal per-row `external_mymrc_haul_id` requirement is accepted; money
  safety is delivered by (site, arrived_at) uniqueness + absolute SET, traceability by the
  mirror.
- **Inbound source rows — (a) `status='Delivered'` only [chosen], (b) all hauls, (c) exclude
  `disappeared_at` (mirror ADR-0058).** (b) would count 35 zero-count `Confirmed` schedules and
  3 `Rejected`. (c) is the processed-leg pattern but INVERTED for hauls — Delivered hauls scroll
  off the rolling list and are almost all `disappeared_at`-stamped, so (c) would capture almost
  nothing. (a) captures exactly the received receipts.
- **Haul type — (a) `General` only [chosen], (b) include `Consumer Dropoff`.** (b) would
  double-count against `onHand`'s existing `dropoffUnits` / `consumer_dropoffs` leg. Consumer
  dropoffs are a separate future bridge, if any.
- **Confirmation state — (a) carried by `load_source_type` [chosen], (b) a new
  `confirmed_at`/`mymrc_provisional` column.** (a) needs no column beyond the enum value the
  provenance already requires, and precedence falls out of the unique index. (b) adds surface
  for no gain.
- **Placement — (a) hourly on scrape completion, after the processed bridge [chosen], (b)
  standalone cron, (c) on-demand from the report route.** Same rationale as ADR-0058: (a)
  reuses the scrape container, guarantees mirror-fresh→bridge ordering, self-heals hourly.
- **Backfill scope — (a) full dated history, precedence-guarded, invariance-gated [chosen],
  (b) anchor-forward only.** (a) is proven inert for the live floor and unlocks historical
  inbound for the audit the empty leg blocked; undated (all pre-anchor) hauls are skipped.

## Consequences

- Inventory on-hand finally **rises with real intake** (for post-anchor deliveries), not just
  falls with processing. Woodland's floor reflects received truck loads provisionally within
  the hour; the report reconciles inbound to inventory and labels it honestly.
- Full dated historical inbound (dated Delivered General hauls, 2024-03→2026-07) becomes
  available for the historical inventory audit — with **zero effect on the live floor** (D5
  proof + invariance gate).
- **Tradeoff (accepted):** the historical backfill is **partial** — 2,301 undated Delivered
  General hauls are skipped. All are pre-anchor, so the live floor is unaffected; historical
  as-of windows before mid-2024 under-count inbound. Stated in the report/run notes.
- **Tradeoff (accepted):** provisional inbound is an external system's count, not floor-verified
  — labeled provisional until iPad/manager confirmation. A later MyMRC re-scrape can never
  overwrite a confirmed correction (D3 precedence + unique index).
- **One migration** (LoadSourceType enum value + index generalization) — reversible; the enum
  value is additive and the index generalization only widens an existing predicate.
- **Eugene's inbound leg stays empty** until ADR-0057 C-21 (Switch-Account) — same as its
  processed leg. Documented so a flat Eugene floor is not misread.
- Money-safety: the bridge never overwrites a manager/confirmed row, never increments, is
  audited, is proven live-floor-invariant before go-live, and a DB partial unique index makes
  a per-day double-count physically impossible. It writes only `inbound_loads` (the operational
  inflow ledger), never `sources`, and creates no billing line — it mirrors received reality,
  it does not authorize intake.

## Research sources

All verified this session against the live prod DB on CHAD-HQ (`docker exec dr3-vision-postgres
psql`) and the repo at `/home/bbarnard065/DR3-Vision` (commit `9edaa0a`, `main`):
`src/lib/inventory/running-balance.ts` (`onHand`, `anchorFlowBounds`, `VERIFIED_INBOUND_STATUSES`),
`src/lib/loads/eod-inventory.ts`, `src/lib/loads/bulk-inbound.ts`, `src/lib/mymrc/{reconcile-feed,index}.ts`,
`src/lib/bonus/daily-report{,-notifications}.ts`, `scripts/mymrc-scrape.mjs`,
`prisma/schema.prisma` (`InboundLoad`, `ExpectedLoad`, `MymrcHaulsMirror`, `MymrcProcessedMirror`,
`ProcessedUnitsDaily`, `enum LoadStatus`/`LoadSourceType`/`RecordSource`), and the haul-mirror
DB probes recorded in the build spec §0 (status/type/count/date distributions, magnitude
reconciliation, sites). Sibling: ADR-0058 + `docs/plans/2026-07-23-mymrc-processed-inventory-bridge.md`.
