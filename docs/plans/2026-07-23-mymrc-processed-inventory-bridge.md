# Build Spec — MyMRC → inventory processed bridge + single 8pm production-report send

**Date:** 2026-07-23
**Author:** Terry (research/architecture) — for implementation by aegis
**Status:** Ready to build
**ADR:** [ADR-0058](../adr/0058-mymrc-processed-inventory-bridge-and-single-8pm-report.md)
**Relates to:** ADR-0037 (loads & inventory / running balance), ADR-0038 + ADR-0057 (MyMRC ingestion), ADR-0019 §2 / ADR-0030 (daily production report + EOD ntfy), ADR-0048 (workbook promotion / `import` source)

---

## 0. Problem statement (verified against live prod DB, CHAD-HQ, 2026-07-23)

Managers enter daily production into the bonus system (`bonus_daily_entries.mattress_count`
per employee). Woodland/Eugene **inventory on-hand never decrements from production** because
the running balance's `Stripped` leg reads `processed_units_daily`, and that table is **empty
(0 rows)** — confirmed: `select count(*) … group by source` returned zero groups.

The authoritative daily processed feed already exists and reconciles exactly with the bonus
totals:

| Source | 07-20 | 07-17 | 07-14 |
|---|---|---|---|
| `mymrc_processed_mirror` (`Processing`, not disappeared), `SUM(program_unit_count)` | 859 | 749 | 950 |
| bonus daily total | 859 | 749 | 950 |

`mymrc_processed_mirror` holds **982 `Processing` rows** (976 distinct days, 2023-01-02 →
2026-07-20), all Woodland, **0 soft-deleted** (`disappeared_at` all null). Program sum
649,428; non-program sum 6,130. It is not wired to inventory. This bridge wires it.

### Live-DB facts that shaped the design (do not re-derive — verified this session)

1. **`processed_date` is `timestamp without time zone`, stamped at NOON (12:00:00) on every
   one of the 982 rows.** Noon is TZ-stable: `processed_date::date` yields the same calendar
   day whether read as UTC or Pacific. That calendar day already equals the Pacific
   production day the bonus system keys on (proven by the reconciliation above). So
   `processed_date::date` → a `@db.Date` UTC-midnight key is the correct, drift-free mapping
   to `processed_units_daily.production_date`.
2. **Multiple mirror rows per (site, day) exist** — e.g. 2024-03-01 has 3, several days have
   2 (2025-09-30, 2025-05-15, 2025-05-14, 2025-02-27). Recent days are 1 row/day. The bridge
   **MUST aggregate (SUM) per (site, day)** — never assume 1:1.
3. **`program_unit_count` is always populated** for `Processing` rows (0 rows where it is
   null but `units` present). `units` always equals `program_unit_count` today (0 rows
   differ) and current `non_program_unit_count` is 0, **but historical non-program units are
   non-zero (all-time np sum = 6,130)** — the split is real and must be carried.
4. **`RecordSource` enum = `manual | mymrc | import`.** `mymrc` already exists — **no enum
   migration needed.** The bridge stamps `source='mymrc'`.
5. **Eugene has ZERO mirror rows.** Only the Woodland recycler context is pulled today
   (ADR-0057 OPEN-ITEM C-21, "Switch Account" not built). The bridge therefore produces
   **Woodland rows only**; Eugene's processed leg stays empty until C-21 lands. This is
   stated honestly in the report (§4) and is NOT a bug.
6. **Physical anchors (Woodland):** latest = `2026-07-22 07:00:00Z` (Pacific-midnight stamp),
   `measured`, total 2,483 (program 1,597 / non-program 886). Prior = `2026-06-30 07:00:00Z`,
   `measured`, total 3,977 (3,748 / 229). These bound the balance (§2).
7. **`bonus_daily_report_config`:** both sites `enabled=true`, `send_time_pt=20:00:00`,
   `skip_if_zero=true`, `skip_weekends=false`. **The 8pm send time is already configured.**

---

## 1. The bridge: `mymrc_processed_mirror` → `processed_units_daily`

### 1.1 Aggregation contract

Per `(site_id, processed_date::date)`, over rows where **all** of:

- `type = 'Processing'` (the daily-stripping record type; the 2 stray `type IS NULL`/
  `site_id IS NULL` rows are excluded by this filter),
- `disappeared_at IS NULL` (exclude soft-deleted / retracted portal rows),
- `site_id IS NOT NULL`,
- `processed_date IS NOT NULL` (0 such rows today, but guard anyway),

compute:

```
stripped_program     = SUM( CASE WHEN program_unit_count IS NOT NULL
                                  THEN program_unit_count ELSE COALESCE(units, 0) END )
stripped_non_program = SUM( CASE WHEN program_unit_count IS NOT NULL
                                  THEN COALESCE(non_program_unit_count, 0) ELSE 0 END )
```

Rationale for the CASE: prefer the explicit program/non-program split when present (always,
today); fall back to legacy `units` as program-only ONLY when `program_unit_count` is null —
this can never double-count because the two branches are mutually exclusive. Maps directly
onto the running balance's `Stripped` pool pair (§2.3).

`production_date` = the `@db.Date` UTC-midnight key of `processed_date::date` (noon-stamp ⇒
drift-free, matches `productionDateUTC` in `src/lib/loads/processed-units.ts`).

The bridge sets ONLY `stripped_program`, `stripped_non_program`, `source='mymrc'`, and (on
insert) `production_date`, `site_id`. It leaves `saved_units` **null** (saved-units is a
manager/workbook concept subtracted from the non-program pool per ADR-0037; the mirror has no
such field, and the live floor does not subtract saved units anyway — `onHand` omits
`savedUnits`). It leaves `material_ticket_number`, `employees_count`, `processors_count`,
`pocketcoil_estimate`, `entered_by`, `closed_at`, `notes` untouched/null.

### 1.2 Idempotency + precedence (money-safe) — the exact conflict SQL

Precedence rule, explicit: **a manual close or a workbook import always wins.** The bridge
writes/updates ONLY rows it owns (`source='mymrc'`) and never a row that is manually closed.
Concretely, the bridge write is a single atomic upsert per day with a guarded `ON CONFLICT`:

```sql
INSERT INTO processed_units_daily
  (id, site_id, production_date, stripped_program, stripped_non_program, source, created_at, updated_at)
VALUES
  (gen_random_uuid(), $siteId, $productionDate, $strippedProgram, $strippedNonProgram, 'mymrc', now(), now())
ON CONFLICT (site_id, production_date) DO UPDATE
  SET stripped_program     = EXCLUDED.stripped_program,
      stripped_non_program = EXCLUDED.stripped_non_program,
      updated_at           = now()
  WHERE processed_units_daily.source   = 'mymrc'          -- never touch manual/import rows
    AND processed_units_daily.closed_at IS NULL           -- never touch a closed day
    AND ( processed_units_daily.stripped_program     IS DISTINCT FROM EXCLUDED.stripped_program
       OR processed_units_daily.stripped_non_program IS DISTINCT FROM EXCLUDED.stripped_non_program )
RETURNING id, (xmax = 0) AS inserted;   -- xmax=0 ⇒ INSERT path; else UPDATE path
```

Semantics:

- **New day:** INSERT (`source='mymrc'`).
- **Existing `mymrc` day, values changed, not closed:** UPDATE.
- **Existing `mymrc` day, values identical:** the `IS DISTINCT FROM` guard fails → **no-op**,
  zero rows returned. Re-running the bridge hourly is a true no-op (no `updated_at` churn, no
  audit spam).
- **Existing `manual` or `import` day, OR any closed day:** the `WHERE` guard fails → **no-op,
  no error.** The human row is preserved verbatim. `ON CONFLICT … DO UPDATE … WHERE` that
  fails simply does nothing — the manager's close is never clobbered.

The writer SETs absolute aggregated values (never increments), so it is inherently
double-count-proof even independent of the `IS DISTINCT FROM` guard (that guard only
suppresses no-op churn).

**Audit (CLAUDE.md hard rule #6):** wrap each affected-day write in a `$transaction` and,
when `RETURNING` yields a row (i.e. a real INSERT or UPDATE happened), write one `audit_log`
row: `action = inserted ? 'insert' : 'update'`, `table_name='processed_units_daily'`,
`row_id = <id>`, `actor_user_id = null`, `actor_label='mymrc-processed-bridge'`,
`after = { production_date, stripped_program, stripped_non_program, source:'mymrc' }`. A
guard-blocked no-op writes NO audit row (nothing changed).

> `gen_random_uuid()` requires `pgcrypto` (already available on this PG) OR generate the UUID
> in JS and pass it in — prefer JS-side `randomUUID()` to avoid the extension dependency and
> to keep the raw SQL portable. The model's `@default(uuid())` only applies to Prisma-created
> rows, not raw INSERTs.

### 1.3 Module + placement

**New module (bundle-safe): `src/lib/mymrc/processed-bridge.ts`.**

The MyMRC modules compile standalone via `tsconfig.mymrc.json` with **no `@/` alias** and
**Prisma injected** (see `src/lib/mymrc/reconcile-feed.ts` and `src/lib/mymrc/ntfy.ts` for
the pattern). The bridge follows the same contract:

```ts
import type { Prisma, PrismaClient } from '@prisma/client';   // TYPES only

export interface ProcessedBridgeContext {
  prisma: PrismaClient;
  /** Restrict to these site_ids; default = every site present in the mirror. */
  siteIds?: string[];
  /**
   * Lower bound on production_date (a @db.Date key). When omitted the bridge writes
   * the FULL history (backfill). The hourly path passes a recent floor (§1.4) so a
   * steady-state tick only re-checks the trailing window. Precedence guard makes a
   * wider window harmless, just slower.
   */
  sinceProductionDate?: Date;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface ProcessedBridgeResult {
  daysConsidered: number;
  inserted: number;
  updated: number;
  skippedGuarded: number;   // manual/import/closed days left untouched
  unchanged: number;        // mymrc days already equal
}

export async function bridgeProcessedToInventory(
  ctx: ProcessedBridgeContext,
): Promise<ProcessedBridgeResult>;
```

Implementation shape:

1. One `GROUP BY` query (`prisma.$queryRaw`) over `mymrc_processed_mirror` producing
   `(site_id, production_date, stripped_program, stripped_non_program)` per the §1.1 contract,
   filtered by `sinceProductionDate`/`siteIds` when set.
2. For each aggregated day, run the §1.2 guarded upsert (`prisma.$executeRaw` /
   `$queryRaw` for the `RETURNING`) inside a `$transaction` with its audit row.
3. Tally the result buckets; `log('info', …)` a one-line summary.

**Cron placement — reuse the existing MyMRC scrape completion (recommended; no new
container).** Wire the bridge into `scripts/mymrc-scrape.mjs` immediately after the
`syncSite` loop and `feedReconciliationQueue`, before `checkDeadman` — the exact seam
`feedReconciliationQueue` already occupies (see the `typeof mymrc.feedReconciliationQueue ===
'function'` block). Best-effort, non-fatal (a bridge failure must not turn a good scrape tick
into a non-zero exit):

```js
if (typeof mymrc.bridgeProcessedToInventory === 'function') {
  try {
    const br = await mymrc.bridgeProcessedToInventory({ prisma, sinceProductionDate: recentFloor, log: logFn });
    logFn('info', `processed-bridge — ins:${br.inserted} upd:${br.updated} skip:${br.skippedGuarded} same:${br.unchanged}`);
  } catch (err) {
    logFn('error', `processed-bridge failed (non-fatal): ${describeErr(err)}`);
  }
}
```

Export `bridgeProcessedToInventory` from `src/lib/mymrc/index.ts` (alongside
`feedReconciliationQueue`). It compiles into `dist/mymrc` at Docker build time and the `.mjs`
consumes it via `createRequire`, exactly like the rest of the bundle.

**Cadence:** hourly (the scrape runs on boot + top-of-hour via `scripts/mymrc-cron.mjs`). The
bridge runs right after the mirror is refreshed, so it is self-healing and needs no separate
schedule. This is strictly better than a standalone cron: single ordering guarantee
(mirror-fresh → bridge), no second container, no second DB pool.

**`recentFloor` for the hourly path:** pass `sinceProductionDate = today − 10 days` (Pacific
`@db.Date` key) so steady-state ticks only re-aggregate the trailing window (cheap, and the
portal can revise recent days). The **one-time full backfill** (§1.5) runs with
`sinceProductionDate` omitted.

### 1.4 One-time historical backfill

Add a small operator script `scripts/mymrc-processed-bridge-backfill.mjs` (mirrors
`scripts/mymrc-backfill.mjs`) that calls `bridgeProcessedToInventory({ prisma })` with **no
`sinceProductionDate`** (full history). Run it ONCE after deploy. Expected: 976 Woodland rows
inserted, 0 skipped-guarded (table is empty today), 0 for Eugene. **Gate it on the §2.4
invariance assertion.**

---

## 2. Anchor-safety proof (backfilling 2023→present will NOT corrupt on-hand)

Read: `src/lib/inventory/running-balance.ts` — `onHand`, `resolveAnchorPair`,
`anchorFlowBounds`; and `src/lib/loads/eod-inventory.ts` — `getEodInventorySnapshot`.

### 2.1 How the balance bounds processed flow

`onHand(siteId, asOf)`:

1. Picks the **latest `physical` snapshot with `snapshot_at ≤ asOf`** as the anchor.
2. `anchorFlowBounds(anchor.snapshot_at)` derives `dateSince = pacificDayKeyUTC(anchor_at)`
   (the anchor's Pacific `@db.Date` key). The processed window is
   `dateWindow = { gt: dateSince, lte: asOf }`.
3. `processedUnitsDaily.aggregate({ _sum: { stripped_program, stripped_non_program }, where:
   { site_id, production_date: dateWindow } })` — only rows **strictly after** the anchor's
   Pacific day are summed. A physical count is that day's CLOSING position, so its own day's
   processing is already inside the count (`gt`, not `gte`).

### 2.2 The proof

Woodland's latest anchor is **2026-07-22** (`dateSince = 2026-07-22` `@db.Date`). Every
backfilled mirror row has `processed_date::date ≤ 2026-07-20 < 2026-07-22`, so **every one is
excluded by `{ gt: 2026-07-22 }`.** The live on-hand as of today reads **zero** bridged
processed rows. Backfilling all 976 historical days changes the current floor by **exactly 0**.

Only mirror rows dated **strictly after 2026-07-22** (i.e. 2026-07-23+) will ever subtract
from the live floor — which is correct: post-anchor processing *should* decrement.

The same holds structurally for any future anchor: each physical count re-baselines the floor
and excludes all prior processing. Historical as-of computations between two consecutive
anchors (e.g. a re-sent daily report for 2026-07-10, which uses the 2026-06-30 anchor) will
now include the processed leg that was previously empty — that is the **intended** data
becoming available, and each bracketing physical count (2026-06-30 = 3,977; 2026-07-22 =
2,483) already reconciles the drift. No closed/reconciled month is corrupted: the June close
(anchored 2026-06-30, the end of June) excludes all of June's own processing, and the
workbook-promotion audit path reconciles to the workbook's own recorded numbers via
`import`-sourced rows the bridge never touches (§1.2).

### 2.3 Pool mapping is correct

`computeRunningBalance` subtracts `stripped.program` from the program pool and
`stripped.non_program` from the non-program pool independently. The bridge writes
`stripped_program = SUM(program_unit_count)` and `stripped_non_program =
SUM(non_program_unit_count)` — a 1:1 pool map onto the mirror's split. Today np=0 so all
stripping hits the program pool (the billing basis; MRC is billed on program units only),
matching reality. `saved_units` stays null, so the bridge never engages the non-program
saved-units subtraction. Anchor pools come from `resolveAnchorPair` (the 2026-07-22 anchor is
`measured`, 1,597 / 886) — unaffected by the bridge.

### 2.4 Mandatory pre/post invariance assertion (the safety gate)

The backfill script MUST prove live-floor invariance in practice:

1. Before backfill, record `onHand(woodland, NOW)` → `{program, nonProgram, total}`.
2. Run the backfill.
3. After backfill, record `onHand(woodland, NOW)` again.
4. **Assert byte-identical** (`.equals()` on each `Prisma.Decimal`). Any drift ⇒ abort/roll
   back and page — it means a bridged row landed at/after the anchor unexpectedly (a
   `processed_date` encoding bug) and must be investigated before go-live.

Because the backfill script lives Next-app-side is not required — but this assertion needs
`onHand`, which is app-side (`@/`). Implement the assertion as a tiny internal route
(`POST /api/internal/inventory/floor-probe` returning `onHand(site, now)` for a site code,
`guardInternalCron`-protected) that the backfill script calls before and after, OR run the
assertion from a one-off `tsx` invocation inside the app container. Prefer the internal-route
probe (no tsx in prod image).

---

## 3. Tonight's report accuracy + the mirror-lag problem

### 3.1 The lag

Today is 2026-07-23; the mirror is current through 2026-07-20 (it depends on the hourly
MyMRC scrape AND on portal data entry, which lags days). So **the bridge will not have a
`processed_units_daily` row for 2026-07-21/22/23 tonight.** For the live floor, only
2026-07-23 matters (anchor 2026-07-22), and it is absent.

### 3.2 What the report shows today (read `src/lib/bonus/daily-report.ts` +
`src/lib/loads/eod-inventory.ts`)

`buildDailyReport(siteId, reportDate)` returns `totalToday` (SUM of per-employee
`mattress_count` — **today's production, from the bonus system, present tonight**) and
`eodInventory = getEodInventorySnapshot(...)`. The EOD snapshot's `onHand` for 2026-07-23
sees anchor 2,483 and **zero processed-since** (mirror lag) → on-hand ≈ 2,483, delta ≈ 0. So
tonight the inventory panel shows the reconciled floor but **does not reflect today's ~800
processed** (that decrement lands days later when the mirror + bridge catch up).

### 3.3 Recommendation — honest same-day reconciliation, do NOT mutate `onHand`

Do **not** inject a bonus-derived proxy into the running balance (mixing bonus and MyMRC
sources into the authoritative floor is a money-safety hazard and would violate the
single-source-of-truth invariant in `running-balance.ts`). Instead, present three clearly
labelled facts in the report's inventory section (extend the ADR-0030 report body /
`daily-report-notifications.ts` render, not the balance math):

1. **Reconciled floor:** `2,483 as of the 2026-07-22 physical count` (the `measured` anchor —
   `eodInventory.anchor`).
2. **Processed today (production entries):** `totalToday` mattresses — sourced from the bonus
   daily total; the label states "confirmed in MyMRC in 1–3 days."
3. **Estimated floor after today's production:** `reconciledFloor − totalToday` (program
   pool) — explicitly labelled **estimate**, with the caveat "today's stripping not yet in
   MyMRC; inbound not yet fed (§5)."

This makes tonight's report **accurate** (the reconciled floor is the truth as of the last
count), **inclusive** (today's production is shown and reconciled to inventory), and
**honest** (the estimate carries its lag + inbound caveats). Once the bridge catches up
(processed row exists for a post-anchor day), the EOD `onHand` reflects it natively and the
"estimate" collapses onto the reconciled floor — no double-count because the anchor bounds it.

**Limitation to state in the report footer, verbatim intent:** "On-hand is the reconciled
floor from the last physical count plus confirmed movement since. Today's production and any
inbound loads not yet entered are not reflected in the floor number."

---

## 4. Report send consolidation → single 8pm Pacific send + missing-data ntfy (both sites)

### 4.1 Current send paths (what actually causes the multi-send)

There are **two** send paths sharing the `bonus_daily_report_log` unique `(site_id,
report_date)`:

1. **ON-SAVE (the multi-send):** `maybeSendDailyReportOnSave` (`src/lib/bonus/
   daily-report-late.ts`) fires on **every successful save** and **re-sends on content
   change** (`resend_count++`). Called from:
   - `src/app/api/bonus/entries/route.ts:141` (every daily-entry save)
   - `src/app/api/bonus/amendments/[id]/approve/route.ts:107` (amendment approval)

   Across two shifts (each saving) plus inventory-change resends, the team gets **several
   emails per day**. This is the "double send" Bill is seeing. It was made primary on
   2026-07-21 for the Eugene iPad go-live (ADR-0019 §2 / ADR-0030 amendment).

2. **SCHEDULED BACKSTOP:** `scripts/bonus-daily-report.mjs` → `POST /api/internal/bonus/
   daily-report` → `runDailyReportFire` (`src/lib/bonus/daily-report-runner.ts`), anchored
   to `send_time_pt` = **20:00 PT** (already configured for both sites). Only sends if the
   on-save path did not already claim the row.

`board-pack-digest` does **not** send the production report (verified — no
`sendDailyReport`/`processed` references). It is not a send path.

### 4.2 The change — one send at 8:00pm PT, per site

**Remove the on-save immediate send** so the 20:00 scheduled fire becomes the single send:

- Delete the two call sites: `src/app/api/bonus/entries/route.ts:141` (+ its import at :16)
  and `src/app/api/bonus/amendments/[id]/approve/route.ts:107` (+ its import at :15). Update
  the two route tests (`entries.route.test.ts` expects
  `maybeSendDailyReportOnSave toHaveBeenCalledTimes(1)` — flip to `not.toHaveBeenCalled()`;
  same in `amendments/__tests__/route.test.ts`).
- Retire `src/lib/bonus/daily-report-late.ts` and its test (no remaining callers). The LATE
  banner/`isPastScheduledSend` logic is moot once the single send is the on-time 20:00 fire.
- **No new path, no config change:** `runDailyReportFire` already fires at 20:00 PT for both
  sites, is idempotent (`bonus_daily_report_log` unique), applies `skip_if_zero`, and includes
  the EOD inventory section. `send_time_pt=20:00` is already set. The `.mjs` scheduler already
  anchors to it with the DST-correct offset-reprobe (`nextFireInstantAt`).

**Reconciliation with the 07-21 amendment:** this ADR supersedes the ADR-0019 §2 / ADR-0030
"on-save primary" amendment and returns to a single end-of-window send, per Bill's directive.
Cite it explicitly in the ADR so the reversal is traceable (do not create a third path).

**Accepted tradeoff (state honestly):** with a single 20:00 send, a production entry made
**after** 8pm does not trigger an automatic send that night (the scheduled fire already ran;
or, if the day was zero at 8pm, it was `skipped_zero`). The safety net is the 8pm missing-data
ntfy (§4.3) prompting entry before the deadline; the escape hatch is the existing operator
backfill (`POST /api/internal/bonus/daily-report` with `{ date, siteCodes, force }` — already
built, see `route.ts` `BackfillBody`). Document both in the ADR consequences.

### 4.3 Missing-data ntfy at 8pm — ALREADY BUILT; verify, don't rebuild

`scripts/bonus-eod-check.mjs` + `src/lib/bonus/eod-check.ts` (ADR-0019 §2, ADR-0028) already
implement exactly Bill's requirement:

- Fires at **20:00 PT** (`FIRE_HOUR_PT=20`), DST-correct (`nextFireInstant` offset-reprobe).
- **Per site** — iterates every site with an active bonus signature chain (Woodland + Eugene).
- **Definition of "entered":** ≥ 1 `bonus_daily_entry` for the site on the Pacific day. Zero
  entries ⇒ page; a partial day never pages (revised 2026-06-17). This is the right signal —
  managers enter production as bonus entries.
- **ntfy conforms to ADR-0036/0037:** topic `dr3-vision-system` (`NTFY_TOPIC_SYSTEM`),
  `X-Title = [DR3-Vision] No bonus entries for <site>`, `Authorization: Bearer <token>`,
  `Priority: high`, `Click = https://noc-mastercontrol.barnardhq.com/status/dr3-vision`
  (tier-3), `Tags: warning,bonus,dr3-vision`, `X-Dedup-Id = bonus-entry-missing:<site>:<YYYY-
  MM-DD>` (fires at most once/day/site), primary→`ntfy.sh` fallback
  (`bhq-fb-dr3v-system-k8m2n`), weekend/holiday skips.

**Gate check (ADR-0037 5-question):** actionable (enter the day's production) ✓; customer-
visible? no, but it is the money-basis for MRC billing and payroll — `high`, never `urgent`
(correct as built) ✓; self-heal N/A (human action) ✓; deduped per (site, day) ✓; tier-3 click
(no per-record URL for "nothing was entered") ✓. **No change required.**

Two small **optional** refinements (call in the ADR, not mandatory):

- Nudge the eod-check fire to **20:05 PT** so a right-at-8pm entry+send isn't momentarily
  flagged. (Low value: the check only pages on *zero* entries, and a zero day is
  `skipped_zero` for the report too — they already agree. Leave at 20:00 unless Bill wants
  the grace.)
- The alert title says "No bonus entries"; keep it — "bonus entries" is the entry surface
  managers use. Optionally soften body copy to "production not entered."

### 4.4 Cron config summary (Pacific, DST-correct — nothing new to schedule)

| Daemon | Fires | Mechanism |
|---|---|---|
| `dr3-vision-bonus-daily-report` (`bonus-daily-report.mjs`) | 20:00 PT / site (from `send_time_pt`) | offset-reprobe `nextFireInstantAt`; POSTs internal route → `runDailyReportFire` |
| `dr3-vision-bonus-eod-check` (`bonus-eod-check.mjs`) | 20:00 PT | offset-reprobe `nextFireInstant`; pages per site with 0 entries |
| `dr3-vision-mymrc-scrape` (`mymrc-cron.mjs` → `mymrc-scrape.mjs`) | boot + top-of-UTC-hour | hourly; now also runs the bridge (§1.3) |

All three already exist in `docker-compose.yml` (lines 269/484/539). The only compose-level
change is none — the bridge rides the existing scrape container.

---

## 5. Math-verification + test plan for the builder

### 5.1 Post-build reconciliation queries (run on CHAD-HQ prod after backfill)

Access recipe: `DBURL=$(docker exec dr3-vision-app printenv DATABASE_URL | sed -E
's/[?].*$//'); docker exec -i dr3-vision-postgres psql "$DBURL" -c "<sql>"`.

**R1 — bridged rows == mirror `Processing` totals, per day (must be all-zero diff):**

```sql
WITH mirror AS (
  SELECT site_id, processed_date::date d,
         SUM(CASE WHEN program_unit_count IS NOT NULL THEN program_unit_count ELSE COALESCE(units,0) END) prog,
         SUM(CASE WHEN program_unit_count IS NOT NULL THEN COALESCE(non_program_unit_count,0) ELSE 0 END) nprog
  FROM mymrc_processed_mirror
  WHERE type='Processing' AND disappeared_at IS NULL AND site_id IS NOT NULL AND processed_date IS NOT NULL
  GROUP BY 1,2
)
SELECT m.site_id, m.d, m.prog, p.stripped_program, m.nprog, p.stripped_non_program
FROM mirror m
JOIN processed_units_daily p
  ON p.site_id=m.site_id AND p.production_date=m.d AND p.source='mymrc'
WHERE m.prog <> p.stripped_program OR m.nprog <> p.stripped_non_program;   -- expect 0 rows
```

**R2 — bridged daily totals ≈ bonus daily totals** (spot-check recent days; exact for
07-20/07-17/07-14 = 859/749/950):

```sql
SELECT p.production_date,
       p.stripped_program + p.stripped_non_program AS bridged_total,
       (SELECT COALESCE(SUM(bde.mattress_count),0)
          FROM bonus_daily_entries bde
          JOIN bonus_employees be ON be.id=bde.bonus_employee_id
         WHERE be.site_id=p.site_id AND bde.entry_date=p.production_date) AS bonus_total
FROM processed_units_daily p
WHERE p.source='mymrc' AND p.production_date >= DATE '2026-07-01'
ORDER BY 1 DESC;
```

Expect bridged ≈ bonus on days both feeds cover (small deltas allowed on days where portal
entry lags or a manager-entered day differs from MyMRC — flag any large gap).

**R3 — live-floor invariance (the money-safe gate, §2.4):** `onHand(woodland, now)` before ==
after backfill (via the internal floor-probe route). Expect identical `program`, `nonProgram`,
`total`.

**R4 — no manual/import/closed rows were clobbered:** trivially true post-backfill (table was
empty), but assert as a standing invariant for the hourly path:

```sql
SELECT COUNT(*) FROM processed_units_daily
WHERE source IN ('manual','import') AND updated_at > <bridge_run_start>;   -- expect 0
```

**R5 — no negative live floor:** `onHand(woodland, now)` and `onHand(eugene, now)` both
`program ≥ 0` and `nonProgram ≥ 0`. Tonight this holds (anchor 2026-07-22, ~0 processed-since).
Note honestly (§5.3) that without an inbound feed the computed floor trends **down** over time
until the next physical count re-anchors.

### 5.2 Unit tests aegis MUST add

For `src/lib/mymrc/processed-bridge.ts` (Prisma-injected fake or a test DB, matching the
bundle's test style):

1. **Aggregation / multi-row day:** 3 mirror rows same (site, day) → one
   `processed_units_daily` row summing program + non-program. (Guards the 2024-03-01 case.)
2. **`disappeared_at` exclusion:** a soft-deleted mirror row is not summed.
3. **`type` filter:** a non-`Processing` (or NULL-type) row is excluded.
4. **Idempotency / re-run no double-count:** run the bridge twice on the same mirror →
   identical `processed_units_daily` values, second run reports `unchanged` (no UPDATE, no
   audit row). (SETs absolute values; asserts no increment.)
5. **Precedence vs manual close:** pre-seed a `source='manual'` row (or a `closed_at`-set
   row) for a day the mirror also covers → bridge leaves it byte-identical, counts it
   `skippedGuarded`, writes no audit row.
6. **Precedence vs import:** same for a `source='import'` row (ADR-0048 workbook).
7. **Program/non-program split mapping:** a mirror row with `program_unit_count=800`,
   `non_program_unit_count=25` → `stripped_program=800`, `stripped_non_program=25`.
8. **Legacy `units` fallback:** a row with `program_unit_count=NULL`, `units=500` →
   `stripped_program=500`, `stripped_non_program=0` (no double-count with `units`).
9. **`processed_date` noon-key → Pacific `@db.Date`:** a mirror row `processed_date =
   2026-07-20 12:00:00` maps to `production_date = 2026-07-20T00:00:00.000Z`. Add a boundary
   case proving noon never crosses a Pacific day.
10. **`sinceProductionDate` window:** rows before the floor are not written.

For the anchor-boundary invariant (already covered by `running-balance.test.ts`, but add one
bridge-specific case to `src/lib/inventory/running-balance.test.ts` or a new integration
test): a processed row dated exactly the anchor's Pacific day is **excluded** (`gt`), a row
one Pacific day later is **included** — proving backfill ≤ anchor is inert.

For the send consolidation: update `entries.route.test.ts` and
`amendments/__tests__/route.test.ts` to assert the on-save send is **not** called; keep
`daily-report-runner`'s existing scheduled-fire tests (the single send path) green.

### 5.3 Inbound dependency — state honestly, do NOT build

Processed is only the `Stripped` leg. Without an inbound feed (`inbound_loads` verified
program/non-program), the running balance trends low between physical counts — each
`Stripped`/sold/landfilled subtracts, nothing adds except the sparse paper-bulk/dropoff rows.
The report must present on-hand as **"reconciled floor as of `<anchor date>` + confirmed
movement since,"** and flag inbound as pending (§3.3 footer). The freshness gate in
`eod-inventory.ts` (`EOD_INVENTORY_STALE_DAYS`, default 14) already switches the panel to the
"Inventory pending physical count" band once the anchor/flow ages out — so a long-drifting
floor is never presented as fact. **Do not design the inbound feed here** — only make the
report honest that on-hand is a floor, not a net position.

### 5.4 Non-program authorization framing (confirm it holds)

The bridge only **mirrors** what MyMRC already recorded as `Processing` — it reports reality;
it does not authorize processing of non-program units. It writes `processed_units_daily`
(a reporting/billing-basis table), never `sources` (the ADR-0057 D4 reconcile-queue-gated
operational table) and never auto-accepts a non-program unit for processing. Framing holds.

---

## 6. Documentation deliverables (MANDATORY per CLAUDE.md)

- **This spec** — `docs/plans/2026-07-23-mymrc-processed-inventory-bridge.md`.
- **ADR-0058** — `docs/adr/0058-mymrc-processed-inventory-bridge-and-single-8pm-report.md`
  (drafted alongside this). Add its row to `docs/adr/README.md` index.
- **CHANGELOG** — Unreleased entry drafted (see below / the ADR); aegis finalizes on merge.
- On implementation, aegis updates the CHANGELOG "Changed/Added" with the shipped commit and
  records the backfill run's R1–R5 results.

---

## 7. Open flags / where Bill's assumptions needed correction

1. **Not a literal "double send."** The unique `(site, report_date)` already prevents two
   crons both sending. The multiple emails come from the **on-save re-send on every save**
   (two shifts + inventory changes). Fix = remove on-save, keep the 20:00 scheduled send.
2. **The 8pm missing-data ntfy already exists** (`bonus-eod-check.mjs`, both sites, ADR-0036/
   0037-compliant). The work is *verify*, not *build*.
3. **`send_time_pt=20:00` is already configured** for both sites — no config change.
4. **`RecordSource` already has `mymrc`** — no enum migration; bridge stamps `source='mymrc'`
   (the spec's original `mymrc_bridge` sentinel would have needed a migration for no benefit).
5. **Eugene has zero mirror data** — the bridge is Woodland-only until ADR-0057 C-21
   ("Switch Account") lands. Eugene's report leans on bonus entries; its inventory processed
   leg stays empty. Not a bug — but must be stated so nobody reads Eugene's flat floor as a
   failure.
6. **`processed_date` is noon-stamped, not midnight** — `::date` is TZ-stable and already
   aligns to the Pacific production day. The bridge maps `processed_date::date` → `@db.Date`
   UTC-midnight key. (Had it been an arbitrary-time timestamptz, a Pacific-boundary shift
   would have been a real risk; it is not.)
7. **Multi-row mirror days are real** (historically up to 3/day) — aggregation is mandatory,
   not optional.
