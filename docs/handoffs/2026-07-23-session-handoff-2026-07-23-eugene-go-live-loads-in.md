## State of the world — 2026-07-23 (session close)

`main = 9edaa0a`. Stack verified healthy: 16 containers up, 63 migrations / 0 unfinished, 0 log errors, MyMRC sync clean. **0 open PRs.**

### Shipped + LIVE this session
- **MyMRC full ingestion (ADR-0057)** — 7,213 hauls, 100% detail-enriched via batched `getRecordWithFields` transport (#160). SOQL OFFSET-2000 truncation fixed by sort-flip (#155). `mymrc-scrape` un-gated (removed `profiles:['mymrc']`), re-auth hardened via shared `rebuildAndLogin` (#158).
- **AP Amendment 5 + 6 (ADR-0046)** — structured 4-field approve, hybrid extraction, $1K dual-approval (Eugene→Shannon), variance/history/equipment linking (#157). PDF preview reliability fixed (#165): broadened MIME gate (octet-stream/.pdf), canonical content-type echo, TTL re-mint 300→900s. **AP review is DESKTOP-only** (managers/admins Entra SSO); iPad = floor PIN, 403 on AP.
- **Ops Dashboard (ADR-0020)** — disabled tile built out + re-enabled, iPad-legible per-site + admin combined (#156).
- **Loads & Inventory (ADR-0037)** — LIVE both sites (#166). June anchored 3,977 (Rick's signed close: 3,748 prog / 229 non-prog; supersedes 4,062 which double-counted DAY23 Recology Healdsburg 85u). Current on-hand 2,483 (manager's live count 1597/886). paper_bulk inbound affordance, manager processed-units-close (Option-B: managers enter, only Bill locks), outdoor storage REMOVED, EOD inventory on Daily Production Report, D-3 Pacific-midnight anchor, D-4 unified anchor-pair. Non-program classifier: out-of-state rule + 11 seeded CA sources + 12 pre-existing Eugene (Bill-confirmed correct).
- **Bonus** — 8pm send time, total-processed footer. **Nav** — back-to-dashboard on every tile.
- **Eugene iPad go-live** — Shannon Rockwell provisioned (Entra SSO manager, 2nd approver), anthropic key wired.

### Docs reconciled
- **#167** — ADR-0057 transport addendum, ADR-0046 Amdt 6, ADR-0037, README, runbooks, ops-dashboard.
- **#168** — OPEN-ITEMS.md (O-12/C-14/O-8/S-10 marked resolved).
- CHANGELOG current.

### HONEST caveat — inventory forward-accuracy
The running-balance MATH is correct (Decimal, pool-aware, physical-anchored) but **forward accuracy depends on adoption**, not code: managers must enter inbound (via `paper_bulk`) + do daily close. Hauls feed only `expected_loads` (a schedule, not a receipt) — do NOT bridge haul→inbound. This is a process dependency, not a bug.

### Remaining — all external/operator, non-blocking
- Rick: Covanta-WTE% + Xtraction-Landfill classification, OR §7 seeds, agreed non-program pay rates ("nothing is free" — no auto-accept without agreed rate).
- Team: per-supplier non-program email reply (only affects June per-supplier DETAIL; the 229 total is already anchored).
- Pilot→production flip after Rick reconciles.
- noc-master service-registry: add `mymrc-scrape` (parked monitoring nicety).

### Money-safe invariants (do not regress)
- Manager close route has NO day-lock (only Bill's `/admin/processed-units`).
- Promotion refuses live-row overlap.
- Every inbound writer stamps `expected_load_id` / `external_mymrc_haul_id` (unique) to prevent double-count.
- Do NOT modify the manager's manual physical-count snapshot values.
- Verify the CONTAINER (`docker exec`), never just git HEAD (deployer build-races-pull trap).




---

## Continuation — 2026-07-24 (both MyMRC→inventory bridges LIVE + backfilled + verified)

**The gap flagged above ("inventory forward accuracy depends on adoption") is now CLOSED by two bridges.** Bill asked why inventory didn't come down after production was entered → root cause: `processed_units_daily` empty, bonus entries never bridged to inventory. Both legs now wired from the authoritative MyMRC data.

### PROCESSED bridge — ADR-0058, PR #170 + gate hotfix #171 (main → 6b4252b)
- `src/lib/mymrc/processed-bridge.ts`: `mymrc_processed_mirror` (type='Processing', disappeared_at IS NULL) → `processed_units_daily`, guarded upsert per (site,production_date) WHERE source='mymrc' AND closed_at IS NULL, absolute SET, `source='mymrc'` (no migration).
- **Backfill DONE:** 976 Woodland days, program 649,428 / np 6,130, **0/976 mismatch** vs mirror, 0 rows ≥ 07-22 anchor, floor 2,483 byte-identical (gate PASSED), 0 clobbered. Eugene 0 (no mirror rows).
- **Single 8pm send fixed:** the "double send" was the on-save re-send (`maybeSendDailyReportOnSave`), NOT two crons — removed + `daily-report-late.ts` deleted; `send_time_pt=20:00` both sites; `bonus-eod-check.mjs` 8pm missing-data ntfy verified.

### INBOUND bridge — ADR-0059, PR #172 (main → ad93b61)
- `src/lib/mymrc/inbound-bridge.ts`: MyMRC `mymrc_hauls_mirror` status='Delivered' AND type='General' → `inbound_loads` as PROVISIONAL (`load_source_type='mymrc_haul'`; iPad/paper_bulk confirmation supersedes via `upsertBulkInboundDay` delete). **KEY: `disappeared_at` is INVERTED for hauls** (Delivered scroll off list <1d → filter status='Delivered', do NOT exclude disappeared). Per-(site,day) AGGREGATE grain; migration `20260810` (enum `mymrc_haul` + generalized partial unique index `(site_id,arrived_at) WHERE load_source_type IN ('paper_bulk','mymrc_haul')` blocks double-count vs paper_bulk).
- **Backfill DONE:** 610 Woodland days, program 439,357 / np 0, **0/610 mismatch** vs mirror Delivered-General, floor 2,483 byte-identical, 0 double-count, Eugene 0, 2,301 undated pre-anchor hauls skipped (honest partial). Inbound ≈ 0.97 × processed → matches the real 3,977→2,483 drawdown.

### Both legs LIVE + hourly
`scripts/mymrc-scrape.mjs` runs BOTH bridges on every hourly scrape (verified live: daemon healthy, both fire each cycle). onHand forward = anchor(2,483) + inbound(mymrc) − processed(mymrc), accruing from 07-23; physical count still wins when a manager does one. Inbound labeled "provisional — pending floor confirmation".

### TWO bugs fixed en route (do not regress)
1. **Deployer was HELD, not slow** — subagents wrote ADR/plan drafts into the LIVE deploy checkout (`/host-home/DR3-Vision`), tripping the "operator local edits — deploy HELD (audit §3.5/§3.16)" dirty-tree guard. Fix = clean the checkout. **Keep agent scratch in worktrees ONLY.**
2. **floor-probe gate 307'd to /login** — the new `/api/internal/inventory/floor-probe` route was missing from `isPublic` (`src/lib/public-paths.ts`); the anchor-safety gate failed CLOSED so nothing wrote. Fixed #171 (add `/api/internal/inventory/` exemption + regression test). The ADR-0036 bug class.

### 8pm report verification (2026-07-23 fire)
- **Woodland: sent 20:00 PT exactly, 3/3, inventory `healthy 2,483`.** ✓
- **Eugene: sent 16:07 PT (transient cutover artifact — old on-save fired ~40min before the fix deployed), complete data (210 mattresses, nothing missed); 8pm daemon deduped.** Going forward on-save is gone → both sites 8pm-only (daemon evaluates both in one fire).
- Today's 07-23 inbound not yet in report (MyMRC lags ~1-2d); flows in as scraped since 07-23 > anchor.

### Tomorrow's 8pm-fire watch (armed 2026-07-23, Bill's request)
- Durable: `~/.local/bin/dr3-8pm-report-check.sh` on droneops-server (user crontab `12 3 25 7 *` = 03:12 UTC 07-25 = 20:12 PDT 07-24) → queries `bonus_daily_report_log` for report_date 2026-07-24 both sites → ntfy `dr3-vision-system` (default=both sent, high=missing) → self-removes. Survives session end.
- In-session CronCreate (03:14 UTC 07-25) re-engages to report in-channel if alive.
- Expected: both woodland+eugene delivered_count>0 @ ~20:00 PT, daemon "fire complete" shows both `sent`.

**Nothing open on this work.** PRs #170/#171/#172 merged, deployed, container-verified, math-reconciled. Bill's directive: "stand down tonight, ping tomorrow with the result."
