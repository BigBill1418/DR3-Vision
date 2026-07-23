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
