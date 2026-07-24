# Build Spec — MyMRC hauls → inventory INBOUND bridge (the second leg)

**Date:** 2026-07-23
**Author:** Terry (research/architecture) — for implementation by aegis
**Status:** Ready to build
**ADR:** [ADR-0059](../adr/0059-mymrc-inbound-inventory-bridge.md)
**Sibling leg:** [ADR-0058](../adr/0058-mymrc-processed-inventory-bridge-and-single-8pm-report.md) + `docs/plans/2026-07-23-mymrc-processed-inventory-bridge.md` — the PROCESSED (`Stripped`) leg. This spec mirrors it exactly; read it first.
**Relates to:** ADR-0037 (loads & inventory / running balance — the `Inbound` term), ADR-0038 + ADR-0057 (MyMRC ingestion, mirror tables, reconcile-queue write gate), ADR-0048 (workbook `import` source), `#166` (paper_bulk manager inbound path, `src/lib/loads/bulk-inbound.ts`).

---

## 0. The critical question, answered with live-DB evidence (CHAD-HQ prod, 2026-07-23)

**Question:** MyMRC hauls — are they a *schedule* (appointments, no real counts) or a *receipt* (actual delivered/received counts)? This determines whether bridged inbound is a genuine (if provisional) receipt or merely a scheduled figure.

**Answer: MyMRC records BOTH, and distinguishes them cleanly by `Status__c`. The `Delivered` state carries the ACTUAL recycler-received count.** My earlier "hauls = a schedule, not a receipt" caution is **refuted for `Status='Delivered'` rows** — those are real receipts. Bridge only `Delivered` hauls.

### The evidence (`mymrc_hauls_mirror`, 7,215 rows total)

**1. Status lifecycle is explicit — scheduled vs received is a first-class field:**

| `status` (Status__c) | rows | rows with `program_unit_count > 0` | Σ program | Σ non-program |
|---|---|---|---|---|
| **Delivered** | 7,174 | 6,956 | 645,402 | 15,356 |
| Confirmed | 35 | **0** | 0 | 0 |
| Rejected | 3 | 0 | 0 | 0 |
| Inactive | 1 | 1 | 14 | 0 |
| (null) | 2 | 0 | 0 | 0 |

`Confirmed` = a scheduled/upcoming dock appointment; its `Recycler_Program_Unit_Count__c` is **0** (not yet received/counted). `Delivered` = received; the recycler's actual count is filled in. The count field is literally named `Recycler_Program_Unit_Count__c` — the recycler's own received tally, populated on delivery.

**2. `disappeared_at` does NOT mean "soft-deleted" for hauls — it means "scrolled out of the rolling active list."** Of 7,215 rows, **7,191 are `disappeared_at`-stamped**; only ~24 are active (23 `Confirmed`, i.e. upcoming appointments, all count=0). The MyMRC haul list view is a rolling window: a haul is `Confirmed` and visible before delivery, flips to `Delivered` with its count filled, then quickly scrolls off the active list (the sample `Delivered` haul `H-135135`, delivered 2026-07-21, is `disappeared_at`-stamped but its payload `lastModifiedDate` is 2026-07-22). **The mirror retains the full `Delivered` payload with its count after it disappears.**

> **THE key divergence from the processed bridge (ADR-0058):** the processed mirror (`mymrc_processed_mirror`) keeps ALL history in its list view (982 rows, **0 disappeared**), so ADR-0058 filters `disappeared_at IS NULL`. The **hauls mirror does the opposite** — nearly everything real is `disappeared_at`-stamped. The inbound bridge therefore filters on **`status='Delivered'`** and **does NOT exclude `disappeared_at`.** Excluding it would capture almost nothing (only the ~23 active `Confirmed` rows, all count=0).

**3. Two haul types — only General is inbound:**

| `type` (among `Delivered`) | rows | Σ program | Σ non-program | Σ consumer-dropoff units |
|---|---|---|---|---|
| **General** (B2B truck delivery) | 6,182 | 629,973 | 15,356 | 57 |
| Consumer Dropoff | 992 | 15,429 | 0 | 15,022 |

`type='General'` is the B2B inbound truck delivery → **this bridge's source.** `type='Consumer Dropoff'` carries `unpaid_consumer_dropoff_units` and belongs to the SEPARATE consumer-dropoff leg (`onHand`'s `dropoffUnits`, `consumer_dropoffs` table) — **excluded here to avoid double-counting that leg** (see §5.4).

**4. Magnitude cross-validation — the two MyMRC legs reconcile:**

- Inbound (Delivered General, program): **629,973**
- Processed (Processing, program, ADR-0058): **649,428**
- Ratio 629,973 / 649,428 = **0.970** — received ≈ 97% of processed over all history. A recycler that receives ~97% of what it strips is drawing down a pre-existing inventory stock — **exactly matching the physical anchor trajectory (3,977 on 2026-06-30 → 2,483 on 2026-07-22).** The two independently-sourced MyMRC legs are internally consistent.

**5. Recent (post-anchor-relevant) Delivered General hauls are well-dated and clean** — e.g. 2026-07-20 = 5 hauls / 561 program; 2026-07-13 = 14 hauls / 1,394 program. Every recent Delivered General haul carries `docking_appointment_date` (the delivery day). Daily inbound < daily processed on these days (561 in vs 859 stripped on 07-20) — consistent net drawdown.

### Framing decision (evidence-based)

Bridge `Delivered` `General` hauls as **inbound receipts** — higher confidence than a mere schedule (they carry the recycler's actual received count), but still labeled **PROVISIONAL / unconfirmed** in the report until iPad floor-confirmation, per Bill's directive. The provisional flag is honest for two independent reasons: (a) the recycler's count is an external system's figure not yet floor-verified against physical intake, and (b) the bridged count is only as complete as the mirror's `Delivered`-capture (see §5.1 completeness watch).

### One honesty caveat you MUST carry into the design (date coverage)

Only **3,881 of 6,182** Delivered General hauls carry a `docking_appointment_date`; **2,301 have none** (their payload was list-only — `payload->'fields'` holds just `Name`; no usable delivery date anywhere in the record). **All dated Delivered General hauls fall in 2024-03-01 → 2026-07-21 — every one ≤ the 2026-07-22 anchor.** So:

- The 2,301 undated hauls are **all historical (pre-anchor) and inert for the live floor** (§3 proof). The bridge **skips hauls with no resolvable delivery date** — the historical inbound backfill is therefore **partial** (dated Delivered General hauls only). State this honestly; it changes the live floor by **exactly 0**.
- The **live/forward path is fully covered** — recent Delivered General hauls all carry `docking_appointment_date`.

---

## 1. The bridge: `mymrc_hauls_mirror` (Delivered General) → `inbound_loads`

### 1.1 Grain — per (site, delivery day) aggregate, NOT per-haul (decision + why)

`inbound_loads` is a per-load table, and it carries `external_mymrc_haul_id String? @unique` — which reads as an invitation to write one row per haul. **We deliberately do NOT do that.** The grain is **one synthesized aggregate row per (site_id, Pacific delivery day)**, exactly like the paper_bulk path (`src/lib/loads/bulk-inbound.ts`, `#166`). Reasons, in priority order:

1. **Coexistence with paper_bulk without double-count.** `onHand` sums EVERY verified inbound row for a day regardless of `load_source_type`. If MyMRC wrote per-haul rows AND a manager entered a paper_bulk aggregate for the same day, `onHand` would sum both → double-count. Per-day grain + a DB-level "one aggregate inbound row per site/day" invariant (§1.4) makes the double-count **physically impossible**, with no change to `onHand`'s money path.
2. **Bill's confirmation unit is the DAY.** "when the iPads come online we verify that data … day-to-day." Confirmation is per-day; the provisional artifact should be per-day.
3. **Mirrors ADR-0058 and paper_bulk exactly** — same aggregation, same precedence-guard shape, same Pacific-day key. One mental model across both legs.

**Money-safe key (the task's `external_mymrc_haul_id` requirement, resolved honestly):** a per-day aggregate cannot store one haul id in the singular `external_mymrc_haul_id` column. Double-count protection instead comes from **(a)** the partial unique index on `(site_id, arrived_at)` for aggregate source types (§1.4 — one row per site/day, DB-enforced) and **(b)** absolute-value SET of the day's summed counts (re-summing the same Delivered hauls yields the identical total — never an increment). Per-haul **traceability** is preserved via the mirror: the constituent hauls of any bridged day are `SELECT … FROM mymrc_hauls_mirror WHERE site_id=$s AND status='Delivered' AND type='General' AND docking_appointment_date::date=$d`. Leave `external_mymrc_haul_id` **null** on the aggregate row (a single id would misrepresent a multi-haul day). This deviation from the literal requirement is called out in ADR-0059 §Options.

### 1.2 Aggregation contract

Per `(site_id, docking_appointment_date::date)`, over `mymrc_hauls_mirror` rows where **all** of:

- `status = 'Delivered'` (the received state — the ONLY state carrying real counts),
- `type = 'General'` (B2B truck inbound; excludes `Consumer Dropoff` → separate leg, §5.4),
- `site_id IS NOT NULL`,
- `docking_appointment_date IS NOT NULL` (the delivery-day key; undated hauls are skipped per §0 — all pre-anchor, inert),

compute:

```
inbound_program     = SUM( COALESCE(program_unit_count, 0) )
inbound_non_program = SUM( COALESCE(non_program_unit_count, 0) )
inbound_total       = inbound_program + inbound_non_program
```

- Do **NOT** fall back to legacy `units` — for hauls, `units` mirrors `program_unit_count` (they are equal in the data) and there is no independent legacy signal worth a CASE branch. Program/non-program are always present on `Delivered` rows (6,956/7,174). A haul missing both counts contributes 0 to its day (harmless).
- **Consumer-dropoff safety:** the `type='General'` filter already excludes drop-off hauls, so `unpaid_consumer_dropoff_units` never enters this leg.
- `arrived_at` (the `inbound_loads` inbound key) = **Pacific-midnight instant of `docking_appointment_date::date`**, via `pacificMidnightInstantOfDayISO(dayISO(...))` — the EXACT convention `bulk-inbound.ts` uses (`inboundArrivedAt`). This is what `onHand`'s inbound window (`{ gte: inboundSince }` on `arrived_at`) and the D-3 boundary key on. A UTC-midnight instant would land one Pacific day early (see `bulk-inbound.ts` finding-3 note) — do not use it.

The bridge SETs ONLY `total_units`, `program_unit_count`, `non_program_unit_count`, `arrived_at`, `status='verified'`, `count_mode='total'`, `load_source_type='mymrc_haul'` (new enum value, §1.3). It leaves `bol_number`, `source_id`, `transporter_id`, `expected_load_id`, `external_mymrc_haul_id`, `weight_lbs`, photos/stacks, and all dock-timing fields null — this is an aggregate, never a dock capture (same discipline as paper_bulk).

### 1.3 Migration (the one genuinely-new schema need)

Unlike ADR-0058 (which reused the existing `mymrc` `RecordSource` value with no migration), this leg needs **one enum value + one index generalization**:

1. **`enum LoadSourceType` — add `mymrc_haul`.** `inbound_loads.load_source_type` is a `LoadSourceType`, not a `RecordSource`; it currently has `b2b_haul | cip_consumer | event | paper_bulk`. `mymrc_haul` is the provenance tag for a bridged provisional inbound aggregate — self-describing, distinct from a manager's `paper_bulk` and from a future per-load dock capture (`b2b_haul`). **This enum value IS the provisional-state marker** (§2) — no separate boolean column needed.
2. **Generalize the paper_bulk partial unique index** from
   `… (site_id, arrived_at) WHERE load_source_type = 'paper_bulk'`
   to
   `… (site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')`.
   This is the DB-level "at most ONE aggregate inbound row per site/day" invariant that makes the paper_bulk↔mymrc_haul double-count impossible (§1.4). Prisma has no partial-index syntax, so this lives in the migration SQL, exactly as the existing paper_bulk index does; the Prisma model keeps its `@@index([site_id, load_source_type, arrived_at])` shape marker.

No other schema change. `total_units`/`program_unit_count`/`non_program_unit_count`/`arrived_at`/`status`/`count_mode`/`load_source_type` all already exist.

### 1.4 Idempotency + precedence (money-safe) — the exact conflict handling

**Precedence: iPad-confirmed (future per-load capture) > manual `paper_bulk` > `mymrc_haul` provisional.** The bridge writes/updates ONLY rows it owns (`load_source_type='mymrc_haul'`) and never writes a day that already has a higher-precedence aggregate row (`paper_bulk`). Concretely, per aggregated day:

```sql
-- Guard read (same tx): does a higher-precedence aggregate already own this day?
SELECT 1 FROM inbound_loads
 WHERE site_id = $siteId AND arrived_at = $pacificMidnight
   AND load_source_type = 'paper_bulk'      -- manager/confirmed override owns the day
 LIMIT 1;
-- If found → SKIP (skippedGuarded++). The generalized unique index (§1.3) would also
-- reject the insert, but the explicit guard keeps it a clean no-op, not a caught error.

-- Else upsert the mymrc_haul aggregate for the day (absolute SET, never increment):
INSERT INTO inbound_loads
  (id, site_id, load_source_type, status, count_mode, arrived_at,
   total_units, program_unit_count, non_program_unit_count, submitted_at, created_at, updated_at)
VALUES
  ($uuid, $siteId, 'mymrc_haul', 'verified', 'total', $pacificMidnight,
   $inboundTotal, $inboundProgram, $inboundNonProgram, now(), now(), now())
ON CONFLICT (site_id, arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')
DO UPDATE
  SET total_units            = EXCLUDED.total_units,
      program_unit_count     = EXCLUDED.program_unit_count,
      non_program_unit_count = EXCLUDED.non_program_unit_count,
      updated_at             = now()
  WHERE inbound_loads.load_source_type = 'mymrc_haul'     -- never touch a paper_bulk row
    AND ( inbound_loads.total_units            IS DISTINCT FROM EXCLUDED.total_units
       OR inbound_loads.program_unit_count     IS DISTINCT FROM EXCLUDED.program_unit_count
       OR inbound_loads.non_program_unit_count IS DISTINCT FROM EXCLUDED.non_program_unit_count )
RETURNING id, (xmax = 0) AS inserted;
```

Semantics (identical shape to ADR-0058 §1.2):

- **New day, no paper_bulk:** INSERT (`mymrc_haul`).
- **Existing `mymrc_haul` day, values changed:** UPDATE (absolute SET).
- **Existing `mymrc_haul` day, values identical:** `IS DISTINCT FROM` guard fails → **no-op** (no `updated_at` churn, no audit row). Hourly re-runs are true no-ops.
- **Existing `paper_bulk` day (manager confirmed/overrode):** the guard read skips; if it raced, `ON CONFLICT … WHERE load_source_type='mymrc_haul'` fails the predicate → **no-op, no error.** The manager row is never clobbered.

**Confirmation supersedes provisional (the reverse direction — a `bulk-inbound.ts` change aegis MUST make):** when a manager enters/updates a `paper_bulk` day via `upsertBulkInboundDay`, that transaction must **first DELETE any `mymrc_haul` row for the same `(site_id, arrived_at)`**, then upsert the paper_bulk row (writing an audit row for the delete). Without this, the generalized unique index would reject the manager's insert when a provisional row already owns the slot. This one-line-of-intent change is the write-side of the precedence contract and is part of this build (§2).

**Audit (CLAUDE.md hard rule #6):** every real INSERT/UPDATE/DELETE writes one `audit_log` row in the same `$transaction`: `action` = `insert|update|delete`, `table_name='inbound_loads'`, `row_id=<id>`, `actor_user_id=null`, `actor_label='mymrc-inbound-bridge'`, `after`/`before` = the unit counts + `load_source_type`. Guard-blocked no-ops write none.

> Generate the UUID JS-side with `randomUUID()` (as ADR-0058) — no `pgcrypto` dependency in raw SQL.

### 1.5 Module + placement (mirrors ADR-0058 §1.3 exactly)

**New bundle-safe module: `src/lib/mymrc/inbound-bridge.ts`** — compiles standalone via `tsconfig.mymrc.json`, no `@/` alias, Prisma injected (types only), same contract as `reconcile-feed.ts` / the ADR-0058 `processed-bridge.ts`:

```ts
import type { Prisma, PrismaClient } from '@prisma/client'; // TYPES only

export interface InboundBridgeContext {
  prisma: PrismaClient;
  /** Restrict to these site_ids; default = every site present in the hauls mirror. */
  siteIds?: string[];
  /** Lower bound on the delivery day (a @db.Date key). Omitted = full history (backfill).
   *  Hourly path passes today − 10 days so a tick re-aggregates only the trailing window. */
  sinceDeliveryDate?: Date;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface InboundBridgeResult {
  daysConsidered: number;
  inserted: number;
  updated: number;
  skippedGuarded: number; // paper_bulk-owned days left untouched
  unchanged: number;      // mymrc_haul days already equal
  haulsUndated: number;   // Delivered General hauls skipped for no docking_appointment_date
}

export async function bridgeInboundHaulsToInventory(
  ctx: InboundBridgeContext,
): Promise<InboundBridgeResult>;
```

Implementation shape: one `GROUP BY` `$queryRaw` over the mirror (§1.2 filter, windowed by `sinceDeliveryDate`/`siteIds`) → for each aggregated day, the §1.4 guard read + guarded upsert inside a `$transaction` with its audit row → tally buckets → one-line `log('info', …)` summary. Export from `src/lib/mymrc/index.ts` alongside `feedReconciliationQueue`.

**Cron placement — the SAME scrape-completion seam as ADR-0058, right after it.** In `scripts/mymrc-scrape.mjs`, after the `syncSite` loop + `feedReconciliationQueue` block and the ADR-0058 `bridgeProcessedToInventory` call, before `checkDeadman`:

```js
if (typeof mymrc.bridgeInboundHaulsToInventory === 'function') {
  try {
    const ir = await mymrc.bridgeInboundHaulsToInventory({ prisma, sinceDeliveryDate: recentFloor, log: logFn });
    logFn('info', `inbound-bridge — ins:${ir.inserted} upd:${ir.updated} skip:${ir.skippedGuarded} same:${ir.unchanged} undated:${ir.haulsUndated}`);
  } catch (err) {
    logFn('error', `inbound-bridge failed (non-fatal): ${describeErr(err)}`);
  }
}
```

Best-effort, non-fatal (a bridge failure never turns a good scrape into a non-zero exit). Reuse the same `recentFloor` (today − 10 days, Pacific `@db.Date` key) the processed bridge uses. Runs hourly on the existing scrape container — no new container, guaranteed ordering (mirror-fresh → bridge), self-heals every hour.

### 1.6 One-time historical backfill

Add `scripts/mymrc-inbound-bridge-backfill.mjs` (mirrors `scripts/mymrc-processed-bridge-backfill.mjs` / `scripts/mymrc-backfill.mjs`) that calls `bridgeInboundHaulsToInventory({ prisma })` with **no `sinceDeliveryDate`** (full history). Support `--dry-run` (log the tallies, roll back the transaction) and `--backfill` (commit). Run ONCE after deploy. Expected: ~3,881-days-worth of dated Delivered General hauls aggregated into Woodland `mymrc_haul` rows (fewer distinct rows than hauls — multiple hauls/day), `haulsUndated ≈ 2,301`, 0 for Eugene, 0 `skippedGuarded` (inbound_loads is empty today — verified 0 rows). **Gate it on the §3.4 invariance assertion.**

---

## 2. Confirmation state machine (Bill's "iPad confirms day-to-day")

The provisional→confirmed lifecycle is carried by `load_source_type`, **no extra column**:

| Tier | `load_source_type` | Meaning | Written by |
|---|---|---|---|
| 3 — provisional | `mymrc_haul` | MyMRC Delivered-haul counts, unconfirmed | this bridge (auto) |
| 2 — manual | `paper_bulk` | Manager entered the day from the paper log | `upsertBulkInboundDay` (`#166`) |
| 1 — confirmed | per-load dock capture (`b2b_haul` / `cip_consumer`) | iPad floor capture (future) | not built |

**Transitions:**

- **Provisional → manual/confirmed:** a manager `paper_bulk` entry (or a future iPad confirm) for a day **replaces** the `mymrc_haul` row. Enforced by (a) the generalized partial unique index (§1.3) making two aggregate rows per day impossible, and (b) the `upsertBulkInboundDay` change (§1.4) that DELETEs the `mymrc_haul` row before inserting the paper_bulk row. The bridge, seeing a higher-precedence row on its next tick, leaves the day alone (`skippedGuarded`).
- **Re-scrape after confirm never overwrites:** because the day now has a `paper_bulk` (or per-load) row, the bridge's guard read + `ON CONFLICT … WHERE load_source_type='mymrc_haul'` both no-op. A later MyMRC revision cannot resurrect a provisional figure over a confirmed correction.

**Forward-compatible iPad contract (define, do NOT build):** the not-yet-built iPad floor-confirmation endpoint, when it confirms/corrects a day's inbound, MUST — in one transaction — **retire the `mymrc_haul` aggregate for that `(site_id, arrived_at)`** (delete it, or, if it writes per-load `b2b_haul` rows, delete the aggregate so the per-load rows are not double-counted against it). The contract the UI calls: "confirming day D for site S clears the provisional MyMRC aggregate for (S, D) and installs the confirmed inbound (aggregate or per-load) atomically." This is the same delete-then-write shape `upsertBulkInboundDay` will use — the iPad path reuses it.

**Visibility (honest labeling):** a day whose inbound feeds from a `mymrc_haul` row is **provisional**; the report labels it as such (§4). `load_source_type` is queryable, so `eod-inventory.ts` can derive the flag with no new column (§4.1).

---

## 3. Anchor-safety proof (backfilling historical inbound changes live `onHand(now)` by exactly 0)

Read `src/lib/inventory/running-balance.ts` — `onHand`, `anchorFlowBounds`; and `src/lib/loads/eod-inventory.ts`.

### 3.1 How the balance bounds inbound flow

`onHand(site, asOf)` picks the latest `physical` snapshot ≤ asOf as the anchor, then `anchorFlowBounds(anchor_at)` derives **`inboundSince = pacificMidnightInstantOfDayISO(dayAfter(anchorPacificDay))`** and sums verified inbound with `arrived_at ∈ { gte: inboundSince, lte: asOf }`. Inbound uses `gte` on the Pacific-midnight instant of the day AFTER the anchor's Pacific day (a physical count is the anchor day's CLOSING position, so the anchor day's own inbound is already inside the count; only strictly-later Pacific days add). Only rows with `status ∈ VERIFIED_INBOUND_STATUSES` count — the bridge writes `status='verified'`, so its rows qualify.

### 3.2 The proof

Woodland's latest anchor is **2026-07-22**, so `inboundSince = 2026-07-23 00:00 PT`. Every bridged inbound row's `arrived_at` = Pacific-midnight of a `docking_appointment_date` **≤ 2026-07-21 < 2026-07-23**, so **every backfilled row is excluded** by `{ gte: 2026-07-23-PT }`. The live `onHand(now)` reads **zero** bridged inbound. Backfilling all dated Delivered General history changes the current floor by **exactly 0.**

Only hauls delivered **strictly after 2026-07-22** (2026-07-23+) will ever add to the live floor — which is correct: post-anchor inbound *should* increase on-hand. The structural guarantee holds for every future anchor (each physical count re-baselines and excludes all prior inbound). Historical as-of windows between two anchors gain the previously-empty inbound leg (the intended data becoming available); each bracketing physical count already reconciles the drift.

### 3.3 The inbound date boundary matches the processed leg

Both legs key on the Pacific calendar day. Processed uses `production_date` (`@db.Date`, `{ gt: anchorDay }`); inbound uses `arrived_at` (a `timestamptz` at Pacific-midnight, `{ gte: dayAfter }`). `anchorFlowBounds` derives BOTH from the same anchor Pacific day so there is no same-day skew — this is the documented D-3 asymmetry fix. The bridge's `inboundArrivedAt` (Pacific-midnight of the delivery day) is exactly the value `bulk-inbound.ts` writes, so `onHand` and the EOD math treat a `mymrc_haul` row identically to a `paper_bulk` row. No `onHand` change.

### 3.4 Mandatory pre/post invariance assertion (the safety gate)

The backfill script MUST prove live-floor invariance in practice, reusing the **ADR-0058 floor-probe route** `POST /api/internal/inventory/floor-probe` (`guardInternalCron`-protected, returns `onHand(site, now)`):

1. Before backfill: record `onHand(woodland, NOW)` → `{ program, nonProgram, total }`.
2. Run the backfill.
3. After backfill: record `onHand(woodland, NOW)` again.
4. **Assert byte-identical** (`.equals()` on each `Prisma.Decimal`). Any drift ⇒ abort/roll back and page — it means a bridged row landed at/after the anchor unexpectedly (a delivery-date encoding bug) and must be investigated before go-live.

> **Dependency:** the floor-probe route is introduced by ADR-0058. If ADR-0058 ships first, reuse it verbatim. If the legs ship together or inbound-first, this build includes the same tiny route (`src/app/api/internal/inventory/floor-probe/route.ts`). Do not duplicate it if it already exists.

### 3.5 Both legs now feed the balance — expected forward behavior

`onHand = anchor(2,483) + inbound(mymrc_haul, General Delivered) + dropoffs − processed(mymrc) − wholeUnitsSold − landfilled`. From the anchor forward:

- Historically inbound program (629,973) ≈ 0.970 × processed program (649,428) → net drawdown. Post-anchor, expect the floor to **trend gently down** as processing slightly outpaces inbound, consistent with the 3,977 → 2,483 physical trajectory. This is the intended, honest forward behavior — NOT a bug. Inbound no longer leaves the floor free-falling from processed-only (ADR-0058 §5.3's caveat is now largely closed for Woodland).
- The two MyMRC legs are the same source system (the MyMRC portal), so they reconcile against each other and against the physical counts. Where they don't (a day with inbound ≫ processed or vice-versa) that is real inventory movement (stock building or drawing down), not an inconsistency.
- **Eugene:** zero haul-mirror rows (ADR-0057 C-21 Switch-Account not built) → Eugene's inbound leg stays empty, exactly as its processed leg does. Its floor stays at its last physical count. Documented, not a bug.

---

## 4. Report integration (provisional inbound must be visibly labeled)

The Daily Production Report's EOD inventory panel (`src/lib/bonus/daily-report-notifications.ts` `renderEodInventoryHtml`, fed by `getEodInventorySnapshot` in `src/lib/loads/eod-inventory.ts`) already renders healthy/stale/zero bands and a "Change from yesterday (net inbound/net outbound)" line. Inbound is already *in* the `onHand` math it shows; this leg must make the **provisional** nature visible.

### 4.1 Surface a provisional-inbound flag (no new column, no balance-math change)

Extend `EodInventorySnapshot` (in `eod-inventory.ts`) with a derived, read-only flag:

```ts
/** True when the balance's inbound for the report day (or the window since the anchor)
 *  includes any load_source_type='mymrc_haul' row — i.e. unconfirmed MyMRC-sourced inbound. */
inboundProvisional: boolean;
```

Derive it with one aggregate already available in the module's query pattern: does any `inbound_loads` row with `site_id`, `arrived_at ∈ (inbound window ≤ endOfDay)`, `status ∈ VERIFIED_INBOUND_STATUSES`, `load_source_type='mymrc_haul'` exist? (A cheap `count`/`findFirst`.) This reads the same rows `onHand` already sums — it adds no arithmetic and cannot move a billing figure.

### 4.2 Render the label

In `renderEodInventoryHtml`'s **healthy** band (and, where inbound is the only recent flow, the stale band's context), when `inboundProvisional`:

- Add a row / caption: **"Inbound: provisional — from MyMRC haul counts, pending floor confirmation."** Style it in the muted/`WARN_INK` tone already defined, NOT as confirmed truth. It sits alongside the existing "Latest physical count" and delta rows.
- Keep the existing footer honesty line (ADR-0058 §3.3): "On-hand is the reconciled floor from the last physical count plus confirmed movement since." Amend to: "…plus movement since (inbound marked *provisional* is from MyMRC haul counts, not yet floor-confirmed)."

All times Pacific-labeled (the report already does this). Once a day is confirmed (paper_bulk / iPad), its inbound is no longer `mymrc_haul` → `inboundProvisional` goes false for that day and the label drops automatically.

### 4.3 Interaction with ADR-0058's tonight-accuracy presentation

ADR-0058 §3.3 presents reconciled floor + processed-today (bonus proxy) + an estimated post-production floor. With inbound now feeding the balance, the estimate line's "inbound not yet fed" caveat is **relaxed** — inbound IS fed (provisionally). Update that caveat to: "today's stripping may not yet be in MyMRC; today's inbound is provisional from MyMRC haul counts." Do not otherwise change the ADR-0058 presentation.

---

## 5. Math-verification + test plan

Access recipe: `DBURL=$(docker exec dr3-vision-app printenv DATABASE_URL | sed -E 's/[?].*$//'); docker exec -i dr3-vision-postgres psql "$DBURL" -c "<sql>"`.

### 5.1 Post-backfill reconciliation queries (run on CHAD-HQ prod)

**R1 — bridged rows == mirror Delivered-General totals per day (must be all-zero diff):**

```sql
WITH mirror AS (
  SELECT site_id, docking_appointment_date::date d,
         SUM(COALESCE(program_unit_count,0)) prog,
         SUM(COALESCE(non_program_unit_count,0)) nprog
  FROM mymrc_hauls_mirror
  WHERE status='Delivered' AND type='General'
    AND site_id IS NOT NULL AND docking_appointment_date IS NOT NULL
  GROUP BY 1,2
)
SELECT m.site_id, m.d, m.prog, i.program_unit_count, m.nprog, i.non_program_unit_count
FROM mirror m
JOIN inbound_loads i
  ON i.site_id=m.site_id
 AND i.load_source_type='mymrc_haul'
 AND i.arrived_at = (m.d::timestamp AT TIME ZONE 'America/Los_Angeles')   -- Pacific-midnight instant
WHERE m.prog <> i.program_unit_count OR m.nprog <> i.non_program_unit_count;  -- expect 0 rows
```

(Match `arrived_at` however `pacificMidnightInstantOfDayISO` encodes it; the intent is day-equality.)

**R2 — inbound vs processed magnitude sanity (whole-history):** bridged inbound program Σ ≈ 629,973 (dated Delivered General only); confirm against `mymrc_hauls_mirror` and note it is ~97% of processed program (649,428). Not an equality — a plausibility band.

**R3 — live-floor invariance (the money-safe gate, §3.4):** `onHand(woodland, now)` before == after backfill, byte-identical, via the floor-probe route.

**R4 — no paper_bulk/confirmed rows clobbered:** trivially true post-backfill (table empty), but assert as a standing invariant for the hourly path:

```sql
SELECT COUNT(*) FROM inbound_loads
WHERE load_source_type <> 'mymrc_haul' AND updated_at > <bridge_run_start>;  -- expect 0
```

**R5 — one aggregate inbound row per site/day (the DB invariant holds):**

```sql
SELECT site_id, arrived_at, COUNT(*) FROM inbound_loads
WHERE load_source_type IN ('paper_bulk','mymrc_haul')
GROUP BY 1,2 HAVING COUNT(*) > 1;   -- expect 0 rows (partial unique index enforces this)
```

**R6 — Eugene inbound empty:** `SELECT COUNT(*) FROM inbound_loads WHERE load_source_type='mymrc_haul' AND site_id=(SELECT id FROM sites WHERE code='eugene');` — expect 0.

**Completeness watch (state in the run notes, not a page):** the bridge is only as complete as the mirror's `Delivered`-capture. Because Delivered hauls scroll off the active list quickly, spot-check that recent daily inbound totals (R1) match a manual portal glance for 2–3 recent days after go-live. If a systematic gap appears (ingestion missing Delivered-state counts before they disappear), that is an ADR-0057 ingestion fix, not a bridge fix — but the bridge's honest label ("provisional") already covers the user-facing risk.

### 5.2 Unit tests aegis MUST add (`src/lib/mymrc/inbound-bridge.ts`, Prisma-injected)

1. **Aggregation / multi-haul day:** 3 Delivered General hauls same (site, delivery day) → one `inbound_loads` row summing program + non-program. (Recent data has up to 14 hauls/day — guard it.)
2. **Status filter:** a `Confirmed` (count=0) haul is excluded; a `Rejected` haul is excluded. ONLY `Delivered` contributes.
3. **`disappeared_at` is NOT excluded:** a `Delivered` haul with `disappeared_at` set IS summed (the inverse of the processed bridge — the key divergence). Add an explicit assertion + comment so a future reader doesn't "fix" it to match ADR-0058.
4. **Type filter:** a `Delivered` `Consumer Dropoff` haul is excluded (belongs to the dropoff leg); only `General`.
5. **Undated haul skipped:** a `Delivered` General haul with `docking_appointment_date=NULL` is skipped and counted in `haulsUndated`.
6. **Idempotency / re-run no double-count:** run twice on the same mirror → identical `inbound_loads` values, second run reports `unchanged` (no UPDATE, no audit row). Absolute SET.
7. **Precedence vs paper_bulk:** pre-seed a `paper_bulk` row for a day the mirror also covers → bridge leaves it byte-identical, counts it `skippedGuarded`, writes no audit row, and the day still has exactly ONE aggregate inbound row.
8. **Confirmation supersedes provisional:** with a `mymrc_haul` row present, `upsertBulkInboundDay` for that day DELETEs the provisional row and installs the paper_bulk row (one aggregate row remains; delete is audited). (Test lives with `bulk-inbound.ts`.)
9. **Program/non-program split mapping:** hauls program=96, non-program=0 → `program_unit_count=96`, `non_program_unit_count=0`, `total_units=96`.
10. **`arrived_at` = Pacific-midnight of delivery day:** a haul `docking_appointment_date=2026-07-20` → `arrived_at = pacificMidnightInstantOfDayISO('2026-07-20')`; boundary case proving it never crosses a Pacific day.
11. **`sinceDeliveryDate` window:** hauls before the floor are not written.
12. **Provisional label surfacing:** `getEodInventorySnapshot` returns `inboundProvisional=true` on a day fed by a `mymrc_haul` row, `false` once a `paper_bulk` row replaces it. (Test lives with `eod-inventory.ts`.)

**Anchor-boundary invariant** (add to `running-balance.test.ts` or an integration test): a `mymrc_haul` inbound row `arrived_at` on the anchor's Pacific day is **excluded** (`gte dayAfter`); one Pacific day later is **included** — proving backfill ≤ anchor is inert (mirror of the ADR-0058 processed anchor-boundary test).

### 5.3 What NOT to build here

- **Consumer-dropoff hauls** (`type='Consumer Dropoff'`, 992 Delivered, 15,022 dropoff units) — out of scope. They belong to `onHand`'s `dropoffUnits` / `consumer_dropoffs` leg. A future ADR may bridge them there; bridging them into `inbound_loads` would double-count against the CIP dropoff mechanism. The `type='General'` filter is the guard.
- **The iPad confirmation UI** — only the contract (§2).
- **Per-haul `inbound_loads` rows / `expected_loads` operational wiring** — the operational haul→expected_load→dock-capture path (ADR-0038) is a separate, iPad-era concern. This bridge is the pre-iPad provisional aggregate only.
- **No new alerting.** Inbound absence is not customer-visible and not actionable within 5 minutes (ADR-0037 gate fails Q1/Q2) — no ntfy. The existing 8pm bonus-missing ntfy (ADR-0058 §4.3) is the only daily nudge.

### 5.4 Non-program / authorization framing (holds)

The bridge only mirrors what MyMRC already recorded as `Delivered` — it reports received reality; it does not authorize any intake. It writes `inbound_loads` (the operational inflow ledger) at `status='verified'` because the recycler's Delivered count is the verify-equivalent for a paper-era aggregate (identical to how `paper_bulk` writes `verified`). It never writes `sources` (the ADR-0057 D4 reconcile-gated table) and never creates a billing line. Framing holds.

---

## 6. Documentation deliverables (MANDATORY per CLAUDE.md)

- **This spec** — `docs/plans/2026-07-23-mymrc-inbound-inventory-bridge.md`.
- **ADR-0059** — `docs/adr/0059-mymrc-inbound-inventory-bridge.md` (drafted alongside). Add its row to `docs/adr/README.md`.
- **CHANGELOG** — Unreleased "Planned — 2026-07-23 (MyMRC inbound bridge — ADR-0059, design only)" entry (drafted). aegis finalizes on merge and records the backfill R1–R6 results.
- On implementation, aegis updates CHANGELOG "Added/Changed" with the shipped commit + the migration (LoadSourceType enum + index generalization) + the backfill run's R1–R6 results.

---

## 7. Open flags / where the design corrected an assumption

1. **Hauls ARE receipts, not just schedules — for `Status='Delivered'`.** The original "don't bridge haul→inbound" caution is refuted by the data: Delivered hauls carry the recycler's actual received count (`Recycler_Program_Unit_Count__c`); Confirmed hauls carry 0. Bridge Delivered only.
2. **`disappeared_at` is inverted vs the processed leg.** Hauls scroll off a rolling list, so real Delivered hauls are almost all `disappeared_at`-stamped. The inbound bridge must NOT exclude `disappeared_at` (it filters on `status='Delivered'` instead) — the single most important divergence from ADR-0058.
3. **Per-day aggregate, not per-haul.** Required to coexist with `paper_bulk` without double-count, and matches Bill's day-to-day confirmation model. Deviates from the literal `external_mymrc_haul_id`-per-row requirement — resolved via a per-day unique index + absolute SET + mirror-based traceability (§1.1).
4. **One real migration** — `LoadSourceType += mymrc_haul` and generalize the paper_bulk partial unique index. (ADR-0058 needed none; this leg does.)
5. **Historical inbound backfill is partial** — 2,301 of 6,182 Delivered General hauls have no delivery date and are skipped. All are pre-anchor → zero effect on the live floor. Honestly stated.
6. **Consumer-dropoff hauls excluded** — they are a different leg (`dropoffUnits`); bridging them here would double-count.
7. **Eugene stays empty** — no haul-mirror rows until ADR-0057 C-21 (Switch-Account). Same as its processed leg. Not a bug.
8. **Depends on ADR-0058's floor-probe route** for the invariance gate — reuse it; include it only if inbound ships first.
