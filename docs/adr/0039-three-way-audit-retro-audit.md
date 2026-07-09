# ADR-0039 — 3-way audit engine + Audit Workbench + retro-audit (daily logs ↔ MyMRC ↔ billing)

**Status:** Accepted (2026-07-03, approved by Bill)
**Date:** 2026-07-03
**Relates to:** mission record §6-P1 (P1 promoted on the accepted 8/1 coverage gap), §2.2 #4, §4.1; **Addendum A §A1** (Audit Workbench) as corrected by **Addendum B §B1/§B4** (source-type categories, close model); ADR-0037 (operational tables, post-Addendum-B shape), ADR-0038 (mirror tables); survey build-inputs doc §B (`docs/operations-intel/dr3-intel-2026-06/build-inputs-2026-07-03.md`)
**Series:** third of three P1 ADRs — 0037 foundations (accepted), 0038 ingestion (accepted), **0039 audit (this)**

## Context

This module absorbs Kelsey's single biggest time cost and is the explicit condition
under which Bill accepted the 8/1 audit-coverage gap: it must ship ASAP and must
run over **any historical window** (the gap, and prior months' workbooks — §4.1
found the live workbook silently dropping money through sum-range drift). Rick's
survey answer sets the trust bar: he finds MyMRC mistakes "all the time" and will
not approve a billing package he cannot reconcile independently. The three legs are
now structurally independent: **Vision operational data** (ADR-0037 tables, entered
by staff), **MyMRC mirrors** (ADR-0038, what MRC's system believes), and **billing
data** (P2 output; until P2 ships, the historical workbooks stand in as the
billing leg).

## Decisions

### D1 — Comparators are pure functions over date-windowed legs

`src/lib/audit/` hosts one comparator per check, each a pure function of
`(window, legA rows, legB rows)` returning typed findings. Initial check set (CA
first, OR follows — same code, per-site rules):

| #   | Check                                                                                                                                                                                                                                                               | Legs               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| C1  | Inbound units: verified `inbound_loads` vs `mymrc_hauls_mirror` (by retrac/haul id, units, date)                                                                                                                                                                    | logs ↔ MyMRC       |
| C2  | Processed: `processed_units_daily` (program + non-program) vs `mymrc_processed_mirror`                                                                                                                                                                              | logs ↔ MyMRC       |
| C3  | Outbound: `outbound_materials` (all sub-categories incl. renovation) + `landfilled_units` vs `mymrc_outbound_mirror` (by ticket/material id, weight, date)                                                                                                          | logs ↔ MyMRC       |
| C4  | Billing basis: program-units-processed in window vs billed program units (P2 invoices; workbooks for historical windows)                                                                                                                                            | logs ↔ billing     |
| C5  | Program/non-program conservation: processed program units ≤ program units available (inbound program − prior processed program − program renovation outflow); renovation attribution rule (Rick Q11; renovation = outbound sub-category per B1)                     | internal invariant |
| C6  | Inventory continuity: computed running balance day-over-day vs any physical snapshot; flags the "Friday doesn't carry to Monday" class (Janette Q11)                                                                                                                | internal invariant |
| C7  | Deadline compliance: MyMRC entry lateness vs contract clocks (3-business-day inbound, 1-business-day processed, 3-day outbound weights) — **outbound lateness clock starts at EOD**, not ticket time (Janette Q1: Material # only exists at end-of-day MyMRC entry) | logs ↔ MyMRC       |

C6's continuity equation is Addendum B §B4 verbatim: `End = Start + Inbound −
Stripped − WholeUnitsSold − Landfilled`, with the non-program ledger checked
separately and `Saved` excluded until its semantics land (B10-2).

Missing-counterpart, value-mismatch, and date-mismatch are distinct finding types.
**Tolerance windows are data, not code** (per-check rows in a small
`audit_check_config`): e.g. C3 tolerates same-day gaps until EOD+1; vendor-invoice
checks (later, with P2) get a 45-day open window per Kelsey Q8 ("corrected a month
or more after").

### D2 — Findings are durable, deduplicated, and carry a life cycle

```
audit_findings(id, site_id, check_code, window_start, window_end, severity,
               finding_kind, leg_a_ref, leg_b_ref, expected jsonb, actual jsonb,
               fingerprint UNIQUE, status enum(open, acknowledged, resolved,
               not_an_issue), cause_category enum(data_entry, operational,
               external_mymrc, template_defect, unknown)?, resolution_note?,
               resolved_by?, resolved_at?, first_detected_at, last_seen_at, …audit)
```

Re-runs upsert by fingerprint (check + refs + window semantics): an unchanged
discrepancy updates `last_seen_at`, never duplicates; a corrected one auto-resolves
with `resolution_note='auto: legs now agree'`. Per Morena Q5/Q8 the review surface
shows **provenance (who entered what, when, what changed — from audit_log) and a
notes field on the finding itself**, and the `cause_category` explicitly separates
**data-entry issues from operational issues**. Findings NEVER mutate the underlying
data — fixing happens in the source records via their own audited flows.

### D3 — Scheduling: nightly sweep + on-demand windows; in-app first

Nightly cron (thin daemon → internal route, the house pattern — with the
middleware exemption + `redirect:'manual'` lesson from ADR-0036 applied on day 1)
audits a trailing window (default 14 days) per site. Any window can be run
on-demand from the review surface (manager/admin, site-scoped). Findings are
**in-app dashboard signals** (hard rule #5 — operational events never push);
the ONLY ntfy is system-level: the audit run itself failing
(`dr3-vision-system`, fingerprinted). A daily-digest email of open findings to the
CA team rides the existing M365 path (P3 formalizes thresholds/recipients).

### D4 — Retro-audit = same engine over historical windows + workbook ingestion

The comparators take windows as arguments — the "retro" part is a data problem:

- `workbook_imports` staging: an admin uploads a historical monthly workbook
  (xlsx); a parser maps the §4 tab structure into **staging rows tagged
  `import_id`** (never into operational tables). Parser must tolerate the ≥3
  template generations Janette described (calculations absent / present /
  EOD-carryover). Every parsed cell keeps its tab/row/col provenance for evidence.
- Historical checks then run logs-leg = workbook staging, MyMRC leg = mirrors
  (backfilled by an ADR-0038 historical list pull where the portal exposes
  history), billing leg = the workbook's own Summary tab — which **reproduces the
  §4.1 sum-range-drift audit**: recompute every Summary figure from the workbook's
  own detail rows and flag rows the template's ranges dropped (the fuel rows
  71–130 class → "money already dropped" report).
- **Known defects the retro-audit must reproduce** (now three named exhibits):
  the Friday→Monday carryover failure (Janette Q11); the **DAY6 broken inventory
  roll** (hardcoded 2863 instead of the prior-day formula — Addendum B §B4);
  and the **two-artifact drift** between the daily log and the billing workbook
  (June rentals $10,800 vs $10,500 — §B8; surfaced as a finding for Rick to
  classify per B10-7). The §B9 defect classes (hand-stretched SUM end-rows,
  validation windows that exclude valid values) inform parser warnings.
- **Site-name alias resolution is a precondition** for historical joins —
  ADR-0037's `source_aliases` table (B7) is the mechanism; unresolvable names
  surface as their own finding kind rather than silently dropping rows.
- **Acceptance (§7-d):** reproduces Kelsey's known June/July findings; quantifies
  the Friday→Monday carryover defect; runs over the 8/1→ship gap on demand.

### D4a — The Audit Workbench (Addendum A §A1 — the human surface)

P1 is **engine + workbench**: the engine (D1–D4) computes; the workbench is the
site-scoped surface transcribing the shortcuts Kelsey hand-built into the dynamic
daily log:

- **Category rollups** (per Addendum B §B1 — categories are load-source types,
  not unit types): inbound counts by source type (standard hauls / unpaid drop-off
  / incentive drop-off / illegal drop-off / event) as queries over
  `inbound_loads` + `consumer_dropoffs`; outbound by commodity × sub-category
  (the daily-log 9 commodities × renovation/baled/shredded). Program vs
  non-program derives from the source-site classification (B7) — the rollup
  shows both ledgers.
- **Auto outbound weight calculation** — derived display only, never entered:
  bale count × avg-per-bale from `outbound_materials`; flagged when a manual
  weight disagrees with the derivation.
- **Auto inventory rolling** — the D6 running balance (ADR-0037) rendered as a
  day-by-day ledger (prior + inbound − processed − renovator whole units),
  reconciliation deltas against physical snapshots (incl. the quarterly MRC counts)
  shown inline.
- **One-click drill-down** — every rollup cell resolves to its underlying
  slips/loads/photos (`inbound_loads` detail incl. `load_photos`, close lines,
  outbound rows) and any open `audit_findings` touching those records.

The workbench frame builds against the minimum category set now; Kelsey's full
shortcut inventory folds in as follow-up data/config when the current daily-log
file lands (Addendum A: "do not block P1 on the file").

### D5 — The billing trust gate (Rick's bar, pre-wired for P2)

A window with open findings above configurable severity **blocks the P2 invoice
generation for that window** (soft-block: super-admin override with justification,
audited — mirroring the ADR-0033 reconciliation-tripwire philosophy at the month
scale). This ADR ships the gate check function; P2 consumes it. Rick's approval
surface = the findings review for the billing window, closed out before invoices.

## Out of scope

Invoice/Summary generation (P2) · **transport rate card (P2; Addendum B §B2 corrected model:
effective-dated `transport_rate_tiers` zone table + `account_haul_rates`
overrides + per-site canonical mileage) and the rate-variance report** — but the retro-audit is designed for it: historical
transport-charged hauls will be priced under the effective-dated rate in force, so
the A3 underbilling (Stockton-era mileage, +34%→+1240% deltas) is quantifiable the
moment the rate table lands · **§A4 renovator component-only shape** (landed in
ADR-0037 D4) · rate/recovery-rate threshold alerting (P3 — C5/C6 give it the data)
· MyMRC write-back/correction (never in P1) · dispatch/Outlook reconciliation
(open register, survey §D2).

## Consequences

- The audit compares three INDEPENDENT copies of the truth; no leg feeds another
  (guaranteed by ADR-0038's mirror separation).
- Kelsey's manual audit becomes: read the findings queue, classify causes, fix
  sources — and after 8/1, the queue itself is the process (detection delay on the
  gap window, not data loss — the §2.2 #4 condition).
- Two new tables (`audit_findings`, `audit_check_config`) + `workbook_imports`
  staging; all additive.
- Historical MyMRC backfill depth depends on what the portal lists retain —
  discovery (ADR-0038 D6) reports actual depth; historical checks degrade
  gracefully to 2-leg (workbook ↔ workbook-summary) where mirrors have no history.

## Test plan (summary)

Comparator matrices per check (agree / value / missing / date; tolerance edges;
EOD clock for C7; conservation invariant C5 incl. the 150P+25NP worked example
from Rick Q11) · fingerprint dedupe + auto-resolve lifecycle · workbook parser
against fixtures for all three template generations + a synthetic sum-range-drift
workbook (must flag the dropped fuel rows) · gate function (block / override /
clean) · run-failure paging · migration clean-replay (CI).

## Post-acceptance implementation notes (2026-07-03)

Implemented on branch `feat/adr-0039-audit-engine` (engine + workbench + retro).
All gates green: typecheck 0 · eslint 0 (touched) · full vitest (1174 tests) ·
`next build` · migration clean-replays standalone on throwaway PG16.

### Dependency isolation (the load-bearing constraint)

ADR-0037 and ADR-0038 tables were NOT yet on `main` during this build. To keep
the module type-checking and building against current `main`:

- `src/lib/audit/types.ts` defines **plain TS row interfaces** for every leg
  (`InboundLegRow`, `ProcessedLegRow`, `OutboundLegRow`, `MirrorHaulRow`, …),
  shaped exactly per the sibling ADRs including their post-Addendum-B revisions
  (program/non-program splits, outbound commodity × sub-category with nullable
  `wholeUnits`, the §B4 close fields). **Comparators consume ONLY these
  interfaces** — never a sibling Prisma model.
- The DB-fetch layer that maps sibling Prisma models → these interfaces is
  `src/lib/audit/leg-fetchers.INTEGRATION-PENDING.ts`, written best-effort
  against the specced shapes but **kept out of compilation** via a
  `/* eslint-disable */` + `// @ts-nocheck` header (tsconfig's `**/*.ts` glob
  would otherwise pick it up). It is imported by nothing compiled. See the
  "INTEGRATION-PENDING" merge checklist at the top of that file.
- The nightly sweep (`src/lib/audit/sweep.ts`) takes the comparator runner via
  an **injected `runChecks` callback** so the compiled code never references a
  sibling model. Until integration, no callback is passed → the sweep is a clean
  no-op that still writes an `audit_runs` record.

### Own tables only

The migration creates **only this ADR's tables** — `audit_findings`,
`audit_check_config`, `workbook_imports`, `workbook_import_rows`, plus the
`audit_runs` ledger (needed for the "writes a run record" requirement and the
freshness/deadman surface, mirroring ADR-0038's `mymrc_sync_runs`). It references
no sibling table. It was generated with `prisma migrate diff` and then trimmed to
the additive objects only (the raw diff surfaced pre-existing drift between the
hand-written migrations and `schema.prisma` — bonus*/survey* constraint renames —
which is NOT part of this change and was excluded).

### exceljs choice

The repo had **no** xlsx library (`papaparse` is CSV-only), so `exceljs@^4.4.0`
was added as a dependency for the workbook parser. Rationale: pure-JS, actively
maintained, reads `.xlsm` by ignoring the VBA part, and can both read and write
(the test fixtures are synthesized with it, so the suite never needs the real —
and unavailable — daily-log file). Alternatives considered: `xlsx`/SheetJS (the
open-source CE build has had maintenance/security concerns and a heavier surface).

### Things discovered

- **Business-day helper reused, not reinvented**: `addBusinessDays(date, n,
holidays)` already existed in `src/lib/compliance.ts` (holiday-aware, UTC
  day-key based). C7 reuses it via thin ISO-day-key wrappers in
  `comparators/helpers.ts`.
- **Fingerprint window-independence**: record-level checks (C1/C3/C7) fingerprint
  on the record identity, NOT the window, so the same discrepancy dedupes across
  overlapping sweep windows and a later retro run — the `fingerprint UNIQUE`
  column then makes upsert-by-fingerprint the natural cross-window primitive.
- **Workbench provider is stubbed, not faked**: the three rollup frames render
  `integration_pending` empty states from a typed provider until the ADR-0037
  tables land. No fabricated data (operator directive).
- **UI is English-first** for this office super-admin surface (permitted by
  ADR-0037 consequences); the operator iPad flow is untouched.

## Post-acceptance implementation notes — integration (2026-07-03)

The engine was integrated against the now-merged ADR-0037 (loads/inventory) and
ADR-0038 (mirrors) models. `leg-fetchers.INTEGRATION-PENDING.ts` became
`leg-fetchers.ts` (compiled, wired). All gates green on this worktree's own
node_modules: `prisma generate` · `tsc --noEmit` 0 · eslint 0 (touched) · full
`vitest run` (1297 tests) · `next build` · full migration chain (…703b + …704 +
…705) clean-replays on a throwaway PG16 with **zero drift on the ADR-0039 tables**
(the 22 pre-existing bonus/mymrc/survey constraint-rename drift statements are
inherited from `main`, not this change).

### Real sibling shapes forced these comparator/fetcher adjustments

The blueprint's `select`s assumed columns that the merged schema does not have.
Reconciled as follows (each is a deliberate, documented mapping — not a silent
fallback):

- **No Vision-side "submitted to MyMRC" timestamp exists.** `inbound_loads`,
  `processed_units_daily`, and `outbound_materials` carry no submit column. The
  mirror IS the record of when MyMRC received a row, so **C7's lateness clock
  reads the matched mirror's entry instant** — `mymrc_processed_mirror.entry_date`
  / `mymrc_outbound_mirror.entry_date`, and `mymrc_hauls_mirror.first_seen_at`
  for hauls (no haul entry-date column; first-seen is the entry proxy). A Vision
  row with no mirror counterpart keeps a null instant → C7 correctly flags it
  overdue once its clock lapses. Enrichment is a cross-leg join done in
  `buildRunChecksForWindow` after the fetches.
- **`inbound_loads` has no scalar `RecordSource`** → provenance is `manual`
  (operator-entered at the dock; MyMRC feeds `expected_loads`, not
  `inbound_loads`) and the source SITE name comes from the `source` relation.
  No `verified_at` column exists (the verify transition lives in `audit_log`),
  so `verifiedAtISO` is null — unused by C1/C7.
- **`processed_units_daily` stores STRIPPED program/non-program** (Decimal), not
  `units_processed`; the total is derived. The MyMRC entry instant / date come
  from the processed mirror.
- **`mymrc_processed_mirror` has no program/non-program split** (only the program
  total `units`) → **C2's split sub-checks degrade to the total-units
  comparison** via the existing `bothPresent` guards (graceful, no false
  positives).
- **`mymrc_outbound_mirror` uses `shipment_date`, has no `ticket_number`/`units`
  columns** → the Material-# join key is `external_materials_id` (the portal
  `M-…` number the Vision outbound row carries in `ticket_number`); the mirror
  leg has no unit count.
- **`outbound_materials` has no `eod_closed_at`/submit columns** → the C7 EOD
  close clock uses `locked_at` (the day-lock instant).
- **`external_haul_id` / `external_materials_id` are nullable** until the detail
  pass → mirror rows fall back to the stable Salesforce `id` for the join key so
  C1/C2/C3 never key on null; the Re-TRAC path still matches.

### C5/C6 derivation + the C6 cross-check

C5/C6 inputs are DERIVED per-day from the operational rows, anchored at the
running balance's on-hand position at window start. Both **reuse the ONE shared
`computeRunningBalance` (ADR-0037 D6)** rather than forking a second inventory
formula: `rollInventoryDays` computes each day's End with `computeRunningBalance`
using the prior day's End as the anchor, so C6's own `Start + Inbound − Stripped
− WholeUnitsSold − Landfilled` reproduces it exactly and **live data is
continuity-clean by construction** — only the physical-count reconcile can fire
(which is the point on live data; the roll-break/DAY6 defects are workbook-only,
handled in the retro path). The cross-check requirement is met by a test asserting
the day-by-day roll's final End equals a single `computeRunningBalance` over the
summed window flows.

`InventoryDayRow` gained an **optional `npStripped`** term and `c6.computedNpEnd`
now subtracts it — the merged schema has `processed_units_daily.stripped_non_program`
(Woodland co-processes non-program units), which the pre-merge C6 didn't model;
without it, a clean live window with NP stripping would emit false NP-continuity
findings. Optional + default-0 keeps the existing fixtures/tests unchanged.

### Other wirings

- **Workbench is live** (`dbWorkbenchProvider`) over the real tables; category
  rollups follow Addendum B §B1 (source-type, not unit-type); the inventory
  ledger reuses `buildInventoryDays` (same shared balance). Empty windows render
  an honest "no activity" line — still no fabricated data. `stubWorkbenchProvider`
  is retained as the honest fallback / test double.
- **On-demand run**: `POST /api/audit/<site>/run` (site-scoped manager/admin,
  same `resolveSiteAccess` shape as the finding-transition route) runs one
  site/window through the shared `auditSiteWindow` (extracted from the sweep loop;
  `trigger = on_demand`). A window ending today keeps grace clocks; a purely
  historical window drops `asOfISO`.
- **Alias resolution**: `sourceAliasResolver(db)` reads `sources` + `source_aliases`
  once and returns a synchronous resolver (the `SiteAliasResolver` contract is
  sync) — exact canonical `Source.name` first, then the alias table, canonical
  winning a normalized-key collision. The workbook route uses it in place of the
  empty in-memory stub.
- **`Commodity` type correction**: the audit `Commodity` union was the old
  landfill/steel/biomass/wte taxonomy; corrected to the daily-log-9
  (`trash|toppers|foam|metal|wood|cardboard|plastic|shoddy|cotton`) to match the
  merged `OutboundCommodity` enum. Only used as a display label in findings; the
  two comparator test literals (`foam`, `toppers`) exist in both taxonomies.
- **Test idiom**: the repo has no test Postgres — route/DB tests use a fake
  prisma client. Integration coverage follows that idiom (`leg-fetchers.test.ts`
  drives `buildRunChecksForWindow` over a small in-memory query engine; the
  lifecycle round-trips — create / last_seen refresh / auto-resolve — remain
  covered by the pure `lifecycle.test.ts` reconciler). `site-alias.db.test.ts`
  covers the DB resolver.

## Amendment 1 — bootstrap gating (2026-07-07, incident directive §3)

Missing-counterpart checks (c4_billing_basis, m1_missing_close,
m2_missing_snapshot, and any future check whose premise is "leg empty for
window") MUST NOT emit findings for a site until (a) the leg has EVER
contained data for that site, or (b) an admin-editable per-site/per-leg
`go_live_date` has passed. Suppressed evaluations write run-ledger rows with
status `suppressed_bootstrap` — visible in admin, never silent. Existing
bootstrap findings auto-resolve with cause `bootstrap_suppression` +
provenance note (never deleted). Comparator logic untouched — the checks were
correct; the release discipline was not.

## Post-acceptance note — 2026-07-09 (read-only findings surface for accounting)

Mary Scott's survey (rollup §1.2): billing errors originate upstream of GP entry
("miss count in units or a location missed — this is in the reporting side that
I do not see") and she cannot audit them before typing an invoice. Findings are
now additionally exposed READ-ONLY at `/admin/billing/verify`
(`src/lib/invoices/verify-view.ts`): for each latest invoice, the active
findings overlapping its window plus the D5 gate verdict, rendered
green (approved + clean) / yellow (findings, or still a draft) / red (gate
blocked). Access is the new `users.can_view_billing_verify` flag —
MANAGER-ONLY with the exact `can_manage_rates` coercion discipline (hard rule
#2: operators never; cleared on any role change away from manager); site reach
on the page follows rule #2 (all_sites managers + admins see both sites, a
single-site manager only their primary). No finding lifecycle action is
reachable from that surface — resolve/classify stays on the existing audit
surfaces. The page reads the SAME finding rows it feeds the pure gate
evaluation, so the light and the listed findings can never disagree.
