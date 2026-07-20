# Session handoff — 2026-07-20 (MRC billing tune-and-launch execution + AP NOT-DR3)

Executes `docs/handoffs/2026-07-17-mrc-billing-tune-and-launch-rollup-2026-07-17.md` (§10 as amended by Addendum A), plus two operator asks (Rick email, AP NOT-DR3 location option). Everything below is **shipped, deployed to CHAD, and verified in prod** unless flagged otherwise.

## 1. MRC billing — five sequenced ADRs (ALL merged + deployed + prod-verified)

Dependency order held: 0037 → 0040 → 0041; 0042/0055 parallel. Each additive migration applied cleanly in prod (`_prisma_migrations`), app healthy.

| PR | ADR | What |
|----|-----|------|
| #129 | **0037** inventory foundation | Corrected June close **3,977** (3,748 program + 229 non-program). Root cause of the old buggy **4,062**: the workbook DAY-grid double-counts the DAY23 "Recology Healdsburg" 85-unit `M=NP` row that the workbook's own `F=I38−L39` accounting nets into non-program. Fix reads the authoritative **Processed-sheet ledger** (F40=19,451 / G40=229 / D40=17,126), never the re-summed grid. New: `SourceSiteType` enum, `Source.site_type/active_billing/bill_trans/bill_trailer`, `ConsumerDropoff.consumer_name/incentive_amount_cents`, `src/lib/inventory/inventory-close.ts` + `pool-routing.ts`. |
| #132 | **0040** rate infrastructure | `source_service_rates` table + `SourceServiceRateKind{trans,trailer,per_mattress,mrc_unit}` + resolvers (`resolveSiteTypeBilling`, `resolveSourceServiceRateCents`, `resolveWoodlandFreightCents`, `resolveEventMileRateCents`) in `src/lib/billing-rates/`. Did NOT create a duplicate event-mile table — the 7 CA tiers already exist as `transport_rate_tiers`. **suppress-only** `bill_trans/bill_trailer` override semantics. |
| #130 | **0042** mid-month COR | `CorPeriod{end_of_month,mid_month}`; mid-month renders inventory/FT/PT blank + skips D3 reconcile + capacity banner; version chain scoped by `(site,cover_month,period)` so mid-month & EOM never void each other. |
| #131 | **0055** (NEW) recycling rates | `recycling_rates` config (`Decimal(5,4)`, effective-dated, 3-way overlap guard) + NEW `outbound_vendors` master + derived `recycled_lbs`/`landfilled_lbs` on `outbound_materials`. Feeds CalRecycle, NOT the invoice. Seeds: Green Zone×metal=1.0, Xtraction×metal=0.81, Biomass×wood=1.0. |
| #133 | **0041** invoice-gen SIMPLIFIED | Single-line `program_units × rate + trade_discount` (commodity→invoice mapping REMOVED per §A.1). **Pilot mode** (`invoices.mode` default `pilot`, structurally cannot reach MRC — `planInvoiceDelivery` pilot branch has no MRC path + `assertProductionForMrc` tripwire). Two-line GP v2 export (v1 frozen). GP config seeded: **501 Wythe St Alexandria VA 22314, MRCL001, Sales ID 34, Net 30, DR3W**. |

Supporting PRs: **#134** (OPEN-ITEMS follow-ups), **#128** (the rollup handoff, merged for the record), **#127** (stale security-audit handoff, closed).

§10.4 verified (credit_memo/void_and_reissue already wired to Mary's approval flow). §A.11 Kelsey register closed (OPEN-ITEMS O-6). §10.5 DO-NOTs respected: no ADR-0048 D4 promotion, invoices pilot-only, zero live-customer rates seeded.

## 2. §7 OR source seeds — PARKED pending Rick (Bill's explicit call)

The rollup §7.2 seed table is **NOT reconcilable with the live system** — verified in repo (`prisma/seed/sources.csv`) AND prod DB:
- Its names (`Salem SVDP`, `Glenwood Transfer Station`, `Rifes`, `Roseburg`, `The Dalles SVDP`, `Sponsors`) ≠ the **verbatim MyMRC** names the live sources use (`Salem-Keizer Recycling Center`, `Glenwood Transfer & Recycling Station`, `Albany-Linn County Transfer Station`, `Cottage Grove Transfer Station`, `Florence Transfer Station`, `Thompsons Sanitary Service`, `Stayton Community Center`, `Deschutes`). `schema.prisma`/`seed/README.md` HARD-require verbatim names or the MyMRC reconciliation join breaks → renaming = mis-billing.
- No `Glenwood TC 143/144` split rows exist in the seed OR prod (one Glenwood source) — the "merge" premise is moot.
- `Sponsors` is a committed `consumer_dropoffs.kind`, not a source.
- per_mattress ($2.25 = 225 `satellite_collection_rate`) + OR mrc_unit ($17 = 1700 `processing_rate`) already live in `state_program_rules` where `generation-inputs.ts` reads them. `source_service_rates` (ADR-0040) has **no generator consumer yet** — seeding it is inert + duplicative.

**Recorded** as OPEN-ITEMS **S-4** (+ S-5/S-6/S-7, C-16). **UNBLOCK** = Rick's canonical name→entity mapping + a rate-model decision (keep OR rates in `state_program_rules`, current+wired, vs migrate to per-source `source_service_rates`, needs generator rewire — do BOTH together or the paths drift). §10.5 also gates live-rate seeding on Bill's go-ahead.

**Email to Rick sent 2026-07-20** (via the app Graph sender, `dr3-vision@svdp.us` → `bill.barnard@svdp.us`, status 202) asking exactly this: verbatim MyMRC names for each OR site + the Eugene hauler addresses + the Sponsors classification. It's a draft in Bill's inbox for him to review/forward.

## 3. AP portal — "NOT DR3 – See Reason" location option (#135, shipped + prod-verified)

Operator ask: a third location option on the AP approval portal beyond Woodland/Eugene. Built as a location tag orthogonal to Approve/Reject:
- Schema: `ap_requests.filed_not_dr3 Boolean @default(false)` + **partial** CHECK `NOT (filed_not_dr3=true AND site_id IS NOT NULL)`. Migration `20260728_ap_not_dr3_location` applied in prod.
- UI (`ApQueueClient.tsx`): third `<option>`; when picked, note becomes a REQUIRED reason, posts `notDr3:true` instead of a `siteId`. Field relabeled "Location".
- Route (`/api/ops/ap/[id]/decide`) + logic (`src/lib/ap/approvals.ts`): mutual-exclusion enforced 3 layers (app XOR + route 400 + DB CHECK); reason required for approve AND reject; new `ApLocationConflictError`.
- Accounting: decision email + stamped PDF render **"NOT DR3 — see reason: <note>"** in the site slot + `— NOT DR3` in the subject, so Mary never mistakes it for a DR3-site bill.
- **Live-verified**: the public client chunk `/_next/static/chunks/app/dashboard/ops/ap/page-*.js` (HTTP 200) serves all three options + the reason-required guard; `/dashboard/ops/ap` returns 307 (auth gate OK). NOT screenshot-verified (portal behind CF Access + Vision login).

**Residual flagged:** implemented as a location tag, not a distinct `ApRequestStatus` outcome. If Bill wants NOT-DR3 to be its own terminal disposition ("returned to sender"), that's a follow-up.

## 4. Open decisions / stakeholder confirmations (OPEN-ITEMS.md)

- **S-4** §7 seeds → Rick (canonical names) + Bill (rate model). Email sent; awaiting reply.
- **S-5** B7/B8 incentives + event-misc on the processing invoice → Mary/Rick (money decision; §A.7 single-line is exact only for a clean invoice, no incentives/events).
- **S-6** OR MRC Customer ID + Eugene PO suffix → Mary (seeded null, never invented).
- **S-7** Xtraction steel 0.81 vs 0.8098 (Kelsey's example implies 80.98%) + remaining wood-vendor rates → Kelsey/Morena. Seeded confirmed 0.81.
- **C-16** ADR-0040 resolvers + `source_service_rates` are forward-infra, NOT wired to `generation-inputs.ts` (still uses `resolveFreightCents` + `state_program_rules`). Couple the wiring to the S-4 rate-model decision.

## 5. Continuity / gotchas

- Corrected June oracle (close **3,977**) + the CA workbook file are still pending on titan (§11.1) — D4 June/July promotion stays blocked until they arrive.
- Deploy: swarmpilot_deployer (HSH-HQ) SSHes to CHAD, `git pull` + `docker compose up -d` builds `dr3-vision-app:local` (~14 min Playwright build), migrate gated by depends_on, then health-URL gate. No registry image. Public `/healthz` can serve a stale edge-cached uptime — verify the app container's `StartedAt` on CHAD directly.
- CI: required checks `typecheck·test·build` (incl. `next lint --max-warnings 0` — this repo has NO `argsIgnorePattern`, so `_`-prefixed unused vars FAIL; #135 tripped on this in test mocks) + `prisma migrate deploy (clean DB)`. Auto-merge OFF — poll `gh pr view <n> --json statusCheckRollup` then squash-merge.
- Worktree discipline: never move `/home/bbarnard065/DR3-Vision` HEAD (deployer reference clone); use `/tmp` worktrees; `npx prisma generate` after any schema rebase; heavy `next build` via `ssh localhost` (2.5 GB session cgroup cap). Agents hit a missing `pdf-lib` + stale Prisma client in the shared node_modules — fix in an isolated overlay, never the reference clone.
- Rebasing stacked ADR PRs: CHANGELOG.md conflicts every time (each adds an `## Added — 2026-07-18` block) — keep all blocks; schema.prisma auto-merges (disjoint models).
