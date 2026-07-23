# ADR-0058 — MyMRC processed → inventory bridge + single 8pm production-report send

**Status:** Accepted (2026-07-23)
**Date:** 2026-07-23
**Relates to:** ADR-0037 (loads & inventory / running balance, `processed_units_daily` as the `Stripped` leg), ADR-0038 + ADR-0057 (MyMRC ingestion, mirror tables, single-admin auth, reconcile-queue write gate), ADR-0019 §2 / ADR-0030 (daily production report + EOD missing-entry ntfy), ADR-0048 (workbook promotion / `import` source)
**Supersedes:** the 2026-07-21 "on-save primary" amendment to ADR-0019 §2 / ADR-0030 (returns to a single end-of-window send)
**Build spec:** `docs/plans/2026-07-23-mymrc-processed-inventory-bridge.md`

## Context

Managers enter daily production into the bonus system (`bonus_daily_entries.mattress_count`).
Inventory on-hand never decrements from it because the running balance's `Stripped` leg
(`src/lib/inventory/running-balance.ts`, `onHand`) reads `processed_units_daily`, and that
table is **empty (0 rows, verified on prod 2026-07-23)**. Nothing bridges production →
inventory, so the on-hand floor is frozen at the last physical count.

The authoritative daily processed feed already exists: `mymrc_processed_mirror` holds 982
`Processing` rows (976 distinct days, 2023-01-02 → 2026-07-20, Woodland only, 0 soft-deleted),
pulled from the MyMRC Salesforce portal (ADR-0057), **with a program/non-program split**. Its
daily totals reconcile exactly with the bonus totals (07-20/07-17/07-14 = 859/749/950 on both
sides). The feed is not wired to inventory.

Separately, Bill's directive on report cadence (verbatim): *"let's not double send the
production report — let's make the one send be at 8pm so that it captures the full day. that
gives the team a chance to enter data for both shifts, and then if it's not entered by 8 we
get a ntfy that it wasn't done. do this for both sites."* Investigation shows the "double
send" is the **on-save re-send** (`maybeSendDailyReportOnSave`, made primary 2026-07-21 for
the Eugene iPad go-live) firing on every save across two shifts, not two crons racing (the
`bonus_daily_report_log` unique already prevents that).

Verified live-DB facts that constrain the design: `processed_date` is a
`timestamp without time zone` **stamped at noon** (TZ-stable `::date`, aligns to the Pacific
production day); **multiple mirror rows per (site, day)** occur historically (up to 3);
`RecordSource` already includes `mymrc`; Woodland's latest physical anchor is **2026-07-22 =
2,483** (measured, 1,597/886); **Eugene has zero mirror rows** (ADR-0057 C-21 Switch-Account
not built).

## Decisions

### D1 — Bridge `mymrc_processed_mirror` → `processed_units_daily`, aggregated per (site, day)

A new bundle-safe module `src/lib/mymrc/processed-bridge.ts` (Prisma injected, no `@/`, same
contract as `reconcile-feed.ts`) aggregates mirror rows where `type='Processing' AND
disappeared_at IS NULL AND site_id IS NOT NULL AND processed_date IS NOT NULL`, SUMMing a
mutually-exclusive per-row split (`program_unit_count` when present, else legacy `units` as
program), keyed by `processed_date::date` → `@db.Date` production_date. It writes
`stripped_program` / `stripped_non_program` / `source='mymrc'` and nothing else
(`saved_units` stays null). Aggregation is mandatory — multi-row days are real.

### D2 — Idempotent, precedence-guarded upsert (a manual close or workbook import always wins)

The write is a single atomic `INSERT … ON CONFLICT (site_id, production_date) DO UPDATE …
WHERE processed_units_daily.source='mymrc' AND closed_at IS NULL AND (values IS DISTINCT
FROM …)`. The guard means the bridge only ever touches rows it owns (`source='mymrc'`, not
closed); a `manual` / `import` / closed row is left byte-identical with no error. The writer
SETs absolute aggregated values (never increments), so re-runs cannot double-count; the
`IS DISTINCT FROM` clause suppresses no-op churn. Each real write emits an `audit_log` row
(`actor_label='mymrc-processed-bridge'`) in the same transaction (hard rule #6);
guard-blocked no-ops write none. `source='mymrc'` reuses the existing enum value — **no
migration.**

### D3 — Runs on the existing MyMRC scrape completion, hourly (no new container)

The bridge is invoked from `scripts/mymrc-scrape.mjs` right after the `syncSite` loop and
`feedReconciliationQueue`, before `checkDeadman` — best-effort, non-fatal (a bridge failure
never turns a good scrape into a non-zero exit), exactly the seam `feedReconciliationQueue`
occupies. Exported from `src/lib/mymrc/index.ts`, compiled into `dist/mymrc`. The hourly path
passes `sinceProductionDate = today − 10 days`; a one-time backfill script
(`scripts/mymrc-processed-bridge-backfill.mjs`) runs the full history once. This guarantees
ordering (mirror-fresh → bridge), adds no second DB pool, and self-heals every hour.

### D4 — Backfilling all history is provably safe for the live floor

`onHand` anchors to the latest `physical` snapshot ≤ asOf and sums processed rows with
`production_date > anchorDayKey` (`anchorFlowBounds`, `{ gt }`). Woodland's latest anchor is
2026-07-22; every backfilled row is ≤ 2026-07-20, so **every one is excluded** — backfilling
976 days changes the current floor by exactly 0. Only rows dated after the anchor (2026-07-23+)
subtract, which is correct. Historical as-of windows between two anchors gain the previously
empty processed leg (the intended data), and each bracketing physical count reconciles the
drift. The one-time backfill is **gated on a pre/post invariance assertion**:
`onHand(woodland, now)` must be byte-identical before and after (via a `guardInternalCron`
floor-probe route); any drift aborts.

### D5 — Consolidate to a single 8:00pm PT send; keep the already-built 8pm missing-data ntfy

Remove the on-save immediate send (delete the two call sites in
`src/app/api/bonus/entries/route.ts` and `src/app/api/bonus/amendments/[id]/approve/route.ts`,
retire `src/lib/bonus/daily-report-late.ts`). The scheduled `runDailyReportFire`
(`scripts/bonus-daily-report.mjs`, `send_time_pt=20:00 PT`, already configured for both sites,
DST-correct, idempotent, includes EOD inventory) becomes the **single** send. This supersedes
the 2026-07-21 on-save-primary amendment. The 8pm missing-data ntfy Bill asked for **already
exists** — `scripts/bonus-eod-check.mjs` (+ `src/lib/bonus/eod-check.ts`) fires at 20:00 PT,
per site, pages when a site has zero bonus entries (definition of "entered"), fully
ADR-0036/0037-compliant (topic `dr3-vision-system`, `[DR3-Vision]` title, Bearer token, tier-3
`/status/dr3-vision` click, `high`, dedup `bonus-entry-missing:<site>:<date>`, primary→fallback).
It is **verified, not rebuilt.**

### D6 — Tonight's report stays accurate despite mirror lag, without polluting `onHand`

Because the mirror lags (through 07-20 while today is 07-23), no bridged row exists for today,
so the EOD floor shows the reconciled anchor (2,483) without today's ~800 processed. The
report presents three labelled facts — reconciled floor as of the anchor date, processed today
from the bonus daily total (with "confirmed in MyMRC in 1–3 days"), and an explicit
**estimated** floor-after-production (`floor − todayProduction`) carrying the lag + inbound
caveats — instead of injecting a bonus-derived proxy into the authoritative running balance.
On-hand is always framed as a reconciled floor plus confirmed movement, with inbound flagged
pending (no inbound feed yet; the floor trends low until re-anchored — the `EOD_INVENTORY_
STALE_DAYS` band already guards a long-drifting floor).

## Options considered

- **Bridge placement — (a) hourly on scrape completion [chosen], (b) standalone cron, (c)
  on-demand from the daily-report route.** (a) reuses the scrape container, guarantees
  mirror-fresh→bridge ordering, self-heals hourly, no new infra. (b) duplicates scheduling +
  a DB pool for no gain. (c) couples the money-safe write to a send path and only runs at 8pm.
- **Source sentinel — (a) reuse `mymrc` [chosen], (b) new `mymrc_bridge` enum value.** (a)
  needs no migration and the precedence guard is identical. (b) buys nothing and adds a
  migration.
- **Tonight's accuracy — (a) honest three-fact presentation [chosen], (b) inject a bonus
  proxy into `onHand`, (c) do nothing.** (b) violates the single-source-of-truth invariant in
  `running-balance.ts` and risks mixing bonus + MyMRC into a billing figure. (c) leaves the
  floor visibly stale/inaccurate tonight.
- **Backfill scope — (a) full history, precedence-guarded, invariance-gated [chosen], (b)
  anchor-forward only.** (a) is proven inert for the live floor and unlocks the historical
  inventory audit the empty table blocked. (b) is more conservative but discards genuine,
  safe history.
- **Send consolidation — (a) remove on-save, keep 20:00 scheduled [chosen], (b) gate on-save
  to ≥20:00.** (a) is minimal and reuses the existing, already-configured path. (b) is
  redundant with the scheduled fire and keeps a dead code path warm.

## Consequences

- Inventory on-hand finally moves with production (for post-anchor days). Woodland's floor
  decrements as the mirror confirms each day's stripping; the daily report reconciles
  production to inventory honestly.
- Full historical `processed_units_daily` (976 Woodland days) becomes available, enabling the
  previously-impossible historical inventory audit — with zero effect on the live floor
  (D4 proof + invariance gate).
- One production-report email per site per day, at 8:00pm PT, capturing both shifts. **Tradeoff
  (accepted):** a production entry made *after* 8pm does not auto-send that night; the safety
  nets are the 8pm missing-data ntfy and the existing operator backfill
  (`POST /api/internal/bonus/daily-report` with `{ date, siteCodes, force }`).
- **Eugene's processed leg stays empty** until ADR-0057 C-21 (Switch-Account) lands. Eugene's
  report leans on bonus entries; its inventory floor stays at its last physical count. Not a
  bug — documented so a flat Eugene floor is not misread.
- Money-safety: the bridge never overwrites a manual close or workbook import, never
  increments, is audited, and is proven live-floor-invariant before go-live. It writes only
  `processed_units_daily` (reporting/billing-basis), never `sources` (the ADR-0057 D4
  reconcile-gated operational table) — it mirrors recorded reality, it does not authorize
  processing.

## Research sources

All verified this session against the live prod DB on CHAD-HQ (`docker exec
dr3-vision-postgres psql`) and the repo at `/home/bbarnard065/DR3-Vision` (commit `9edaa0a`,
`main`): `src/lib/inventory/running-balance.ts`, `src/lib/loads/eod-inventory.ts`,
`src/lib/loads/processed-units.ts`, `src/lib/bonus/daily-report{,-runner,-late,-config}.ts`,
`src/lib/bonus/eod-check.ts`, `scripts/{bonus-daily-report,bonus-eod-check,mymrc-scrape,
mymrc-cron}.mjs`, `src/lib/mymrc/{sync,ntfy,reconcile-feed,index}.ts`,
`src/app/api/internal/bonus/daily-report/route.ts`, `prisma/schema.prisma`
(`ProcessedUnitsDaily`, `MymrcProcessedMirror`), and the DB probes recorded in the build spec
§0.
