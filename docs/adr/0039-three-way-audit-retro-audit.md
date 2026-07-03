# ADR-0039 — 3-way audit engine + Audit Workbench + retro-audit (daily logs ↔ MyMRC ↔ billing)

**Status:** PROPOSED — awaiting operator review (Bill)
**Date:** 2026-07-03
**Relates to:** mission record §6-P1 (P1 promoted on the accepted 8/1 coverage gap), §2.2 #4, §4.1; **Addendum A §A1/§A2** (Audit Workbench + unit categories); ADR-0037 (operational tables incl. category-quantified daily-close lines), ADR-0038 (mirror tables); survey build-inputs doc §B (`docs/operations-intel/dr3-intel-2026-06/build-inputs-2026-07-03.md`)
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

| # | Check | Legs |
|---|---|---|
| C1 | Inbound units: verified `inbound_loads` vs `mymrc_hauls_mirror` (by retrac/haul id, units, date) | logs ↔ MyMRC |
| C2 | Processed: `processed_units_daily` (program + non-program) vs `mymrc_processed_mirror` | logs ↔ MyMRC |
| C3 | Outbound: `outbound_materials`+`renovator_shipments`+`landfilled_units` vs `mymrc_outbound_mirror` (by ticket/material id, weight, date) | logs ↔ MyMRC |
| C4 | Billing basis: program-units-processed in window vs billed program units (P2 invoices; workbooks for historical windows) | logs ↔ billing |
| C5 | Program/non-program conservation: processed program units ≤ program units available (inbound program − prior processed program − program renovator outflow); renovation attribution rule (Rick Q11) | internal invariant |
| C6 | Inventory continuity: computed running balance day-over-day vs any physical snapshot; flags the "Friday doesn't carry to Monday" class (Janette Q11) | internal invariant |
| C7 | Deadline compliance: MyMRC entry lateness vs contract clocks (3-business-day inbound, 1-business-day processed, 3-day outbound weights) — **outbound lateness clock starts at EOD**, not ticket time (Janette Q1: Material # only exists at end-of-day MyMRC entry) | logs ↔ MyMRC |

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
