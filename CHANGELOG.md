# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

### Changed — 2026-07-22 (ADR-0037 D7 — Loads & Inventory GO-LIVE)
- **`loads_inventory` rollout surface flipped `pilot → live` for Woodland + Eugene** (audited, attributed to Bill). Managers/operators are now activated at both sites; the `assertLoadsInventoryActivated` gate reads this per-site surface at request time, so the change is immediate (no deploy). Reversible via the inverse flip at `/admin/rollout`.
- Both D7 ops preconditions closed: **P1-3 restore drill MET** (`d4917d0`, passed twice vs real R2 snapshot), **P1-4 RESTIC_PASSWORD off-box CONFIRMED** via the Fleet 1Password item (SHA-256 matches on-box). Reconciled the `OPEN-ITEMS.md` O-3 / `restore-drills.md` / ADR-0037 contradiction — all now CLOSED.
- Follow-up captured: `outbound.ts` `allocation_pct` semantics "pending Kelsey" (nullable, does not affect the running balance) — resolve before her 2026-08-01 departure.
### Added — 2026-07-22 (Navigation — always-visible "← Dashboard" bar across the manager surface)

Closed a long-standing navigation gap: 30 of the 57 manager-surface pages had NO
in-app path back to the Vision Dashboard (`/`) — you were forced onto the browser
Back button. Root cause: the `/bonus` and `/dashboard` route-group layouts rendered
no home nav, and `/admin/**` had no group layout at all. Fixed centrally (one shared
component wired into the three route-group layouts) rather than patching each page.

- **`src/app/_components/back-to-dashboard.tsx`** (new) — the shared nav bar. A real
  `<Link href="/">` styled to the dr3 deep-space theme (bordered pill + chevron), a
  ≥44px touch target for the floor iPads (WCAG 2.5.5), high-contrast with a persistent
  (non-hover-only) affordance and a visible focus ring. Two exports: `BackToDashboardBar`
  (presentational, explicit label — used by English-only `/admin`) and
  `BackToDashboardNav` (resolves EN/ES/UR via `useT()` — used by bonus/dashboard).
- **`src/app/bonus/layout.tsx`** + **`src/app/dashboard/layout.tsx`** — render the
  i18n nav bar at the top inside the existing `I18nProvider` (bonus keeps its
  `SiteSwitchBanner` below it).
- **`src/app/admin/layout.tsx`** (new) — first-ever `/admin` route-group layout;
  renders the bar for all ~27 admin pages. English-only per ADR-0017 (no `I18nProvider`).
- **`src/i18n/locales/{en,es,ur}/manager.json`** — new `nav.back_to_dashboard` +
  `nav.back_to_dashboard_aria` keys (CLAUDE.md hard rule #4).
- **`src/app/_components/vision-shell.tsx`** — the landing-page logo is now a
  `<Link href="/">` (aria-labelled), visually unchanged (belt-and-suspenders home path).
- Coverage: all 55 pages under `/bonus` (8), `/dashboard` (20), `/admin` (27) now reach
  `/` via the inherited layout bar; residual gapped pages = 0. Deliberately excluded:
  `/` (is the dashboard), `/login`, `/operator/**` (PIN iPad flow), `/internal/**`
  (headless PDF), `/survey/[token]` (public). Pages with their own page-level back-link
  (e.g. "← All sites") are untouched — the layout bar sits cleanly above them (different
  targets: page links go up one level, the bar goes to `/`).
- Tests: `back-to-dashboard.test.tsx` (4) + one layout test each for admin/bonus/dashboard
  asserting a link to `/`. 7 green. Verified visually with Playwright at the iPad viewport
  (768×1024): `/bonus`, `/admin/users`, `/dashboard/[site]/compliance`.

### Changed — 2026-07-22 (ADR-0057 D3 addendum — MyMRC billing-field capture: batched getRecordWithFields transport)

Replaced the racy per-record `/s/detail/<id>` navigation-interception detail fetch
(which captured ~0.4% of billing unit-counts because the billing-bearing
`getRecordWithFields` response frequently landed outside the settle window) with a
batched direct Aura POST that replays `getRecordWithFields` — ~100 record-ids per
POST — reusing the list-page framework envelope. Proven live (200 actions/POST →
200/200 SUCCESS, ~0.5 s). Transport swap only — mappers, upsert, and mirror schema
unchanged. Architecture: `scratchpad/mymrc-field-capture-architecture.md` (Terry).

- **`src/lib/mymrc/record-fields-client.ts`** (new) — the batched transport: pure
  codec (`buildGetRecordWithFieldsMessage`/`…FormFields`,
  `parseGetRecordWithFieldsResponse` correlating each action by its echoed `action.id`
  → recordId, per-action SUCCESS/ERROR isolation), the `optionalFields` sets matching
  each mapper (FLS-safe, bounded payload, incl. relationship fields like
  `Haul_Request__c.Recycling_Center_Lookup__r.Name`), and `createRecordFieldsClient`
  (bounded exponential backoff on non-200 / Aura EXCEPTION, one logged-out self-heal
  that rebuilds + re-logs-in + re-captures the envelope, then fails LOUD with
  `AuthFailedError`).
- **`src/lib/mymrc/enrich-details.ts`** (new) — `sweepTargetDetail` (the ONE shared
  batch-sweep primitive) + `enrichDetails` (whole-backlog runner). Resumable off
  `detail_fetched_at IS NULL`; a zero-SUCCESS batch or a logged-out session pages
  `dr3-vision-system` (ADR-0038 D4).
- **`src/lib/mymrc/sync.ts`** + **`backfill.ts`** — the steady-state hourly detail
  pass AND the backfill detail sweep now use the batched transport (both previously
  fetched detail per-record on a shared page — the same root-cause race). The batch
  client is built over the SAME admin session as the list client
  (`PortalClient.getSession()`), so one login still serves list + detail.
- **`scripts/mymrc-enrich-details.mjs`** (new) — one-shot backlog enrichment runner
  with a BEFORE/AFTER coverage reconciliation report.
- Tests: `record-fields-client.test.ts` (18), `enrich-details.test.ts` (9); the
  backfill/sync/scrape suites updated for the transport swap. 348 mymrc tests green.
### Added — 2026-07-22 (Bonus daily entry — total processed mattresses in the footer)

Operator (Bill) asked to see the total processed mattresses alongside the existing
dollar Day total on the Daily Bonus entry grid.

- **`src/app/bonus/DailyEntryGrid.tsx`** — the `<tfoot>` "Day total" row now shows
  the live sum of the per-employee mattress counts under the Mattresses column, next
  to the existing dollar total under the Bonus column. The sum (`totalMattresses`) is
  a `useMemo` over the same input state that drives `totalCents`, so it ticks as the
  operator types — and on the read-only/locked path too. It sums the RAW parsed
  counts (what was processed), NOT the calculator's bonus floor, so a fractional
  entry (e.g. 40.5) is reflected exactly. The figure is `font-mono` bold, right-
  aligned to match `grid-total`, carries a "mattresses" caption plus an exact
  `aria-label` (`data-testid="grid-total-mattresses"`) so it can't be mistaken for a
  dollar amount, and is iPad-legible.
- **`src/app/bonus/months/[id]/ReadOnlyGrid.tsx`** — for visual consistency, the
  locked month grid's "Total payout" footer now fills its previously-empty Mattresses
  cell with the period's total processed mattresses (column sum of each row's month
  total; `data-testid="readonly-total-mattresses"`).
- **`src/app/bonus/DailyEntryGrid.test.tsx`** — new coverage: the mattress total
  renders and equals the sum of entered counts, contributes 0 for blank inputs,
  updates live when a count changes, sums raw (not floored) fractional counts, and
  renders on the read-only path.

### Fixed — 2026-07-22 (ADR-0057 — MyMRC scrape worker: re-auth reliability + activation)

Two fixes to the hourly `mymrc-scrape` worker, surfaced once it began running
against the live portal. This feeds the billing mirror — both changes preserve the
money-safe persistence invariants.

- **`src/lib/mymrc/portal-client.ts`** — mid-run re-authentication no longer fails
  intermittently. The Salesforce portal drops the admin session mid-tick almost every
  hour (the `mymrc_sync_runs` ledger alternated `ok`/`auth_failed`); the old
  `ensureAuthenticated` re-logged-in on the SAME, now-dirty browser context, which is
  unreliable. It now recovers exactly the way `bootstrap` recovers a poisoned
  persisted state — tear the dirty context down, rebuild a CLEAN one
  (`newSessionContext(false)` + new page), log in, and verify a positive auth marker
  — via a shared `rebuildAndLogin` helper, wrapped in a bounded retry
  (`reauthAttempts`, default 3, with a short `reauthBackoffMs`) to absorb transient
  `net::ERR_ABORTED` nav flakiness before purging state and failing loud with
  `AuthFailedError`. All money-safe gates unchanged (`mayPersistState`, `purgeState`
  on final failure, positive-marker `looksLoggedOut`). New coverage:
  `src/lib/mymrc/portal-client.reauth.test.ts` (clean-context heal succeeds; heal on
  a later retry; retries-exhausted → purge + throw).
- **`docker-compose.yml`** — the `mymrc-scrape` worker is now ALWAYS-ON. It carried
  `profiles: ['mymrc']`, which excluded it from the deployer's default
  `docker compose up -d`, so the hourly sync NEVER ran in production (empty
  `mymrc_sync_runs` ledger; data only from manual `--profile mymrc run` backfills).
  With the admin credential now provisioned in the DB store, the profile gate is
  removed so the swarmpilot deployer starts and keeps it up (`restart: unless-stopped`).
  Command, healthcheck, resource limits, volumes, and `MYMRC_CRED_KEY` wiring are
  unchanged; the `ap` and `workbook-sync` profiles are separate and stay gated.
  Follow-up: add `mymrc-scrape` to the noc-master service-registry for fleet monitoring.

### Fixed — 2026-07-22 (ADR-0046 Amendment 5 — pre-go-live hardening pass, Eugene iPad go-live)

Focused fixes on the AP money module ahead of the Eugene iPad go-live. Each was
surfaced by an adversarial verify pass.

- **`src/app/dashboard/ops/ap/ApQueueClient.tsx`** — iPad AP PDF preview no longer
  renders blank. iOS/iPadOS Safari (WebKit) has no inline `<iframe>` PDF viewer, so
  the framed invoice was blank on the Eugene iPad. PDF attachments now always render
  a prominent, touch-sized "Open PDF in new tab" action; on iOS that replaces the
  dead frame, on desktop it rides above Chromium's working inline viewer. Image +
  HTML-body previews unchanged.
- **`src/lib/ap/extraction/claude-fallback.ts`** — the combined body + attachment
  text sent to the metered Anthropic API is now capped at 60,000 chars (`MAX_TEXT_CHARS`,
  mirroring the baseline-import structuring path), closing an unbounded-input cost/DoS
  vector. Images were already size- + count-capped.
- **`src/lib/ap/variance.ts`** — a per-vendor `variance_percent_override` of EXACTLY
  0 is now honored (any variance trips) instead of being silently dropped in favor of
  the 15% global default. Matches the flat-override semantics; treats "override is
  set" as not-null, not truthy. A 0 override is a legitimate tightening control.
- **`src/lib/ap/baselines.ts`** — `trailingWindowStart` no longer overflows on a
  Feb-29 (leap-year) anchor. The 12-month window now clamps the day to the last valid
  day of the target month (Feb 29 → Feb 28 of the prior non-leap year) instead of
  rolling forward to Mar 1, which had excluded late-February invoices from the window.
- **`src/lib/ap/stamp.ts`** — the dual-approval decision PDF meta block now shows
  BOTH approvers + timestamps (First approval / Second approval), consistent with the
  authoritative stamp band line, instead of showing only the first approver and
  mislabeling the first-approval time as the terminal "Decided" time (spec §D-M5-3).
- **`src/lib/ap/approvals.ts`** — the Reject / NOT-DR3 decide path no longer writes
  the DEPRECATED `ap_requests.vendor` / `amount_cents` columns even when a legacy
  client supplies them (hard rule #1: write-stopped on ALL decide paths, columns kept
  for historical data). Reject / Hold / NOT-DR3 keep only their single `decision_note`.
- **`src/lib/ap/variance.test.ts`** — synthetic invented vendor names replace
  real-world company names in fixtures; added money-control boundary tests (established
  gate at exactly 3 invoices; strict-`>` fire/no-fire at exactly the flat and percent
  thresholds; the 0-override regression). Plus Feb-29 window tests
  (`baselines.test.ts`), dual-approval meta-block tests (`stamp.test.ts`), and the
  write-stop assertion (`approvals.test.ts`).
- **migration `20260805_ap_amendment_5_...`** — corrected two inaccurate comments
  (DDL unchanged): the table count ("four" → "five" new tables) and the `ALTER TYPE`
  claim that the DB enum value order matches schema.prisma (it can't — `pending_review`
  was appended out of order by an earlier migration; Postgres enum value order does not
  affect Prisma correctness regardless).

### Fixed — 2026-07-22 (ADR-0046 Amendment 5 D-M5-3 — override-reject email dropped first-approver context)

- **`src/lib/ap/approvals.ts`** — a second-approver override REJECT email no longer
  drops the FIRST approver's `explanation` and equipment linkage. On a structured
  Approve the narrative lives in the `explanation` column (`decision_note` stays
  null), so the `effectiveNote` fallback resolved to NULL on a reject and the
  forwarder + CC'd first approver got the override reason but not what the
  transaction was for. The rejection email now renders the first approval note and
  the first approver's equipment linkage explicitly, per spec §D-M5-3 (line 680:
  vendor + explanation + amount + equipment + note). Regression covered in
  `second-approval.test.ts`.

### Docs — 2026-07-22 (ADR-0046 Amendment 5 finalize — operator runbook brought current)

- **`docs/operator/ap-approvals.md`** now documents the FULL Amendment 5 approver
  flow end-to-end: the structured four-field Approve (vendor freeform / explanation
  / confirmed-amount / equipment multi-select with explicit "Not equipment-related"),
  the intake auto-extraction confidence badges (HIGH/MEDIUM/LOW/FAILED) + the
  `anthropic.env` operator handoff, the variance block-until-acknowledged gate, the
  $1,000 second-approval routing (Woodland → Bill, Eugene → Shannon), and the
  `/admin/ap/baselines` + `/admin/ap/history` (`can_view_ap_history`) access model.
  Reject / Hold / NOT-DR3 documented as unchanged (single reason field). No code
  change — runbook only.

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-4/D-M5-5 — vendor baselines + invoice history)

- **Vendor-baseline aggregation** (`src/lib/ap/baselines.ts`): a pure trailing-12-month
  roll-up per normalized vendor (mean/median/min/max/stddev/count, anchored on the
  vendor's most-recent invoice) feeding `ap_vendor_baselines`, which variance detection
  reads. A baseline is **established** (used to flag) at 3+ invoices.
- **`rebuildVendorBaselines`** recomputes every vendor from `ap_vendor_baseline_history`
  and **preserves admin per-vendor threshold overrides** (`variance_flat_override_cents`,
  `variance_percent_override`) — the aggregate columns are upserted, the override columns
  are never touched. Runs **nightly** (new `ap-baseline-rebuild` cron → internal route
  `/api/internal/ap/baseline-rebuild`, 01:30 PT) and **on demand** (admin "Refresh"
  button).
- **Baseline freshness feed**: every TERMINAL `approved` transition (sub-$1K in
  `decideRequest`; the ≥$1K second-approve in `decideSecondApproval`) appends a
  `vision_approval` row to `ap_vendor_baseline_history` in the same transaction — so
  baselines stay current between Bill's re-uploads. Rejects and the second-approval hop
  do **not** feed.
- **Baseline import** (`/admin/ap/baselines/import`, admin-only): pick a Bill-uploaded
  AP-report PDF from file-drop → **preview** parsed rows (local pdf-parse tabular parse +
  Claude structuring fallback when configured, `src/lib/ap/baseline-import.ts`) →
  **confirm** to write `bill_upload` history and rebuild. The preview is the human guard
  (no DB-level dedupe); drop bad rows before confirming.
- **Per-vendor override management** (`/admin/ap/baselines`, admin-only): set stricter/
  looser flat-$ + percent thresholds per vendor; changes are audited.
- **Invoice history search** (`/admin/ap/history`): union of Vision-decided invoices
  (`ap_requests`) + Bill-uploaded history (`ap_vendor_baseline_history` where
  `source='bill_upload'`; the `vision_approval` feed is excluded to avoid double-counting).
  Filters: vendor typeahead, date range, amount range, site, approver, source. Per-row
  detail modal. No aggregate dashboards (per spec).
- **New scoped read gate** `can_view_ap_history` (`requireApHistoryRead`/
  `checkApHistoryRead`): admins + designated second approvers only — the general
  `ap_approvers` roster is excluded (hard rule #2, mirrors `can_view_billing_verify`).

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-3 — $1,000 second-approval workflow)

- **A structured Approve whose confirmed amount is ≥ $1,000 no longer terminates.**
  It moves to a new `pending_second_approval` state, stamping the first approver
  (`first_approver_id`/`first_approved_at`) + all four required field values, and
  pages/emails the SITE-appropriate second approver (Woodland → Bill, Eugene →
  Shannon Rockwell from `ap_second_approvers`). **NOT-DR3 and every Reject/Hold — and
  every sub-$1,000 Approve — are unchanged** (single-action, first-action-wins). The
  decision email + stamped PDF fire ONLY on the terminal `approved`/`rejected` state.
- **Second-approver decisions** (`POST /api/ops/ap/[id]/second-approval`,
  `decideSecondApproval`): Approve → `approved`; Reject → `rejected` (override), with
  `second_approver_note` and the first approver **CC'd** on the rejection email. The
  approved decision email + stamp now carry **BOTH** approver names + PT timestamps
  ("Approved by [First] on [T1 PT] via DR3-Vision; second approval by [Second] on
  [T2 PT]"). First-action-wins among second approvers (atomic conditional flip).
- **Authorization is server-side only.** Eligible = admin role OR an active
  `ap_second_approvers` row for the decision's site. The first-approver == would-be
  second-approver case (decision (c)) still fires the state but requires an explicit
  re-confirmation click AND a 30-second minimum wait since first approval, both
  enforced in `decideSecondApproval`.
- **UI:** a distinct "awaiting 2nd approval" tab + status badge; a second-approval
  panel showing the first approver's decision read-only, gated to the site's eligible
  second approver, with the self-fulfillment re-confirm + 30s countdown UX; a decided
  ≥ $1,000 row shows both approvers. The `/` AP tile badge folds in the awaiting-2nd
  count for second approvers (admins see all; a rostered second approver sees only
  their site(s)).
- **Notification:** `notifySecondApprovalNeeded` pages `dr3-vision-system` (row id +
  site only, ADR-0045) + emails the routed second approver through the `ap_notify`
  pilot gate ([PILOT] → admins until live). Fail-soft — never fails the first
  approval.
- **Operator handoff (§4):** provision Shannon Rockwell — insert an
  `ap_second_approvers` row `{ user_id: <Shannon>, site_id: 'eugene', active: true }`
  (Bill/Woodland needs no row; admin-eligibility covers it). See the runbook.
- Tests: state-machine transitions, site routing, eligibility, override-reject CC,
  first==second re-confirm + 30s-wait edge case, first-action-wins, dual stamp line
  (`second-approval.test.ts`, 18 cases).

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-1/4/6 — structured Approve + equipment linking + variance banner)

- **The AP Approve path is now STRUCTURED.** A real-site Approve (Woodland/Eugene)
  requires four non-empty fields — vendor freeform (with the exact "check spelling
  and capitalization…" helper prompt), an explanation (replaces the single note on
  Approve only), a confirmed amount pre-filled from the extraction result with a
  HIGH/MEDIUM/LOW/FAILED confidence badge (approver-overridable), and an equipment
  multi-select (site-filtered typeahead over the new `equipment` master, with an
  explicit mutually-exclusive "Not equipment-related" option; at least one selection
  required; writes `ap_equipment_links`; NO inline creation). **Reject / Hold /
  NOT-DR3 keep their single reason/note field unchanged** (§5.4 #4). Extraction only
  pre-fills; the approver confirms every field (§5.4 #5).
- **Variance banner + block-until-acknowledged gate (D-M5-4).** When the typed vendor
  matches an ESTABLISHED baseline (`ap_vendor_baselines`, invoice_count ≥ 3) and the
  confirmed amount trips the $50-flat OR 15%-percent thresholds (either-trips,
  per-vendor overrides honored), a RED banner shows the baseline mean, invoice count,
  and last 3 invoices, and the Approve button is disabled until the approver clicks
  "I've verified the variance" (stamps `variance_acknowledged_by`/`_at` + optional
  note; rides the decision email + stamped PDF footer).
- **Server-side enforcement (never trust the client).** `src/lib/ap/variance.ts`
  (pure either-trips evaluation + baseline/threshold resolution) and
  `src/lib/ap/equipment.ts` (site-scoped active-equipment validation) back the decide
  route: it re-validates all four required fields, re-checks equipment ids against the
  site, and re-evaluates the variance — refusing an above-threshold trip that was not
  acknowledged. New read endpoints `GET /api/ops/ap/equipment?site=` and
  `POST /api/ops/ap/variance-check` feed the panel. `decideRequest` persists the
  structured columns (`vendor_freeform`/`explanation`/`confirmed_amount_cents`/variance
  state), writes `ap_equipment_links` atomically with the flip, and STOPS writing the
  deprecated `vendor`/`amount_cents` (kept, per hard rule #1); the decision email +
  stamp now read the structured columns (falling back to the legacy columns for
  pre-Amendment-5 rows). Tests: `variance.test.ts`, `equipment.test.ts`, structured
  cases in `decide/route.test.ts` + `approvals.test.ts`, and the rewritten
  `ApQueueClient.test.tsx` gating test. (D-M5-3 dual-approval routing is a separate
  slice.)

### Added — 2026-07-22 (ADR-0046 Amendment 5 D-M5-2 — intake auto-extraction pipeline)

- **New `src/lib/ap/extraction/` module: hybrid invoice amount/vendor extraction
  at intake.** `pipeline.ts` (`extractFromRequest`) runs during `runApPoll` (inside
  `ingestMessage`, after body sanitize + attachment fetch, before the queue insert)
  and lands its `ExtractionResult` on `ap_requests.extraction` (jsonb) atomically at
  insert. Ordered hybrid: `local-parser.ts` does pdf-parse text extraction + regex
  heuristics against the four canonical labels (Total / Amount Due / Balance Due /
  Grand Total) and scores HIGH / MEDIUM / LOW / FAILED exactly per spec §2;
  `claude-fallback.ts` fires the Anthropic SDK **only** on LOW/FAILED local
  confidence (model from `AP_EXTRACTION_CLAUDE_MODEL`, default `claude-sonnet-4-6`;
  30s timeout; structured-JSON prompt; logs `cost_cents` per invoice). Fully
  fail-soft — never blocks or fails the poll; a hard failure lands
  `confidence:'failed'` with `error` populated. Extraction only PRE-FILLS the decide
  panel — the approver still confirms every field (hard rule #5).
  `ap_requests.extracted_haul_numbers` is left empty (Phase-2 hook only, gated on
  ADR-0057). New deps: `@anthropic-ai/sdk`, `pdf-parse`. New Anthropic-key secret
  mount (`~/.dr3-vision-secrets/anthropic.env`) enables the fallback; absent → local
  low-confidence lands as-is for manual entry. Fixture-tested for all four tiers +
  scanned-image / plain-text-email / multi-page + mocked Claude API
  (`extraction.test.ts`, 22 cases; all fixtures synthetic).
### Fixed — 2026-07-22 — MyMRC backfill truncated the two big views at 2050 rows (SOQL OFFSET 2000 ceiling)

The historical backfill (ADR-0057 D3) paged the Salesforce Experience Cloud list
views by `offset = pageIndex * 50`. **Salesforce hard-caps the SOQL `OFFSET` at
2000**, so at offset 2050 the portal returned a degenerate `SUCCESS` (no
`recordIdActionsList`, just a "list view isn't available in Lightning" `message`)
that the loop mis-read as end-of-data. The two large views were silently truncated
at **2050 rows** (confirmed live: `completed_hauls` and `outbound_active` both
stuck at 2050 with a drift error); every view under 2000 finished clean.

Replaced offset pagination with **sort-flip** (`src/lib/mymrc/list-page.ts`,
`backfill-portal-client.ts`). CONFIRMED LIVE 2026-07-22 against `mrc-us.my.site.com`:
`getItems` has no cursor token and the org's UI-API is disabled, but pageSize 2000,
`sortBy:'Id'`/`'-Id'` (a stable total order by Record ID), and `getCount:true`
(→ absolute `totalCount`) are all honoured. Ascending Id reaches the first 4000
rows (offsets 0 + 2000), descending the last 4000; their union is the whole view
when `totalCount ≤ 8000` (overlap dedups on the `salesforce_record_id` upsert key).
A view above 8000 pages every reachable window then **wedges LOUD** — never a silent
cap, never a false "complete". `total_records_estimated` now stores the true
`totalCount` (not the overlap-inflated running count).

- Live re-pagination result (verified against portal `totalCount`):
  `completed_hauls` **2050 → 6185 of 6185**, `outbound_active` **2050 → 4490 of
  4490**; all six other views unchanged and still complete. Mirror rows:
  hauls 3072 → 7207, outbound 2074 → 4514.
- Pinned the live-captured `outbound_active` list-view id (`00B4p000005DAqkEAG`).
- Hardened `parseGetItemsResponse` to raise a CLEAR offset-ceiling error on the
  degenerate past-2000 response instead of a misleading "no getItems action".
- Tests: sort-flip plan + coverage math (`list-page.test.ts`), and an end-to-end
  faithful-fake run proving it pages PAST the old 2050 ceiling and wedges loud on a
  view beyond coverage (`backfill-portal-client.test.ts`). Detail enrichment
  (`detail_fetched_at`) is unchanged — the standing hourly/backfill sweep fills it.

### Added — 2026-07-22 — quarterly off-host RESTORE DRILL (proves the backup lane is restorable)

Closes the "a backup nobody has restored is a rumor" gap for the DR3-Vision
lane — the one that carries bonus/payroll/PII. Proves the encrypted restic/R2
backup leg (`scripts/dr3-pg-backup.sh`) is actually *restorable*, on a schedule,
without anyone having to remember. Clones the proven DroneOps restore-drill
template, adapted from its aws-cli/gzip R2 path to our restic/`pg_dump -Fc` path.

- **`scripts/restore-drill.sh`** — pulls the newest `dr3-vision`-tagged snapshot
  from the dedicated R2 restic repo, refuses to certify anything **>48h old**,
  streams `restic dump` → `pg_restore` into a throwaway `dr3_vision_restore_drill`
  DB on the live `dr3-vision-postgres` container, asserts key tables non-empty
  (`audit_log`, `bonus_daily_entries`, `bonus_employees`) **and** the largest
  table (`audit_log`) restores to **≥90% of live**, then drops the scratch DB via
  an EXIT `trap` (guarded to that exact constant name, even on failure paths).
  Mirrors the template's spine: `set -euo pipefail`, `fail()` → ntfy + `exit 1`,
  `PIPESTATUS`-gated restic failure, atomic freshness-metric stamp **only** on
  full success. ntfy is FAILURE-ONLY (ADR-0037) → `infrawatch-alerts` (`high`,
  6h cooldown, dedup `dr3-vision-restore-drill`); a healthy drill is silent.
- **`scripts/systemd/dr3-vision-restore-drill.{service,timer}`** — `Type=oneshot`
  service (User `bbarnard065`, `TimeoutStartSec=30min`) + quarterly timer
  (`OnCalendar=*-01,04,07,10-16 18:13:00 UTC`, `Persistent=true`). On full success
  stamps the node-exporter textfile metric
  `dr3_vision_restore_drill_last_success_timestamp_seconds` (written atomically to
  `/var/lib/node_exporter/textfile_collector/`, scraped by BOS Prometheus as
  instance `CHAD-HQ`) — so a silently-dead timer is itself alertable via staleness.
  Installed + enabled on CHAD-HQ; next fire 2026-10-16 18:13 UTC.
- **Install-time verified** (2026-07-22): `systemctl start` → `Result=success`,
  exit 0, `audit_log=9920/9995` (99.2%), scratch DB dropped, metric live in
  Prometheus.
### Added — 2026-07-22 (ADR-0020 — Operations Dashboard re-enabled for the Eugene iPad go-live)

- **The Operations Dashboard tile is `active` again** (`src/lib/dashboard-tiles.ts`,
  `key: 'operations'`, still `manager+`). It was paused to `coming-soon` 2026-06-06
  "while the underlying surfaces are reworked"; those surfaces (processed-units
  daily close, loads/inventory running balance, Terex throughput/downtime/cost,
  the MyMRC mirror backfill, commodity-payment aging, the compliance slate, bonus
  close) have since landed, so `/dashboard` now leads with a comprehensive,
  legible overview instead of a bare site list. Re-enable is the one-field flip the
  registry comment always promised.
- **New per-site Operations Overview** (`src/app/dashboard/[site]/page.tsx` now
  leads with `overview/OpsOverviewPanel.tsx`, fed by
  `src/lib/dashboard/ops-overview.ts` → `computeOpsOverview`). At-a-glance cards +
  compact tables for: today's active/arrived loads, processing-close status (open
  vs closed = billing-ready), floor inventory (program / non-program / total),
  Terex throughput (7- & 30-day units/day), 30-day downtime + cost, contract
  recycling/recovery rates, the seven-tile compliance slate summary, commodity-
  payment aging (outstanding $, awaiting-invoice > 30d, invoiced-unpaid > 45d,
  disputed), bonus-period standing, and **MyMRC sync freshness** per feed
  (hauls/processed/outbound + shared dock schedule) with last-synced relative +
  absolute Pacific time so staleness is visible. Each panel deep-links to its
  source surface and degrades to an explicit note (never a crash) on read failure.
  The aggregation is a thin orchestrator over the existing source-of-truth modules
  — it re-derives no billing/compliance number.
- **Combined both-sites view** on the `/dashboard` picker for admin / all-sites
  managers (`computeSiteSummary`): Eugene + Woodland side-by-side (on-dock,
  arrived-today, on-floor, processing state, commodity outstanding, worst MyMRC
  freshness) above the site links. Single-site managers are unaffected.
- **iPad-first legibility:** dark Vision palette (ADR-0014), no sub-12px real-data
  text, WCAG-AA contrast, ≥44px touch targets, no hover-only affordances, tables
  scroll inside their own container (zero horizontal page scroll verified at
  768×1024 / 1024×768 / 390 / 1440 via Playwright), every figure labeled with a
  unit, times shown in Pacific. Refresh is the 30s ops cadence (`OverviewPoller`)
  — lighter than the old 5s dock poll now that the surface aggregates heavier
  analytics.
- **Site isolation preserved** (hard rule #2): every read is scoped to the
  resolved site id; the mirror `site_id IN {this site}` filter also excludes
  not-yet-resolved NULL rows; the shared MyMRC dock schedule is labeled "all sites"
  since it carries no site discriminator. The 403 gate for off-site managers is
  unchanged.
- Tests: `src/lib/dashboard/ops-overview.test.ts` (freshness grading + commodity
  aging buckets), `src/app/dashboard/[site]/overview/OpsOverviewPanel.test.tsx`
  (rendered legibility contract + degraded-panel handling), and updated
  `src/lib/dashboard-tiles.test.ts` for the flip. Full suite green (2731 passed).

### Fixed — 2026-07-22 (ADR-0057 D3 — backfill full history: Completed Hauls + inactive-materials views)

- **MyMRC backfill now pages ALL list views per object — active AND history —
  so it pulls full history, not just active records.** Caught during the live
  first backfill: the worker paged only the active/default views, so **"Completed
  Hauls" (the ~720+ historical trailer deliveries)** and the inactive-Materials
  views were never pulled. `BACKFILL_LIST_VIEWS` (`src/lib/mymrc/list-page.ts`)
  gains 3 history cursors — `completed_hauls` (→ `mymrc_hauls_mirror`,
  `00B4p000005DAqSEAW`, paginates — the bulk of haul history), `processed_inactive`
  (→ `mymrc_processed_mirror`, `00BUJ000001sJxx2AE`), `outbound_inactive`
  (→ `mymrc_outbound_mirror`, `00BUJ000001sJuj2AE`) — all captured live 2026-07-22.
  `buildBackfillTargets` (`backfill-targets.ts`) enumerates all 8 cursors; the
  offset loop, resumable per-view cursors, and dedup-by-`salesforce_record_id` are
  unchanged. A haul id that appears in both an active view (Docking/Consumer) AND
  Completed Hauls **upserts once** (mirror key) and its detail is fetched once
  (`detail_fetched_at IS NULL`, targets run sequentially). Inactive Materials still
  route by `Type__c` to processed/outbound — the inactive VIEWS only widen
  coverage. **No migration:** cursor rows are created lazily by the worker on first
  run (`mymrc_backfill_cursors` upsert). Config-drivable: `MYMRC_LISTVIEW_IDS`
  keys the new views (`completed_hauls` / `processed_inactive` / `outbound_inactive`);
  adding a further view later is a one-line map entry. Residual: the Hauls picker's
  "More" menu may expose further uncatalogued views (OPEN-ITEMS C-25) — captured +
  added only once an id is in hand (ids are never guessed).

### Added — 2026-07-22 (ADR-0057 Phase 1 — real MyMRC ingestion, informed by the inaugural Phase-0 discovery)

The first authenticated MyMRC pull (Phase 0, 2026-07-21) returned a real object
catalog nothing like the original ADR guess — so Phase 1 was built against the
**real** Phase-0 shapes (`docs/mymrc-discovery-2026-07-22.md`), not a guessed
mirror schema. This feeds production billing; correctness and reliability were
the bar. Schema foundation landed in `4057d0f`; this block is the ingestion
wiring on top of it.

- **Mappers adapted to the real object catalog** (`src/lib/mymrc/mappers.ts`).
  `mapHaulRecord` now reads every real `Haul_Request__c` field (billing-authoritative
  `Recycler_Program_Unit_Count__c`, `Recycling_Center_Lookup__r.Name` site
  discriminator, transporter/collection/commodity/container, consumer-drop-off
  units, docking date). Fixed two latent placeholder bugs: `weight_lbs` read the
  non-existent `Weight__c` (always null) → now `Recycler_Weight__c`; the unit count
  read a _Materials_ field → now the correct haul field. `mapProcessedRecord` /
  `mapOutboundRecord` map `Materials__c` (ONE object, split by `Type__c` at ingest
  via new `classifyMaterialsType`); `weight_lbs` is hard-null (Materials has no
  weight field). New `mapDockAvailabilityRecord` for the new
  `Dock_Availability_Schedule__c` object (raw multipicklist codes; SF Time strings
  kept verbatim, never `Date.parse`d). All mappers read `value` for identity, never
  `displayValue`; the full raw record is preserved in `payload`.
- **Windowed backfill worker** (`src/lib/mymrc/backfill.ts` + `backfill-targets.ts`)
  — schema-agnostic engine: per object×list-view, pages `getItems` by
  offset/`hasMoreData` to `hasMoreData:false`, persisting a
  `mymrc_backfill_cursors` row after every page (resumable mid-pagination), then a
  bounded (≤3) detail sweep of rows with `detail_fetched_at IS NULL`. Idempotent on
  SF-id upsert keys; a pagination wedge fails loud (cursor error + ntfy) while a
  per-record detail failure retries next run. 5 cursors wire the 4 real objects
  (Haul ×2 views, Materials ×2 views, Dock ×1).
- **Offset-pagination transport — backfill is now LIVE, no longer inert**
  (`src/lib/mymrc/list-page.ts`, `backfill-portal-client.ts`,
  `scripts/mymrc-backfill.mjs`; closes OPEN-ITEMS C-24). The `getItems` OFFSET
  pagination was CONFIRMED LIVE 2026-07-22: an Aura
  `ListViewDataManagerController.getItems` action with
  `{filterName, entityName, pageSize:50, layoutType:"LIST", sortBy:null,
getCount:false, enableRowActions:false, offset:N}` returning
  `{records, offset, hasMoreData}`, looped to `hasMoreData:false`. `list-page.ts`
  encodes the request/response codec + list-view id resolver PURE (unit-tested);
  `createBackfillPortalClient` maps the engine's 0-based `pageIndex → offset =
pageIndex*pageSize` (a pure function of the resumable cursor) and replays the
  getItems POST, reusing the live aura framework envelope the browser sent
  (immune to `fwuid` drift) — chosen over DOM infinite-scroll for determinism.
  The shared, self-healing admin session was extracted to `openAdminSession`
  (both the steady-state client and the backfill transport reuse it — one auth
  path). List-view ids: 2 captured live (Docking, Processed); the other 3 resolve
  at RUNTIME from the browser's own getItems request, or via a
  `MYMRC_LISTVIEW_IDS` operator override — an id that resolves to NONE fails LOUD
  per-target (a resumable wedge + ntfy), never guessed. Run one-shot:
  `node scripts/mymrc-backfill.mjs` (resumable + idempotent; safe to re-run).
- **Hourly sync wired to the real objects** (`src/lib/mymrc/sync.ts`). Site scoping
  moved from the login to the DATA (ADR-0057 D1 / recon B §6): a single admin
  session lists ALL records globally (`site_id` NULL at list time), and each row's
  site is derived + stamped on the DETAIL pass from its discriminator
  (`recycler_name`/`account_name` → `sites.code`), stamped **only when resolved**
  (never a NULL over a prior attribution). All new mirror columns are populated.
  **`expected_loads` join fixed (money-critical):** joins on the real
  `Collection_Site__c` (the old code used `Rate_ID__c` and matched nothing) and
  bills the authoritative `program_unit_count` (was the always-null `units`).
- **Stale-session self-heal** (`src/lib/mymrc/portal-client.ts`). Fixes the live
  bug where a tick ending logged-out wrote anonymous cookies over the good
  `storageState`, poisoning every subsequent tick. `storageState` is now persisted
  **only** after a positive auth check (money-safe latch); bootstrap proves auth up
  front, discards a logged-out persisted state and re-logs-in, and purges the
  poisoned file before failing loud on a hard auth failure. Bounded nav retries
  absorb transient blips without an unbounded loop.
- **Reconciliation-feed wiring** (`src/lib/mymrc/reconcile-feed.ts`,
  `reconcile-detect.ts`). After each sync tick the scrape feeds unknown
  collection-site / account names (real discriminators `Collection_Site__c` /
  `Account__r.Name`) into the Wave-2 `mymrc_reconciliation_queue` as `new_record`
  candidates for operator approval — **queue only, never a direct `sources` write**
  (ADR-0057 D4). Dedups within a pass, across feeds, and across runs. `apply.ts`
  now resolves the hauls mirror's site too, so hauls candidates are approvable; an
  unresolved `site_id` throws `ReconNotFoundError` rather than approve an unscoped
  `sources` row (money-safe invariant preserved through the nullability widening).
- **Discovery fixture redaction hardened** (`src/lib/mymrc/discovery.ts`). Closes
  the 143-name leak class — flat person-name audit/lookup fields (`*_By__c`,
  `…ById`, `Owner`/`Manager`, `Employee_*`) are now scrubbed while opaque
  Salesforce ids and all business fields (site/vendor/transporter names, counts,
  dates) are retained. The raw disc3 fixtures were read for structure only; the
  committed `__fixtures__/phase1/` set is fully synthetic (DR3 Testville / Synthetic
  Hauling Co / fabricated ids). (Correction: a few real DR3 record numbers had
  leaked into inline test data / schema comments outside that dir — scrubbed in the
  2026-07-22 review remediation below.)

### Fixed — 2026-07-22 (ADR-0057 Phase 1 review remediation — pre-deploy, same branch)

Review of the Phase-1 branch before deploy caught four issues; all fixed here.

- **BLOCKER — windowed list mass-marked the haul tail as disappeared (billing
  loss).** The hourly sync ran disappeared-detection (`markDisappeared`, an
  `updateMany` over every active row NOT in the listed set) against whatever
  `fetchListRecordIds` returned — but the transport only returns the FIRST Aura
  window when a feed exceeds one page (Haul/Materials routinely do). Once the
  mirror held more than one window (guaranteed the moment backfill drains the
  tail), every tick stamped `disappeared_at` on the unseen tail, and
  `feedExpectedLoads` (which filters `disappeared_at: null`) silently dropped those
  hauls from the billing queue. Fix: `fetchListRecordIds` now returns
  `{ ids, complete }` (`complete = !hasMoreData`), and `syncFeed` runs
  disappeared-detection **only on a proven-complete list**; a windowed page skips it
  (never over-marks — a truly-removed record stays active until a complete list is
  seen, the money-safe direction). New tests lock both branches.
- **DR deadman false-green for Eugene.** The scrape looped `['eugene','woodland']`
  against ONE global admin session (C-21: the session sees a single recycler
  context). The now-global list pass let the vestigial `eugene` pass "succeed" and
  write an `ok` `mymrc_sync_runs` row, so `checkDeadman` reported Eugene healthy
  forever despite zero Eugene records. Fix: the scrape resolves the **active
  recycler context** (`resolveActiveSites`, default `woodland`, overridable via
  `MYMRC_ACTIVE_SITES`) and syncs + deadman-watches only that set — no false-green.
- **Backfill worker was orphaned + PII in new test files.** The backfill surface
  (`runBackfill`/`buildBackfillTargets`) is now exported from the `@/lib/mymrc`
  barrel (was omitted despite the "export the surface" commit); it remains INERT
  pending a production paginating portal adapter (OPEN-ITEMS C-24). And a few real
  DR3 record numbers from the Phase-0 pull (a haul number, a dock-schedule number,
  and one real Account id) that had been copied into newly-committed test/schema
  files were replaced with the established synthetic values
  (`H-900001`/`DA-900001`/`001460000SYNTHTVLAAQ`) — correcting the earlier "fully
  synthetic" claim for this branch.

### Changed — 2026-07-21 (ADR-0019 §2 / ADR-0030 amendment — later-shift bonus timing: 8pm entry deadline + report-on-save)

The team now works a later shift. The bonus entry deadline moves to **8:00 PM
Pacific**, and the per-site production report is now primarily an **on-save**
event ("the report goes out for each site as soon as the data is entered and
saved"). No schema change — all timing lives in the daemon fire hour, the on-save
path's send gate, and the `send_time_pt` config value.

- `scripts/bonus-eod-check.mjs` — entry-deadline / "no entries" late-notification
  daemon fire hour `FIRE_HOUR_PT` 17 → **20** (8pm PT). DST-correct via the existing
  offset-reprobe `nextFireInstant` (no hardcoded UTC offset). Per-site ntfy for a
  zero-entry site is unchanged apart from the hour.
- `src/lib/bonus/daily-report-late.ts` — `maybeSendLateDailyReport` →
  **`maybeSendDailyReportOnSave`**. The report now fires on **every** successful
  save (removed the `!isPastScheduledSend → not_late` gate). Lateness (past the 8pm
  deadline / a prior day) no longer gates the send — it only sets `late_submission`
  and the LATE banner/subject. New outcomes `sent` / `resent` (on-time) alongside
  `sent_late` / `resent_late`. Still fail-soft (never fails the save), still
  idempotent per `(site, report_date)` via the log-row unique + resend-on-changed-
  totals — a re-save of the same numbers never double-sends.
- Callers updated: `src/app/api/bonus/entries/route.ts`,
  `src/app/api/bonus/amendments/[id]/approve/route.ts`.
- `prisma/seed.mjs` — daily-report `send_time_pt` seed 18:00 → **20:00** PT: the
  value now means the 8pm deadline / lateness threshold, and the ADR-0030 scheduled
  daemon becomes a pure end-of-window backstop (whichever path claims the log row
  first sends; the other skips — no double-send).
- **Signing escalation tiers (07:10 / 07:30 / 08:30 auto-sign / 09:00) are
  UNCHANGED** — those govern the morning-after signing chain (ADR-0019 §-signing /
  `bonus-escalation-check.mjs`), a separate concern from entry.
- **Operator action for prod:** set each enabled site's daily-report `send_time_pt`
  to `20:00` via Admin → Daily Report Config (the seed only affects fresh/CI DBs).
  Until then the on-save report still fires on save; only the "late" flag threshold
  stays at the old value. The 8pm not-entered ntfy is hardcoded in the daemon and
  already correct.

### Fixed — 2026-07-22 (ADR-0057 Phase 0 — MyMRC scrape/discovery against the REAL portal)

First live run of the ADR-0038/0057 code (written against synthetic fixtures, never run
live) revealed four divergences from the real `mrc-us.my.site.com` portal. Selectors
bumped `2026-06-22` → `2026-07-22`. Branch `fix/mymrc-scrape-live-portal`.

- **Login now fills by PLACEHOLDER + submits by ROLE.** The Lightning login fields have no
  `name` and dynamic numeric ids; the only stable hook is the placeholder ("Username" /
  "Password"), and the button reads "Log In". `src/lib/mymrc/selectors.ts` +
  `portal-client.login()` + `scripts/mymrc-discovery.mjs` now use
  `getByPlaceholder(...)` / `getByRole('button', { name: /log ?in/i })`. Fixes silent
  logged-out no-op affecting BOTH the hourly sync and discovery.
- **Hardened `looksLoggedOut` to a POSITIVE auth-marker check.** `/s/home` is a 404 "Error"
  page for authed + anon sessions alike (no password field) — the old check read it as
  "logged in", so `AuthFailedError` never fired on a failed login. Logged-in now requires
  a Switch-Account / "viewing as DR3" banner or ≥2 object nav links AND no visible "Log in"
  control. The discovery runner delegates to the shared, fixture-tested predicate.
- **Discovery enumerates via the NAV → per-object list pages, not `/s/home`.** New pure
  helpers in `discovery.ts` (`objectSlugFromHref`, `objectPagesFromHrefs`,
  `extractNavMenuHrefs`, `resolveObjectPages`) resolve the object slugs (`hauls`,
  `illegal-dump-cip-`, `processed-materials`, `outbound-materials`, `availability`,
  `outbound-vendors`, `records-review`) from the `getNavigationMenu` Aura response / DOM
  links (Home/FAQs/Support/Reports filtered), with a static allowlist fallback. Auth is
  verified at `/s/` (the real authenticated landing), never `/s/home`.
- **Discovery output dir configurable via `MYMRC_DISCOVERY_OUT_DIR`** (defaults to repo
  root). Fixes the `EACCES` the first run hit writing under the container's read-only
  `/app` as uid 1001; point it at a writable mounted volume.
- Fixtures: rewrote `authed-shell.html` to the real `/s/` shell, added `home-404-page.html`
  (the `/s/home` trap), `discovery/nav-getnavigationmenu.json`, `discovery/hauls-list-page.json`.
  New unit tests cover nav→object-page resolution, per-object-page enumeration, and the
  logged-in detector (authed-nav vs login-form vs `/s/home` 404). No schema/migration change.
- **FOLLOW-UP flagged (not implemented):** "Switch Account" (DR3 Woodland ↔ DR3 Eugene) —
  the hourly scrape may need to iterate both account contexts to pull both sites' data.

### Added — 2026-07-22 (ADR-0057 D1/D9 — MyMRC admin credential store, encrypted DB surface)

Foundation for the MRC-Scrape credential surface: Bill's MyMRC admin login now lives in
an encrypted single-row DB table instead of a `.env` file (operator rule — no `.env` for
these creds). This is the store the admin entry UI writes and the scrape reads; it
unblocks Vision's first-ever MyMRC pull.

- `prisma/schema.prisma` — new `MymrcAdminCredential` model → `mymrc_admin_credentials`.
  Single row (`id='singleton'`, CHECK-enforced): `username` (plaintext login id),
  `password_ciphertext` / `password_iv` / `password_auth_tag` (base64 AES-256-GCM),
  `key_version`, `updated_by` (bare audit-actor id), timestamps.
- `prisma/migrations/20260802_adr0057_mymrc_admin_credentials/migration.sql` — additive
  CREATE TABLE (ADR-0035 clean-replay), singleton CHECK constraint.
- `src/lib/mymrc/credential-store.ts` — server/scrape module (dual-compiled under
  `tsconfig.mymrc.json`, so no `@/` alias / no `server-only`): `setMymrcCredentials`
  (encrypt + upsert + password-free audit row), `getMymrcCredentials` (decrypt; scrape
  read path; fail-closed on tamper), `getMymrcCredentialStatus` (no password/ciphertext,
  safe for the UI). Password is write-only across every boundary.
- **Encryption key = dedicated `MYMRC_CRED_KEY`, NOT `NEXTAUTH_SECRET`** (scrypt +
  fixed app salt). The scrape container is deliberately stripped of `NEXTAUTH_SECRET`
  (ADR-0053 addendum); a dedicated key lets both the app (writer) and scrape (reader)
  decrypt without reversing that hardening. INTEGRATION PREREQ: `MYMRC_CRED_KEY` must be
  injected into BOTH the `app` and `mymrc-scrape` runtime env (tracked with O-12).
- `src/lib/mymrc/credential-store.test.ts` — 21 tests: round-trip, status leaks nothing,
  tamper/auth-tag/wrong-key/key_version fail closed, empty/whitespace rejected, missing
  key aborts, migration↔schema parity.

### Added — 2026-07-22 (ADR-0057 D4 / Addendum A — MyMRC reconciliation queue + CA source disambiguation + two-haul-mode gate)

The reconciliation layer that stands between MyMRC mirror data and Vision's operational
tables. Vision NEVER auto-updates `sources` / `source_aliases` / `state_program_rules` from
a MyMRC pull: the sync detects candidate changes, writes them to a review queue, and only an
explicit admin **approve** applies one to an operational table (reject writes nothing, snooze
defers 7 days). Every decision carries a required note and is audited in the same transaction
as the state flip (first-action-wins). Built now, populates at the first post-Phase-0 backfill
for Bill's bulk-approve — nothing here writes to an ops table until he acts.

- `prisma/schema.prisma` — `MymrcReconciliationQueue` model → `mymrc_reconciliation_queue`
  (generic field-level rows: `mirror_table`/`mirror_record_id`/`target_table`/`field_name`/
  `mymrc_value`/`vision_value`/`change_kind`/`status`/audit + `snooze_until`), plus enums
  `ReconChangeKind` (`new_record|field_update|disappeared`) and `ReconStatus`
  (`pending|approved|rejected|snoozed`). Additive; 3 indexes (pending view, classifier dedup,
  target lookup).
- `prisma/schema.prisma` — `CollectionEvent.dr3_hauled Boolean @default(true)` on
  `collection_events`. Default `true` reproduces current invoice output on the additive
  backfill (all existing events carry billed freight) — the money-adjacent safe direction;
  `false` is the new customer/third-party-haul exception.
- `prisma/migrations/20260803_adr0057_reconciliation_queue/migration.sql` — additive: both
  enum types, the `dr3_hauled` column, the queue table + indexes.
- `src/lib/mymrc/reconcile-detect.ts` — pure, dual-compiled `new_record` classifier: a mirror
  source name matching NEITHER `sources.name` (verbatim) NOR a normalized `source_aliases.alias`
  becomes one queue candidate (reuses the byte-identical `normalizeSourceName` the upsert path
  uses). Emits only `new_record`/`sources` this wave (accounts mirror is Phase-0-pending).
- `src/lib/reconcile/apply.ts` — decision engine (approve/reject/snooze); the ONLY operational
  write (`source.create`) is inside the approve branch of one transaction. Required-note gate
  (`assertReconcileNote`, ≤2000), unsupported-target refusal (never silent no-op), plus
  `bulkApproveReconciliations` (per-item tx so one bad apply fails alone) and
  `pendingReconcileCount` for the tile badge.
- `src/app/api/admin/mymrc/reconcile/**` — admin-gated (`requireAdmin`) pending-list GET,
  per-item decide POST, and bulk-approve POST (all note-gated + length-capped).
- `src/app/admin/mymrc/reconcile/` — admin review page + client; `mymrc-reconcile` dashboard
  tile (admin-only, `Scale` icon).
- `src/lib/mymrc/ca-source-seed.ts` — Rick's 2026-07-21 CA (Woodland) disambiguation constant
  (`CA_SOURCE_DISAMBIGUATION`, 7 confirmed rows; `CA_SOURCE_DISAMBIGUATION_PENDING`, 5 hints
  still awaiting Rick's exact canonical names). Pure/dual-compile-safe; the operator's canonical
  reference when approving CA `new_record` candidates. No canonical name or address is invented.
- `prisma/seed.mjs` + `prisma/seed/addendum-b-data.mjs` — §A.8.2 CA office aliases (woodland-
  scoped, self-activating: each no-ops until its canonical Source clears the D4 queue); §A.4
  Covanta seeded `is_active:false` with NO recycling rate (WTE % pending Rick).
- `src/lib/commodity/fetch.ts` — an inactive vendor's name never reaches the customer-facing
  commodity attachment (falls through to free-text buyer).
- §A.3 two-haul-mode gate: `src/lib/invoices/{types,event-leg,generate}.ts` sum event freight
  (`B16.event_freight` → `MILES 0`) only for `dr3_hauled` events (provenance still stamps all);
  `src/lib/event-billing/tonu.ts` refuses TONU for a non-DR3-hauled event
  (`not_dr3_hauled`). Labor/EVENTO (B8) fires in both modes.
- §A.5 verify: `Xtraction × metal = 0.8100` pinned with a test guarding against silent drift.

### Added — 2026-07-22 (ADR-0057 D1/D9 — MRC-Scrape credential surface + auth transition)

The admin UI/DB surface for the credential store above, plus the scrape's transition off
per-site `.env` logins onto the single DB-backed admin identity. With this, Bill can enter
his MyMRC admin login at `/admin/mrc-scrape` and the hourly scrape decrypts it — the last
step before Phase 0 discovery (O-12).

- `src/app/admin/mrc-scrape/` — admin-only page (`/admin/mrc-scrape`) composing the
  write-only credential form (`MrcScrapeForm`, no `<form>` per hard rule #10) and the
  read-only status panel (`ScrapeStatus`) via a `MrcScrapePanels` shell that refetches
  status on save. Password is never pre-filled, never returned, never logged.
- `src/app/api/admin/mrc-scrape/credentials` (POST, save) + `.../status` (GET, read-only
  state: credential-configured, last run, per-object mirror counts + `neverRun`). Both
  admin-gated; neither returns the password/ciphertext.
- `src/lib/dashboard-tiles.ts` — lit up the `mrc-scrape` admin tile (was a coming-soon
  placeholder) → route `/admin/mrc-scrape`, `scope: admin-only`.
- `scripts/mymrc-scrape.mjs` / `mymrc-cron.mjs` — single admin login (no per-site loop);
  **D9 fail-loud**: unconfigured/undecryptable creds page `dr3-vision-system` and exit
  non-zero (was silent skip + exit 0). New `scripts/mymrc-healthcheck.mjs` +
  compose `healthcheck` report UNHEALTHY until a credential row exists.
- `src/lib/mymrc/credentials.ts` / `portal-client.ts` — auth model swapped from
  `SiteCredentials`/per-site auth-state to the DB store + single admin session
  (`~/.dr3-vision/mymrc-admin/auth.json`); `CredentialsNotConfiguredError` (D9).
- `docker-compose.yml` — **end-to-end key path wired**: `mymrc-cred-key.env`
  (`MYMRC_CRED_KEY`) mounted on BOTH `app` (encrypt on save) and `mymrc-scrape`
  (decrypt), both `required: false` (deploy-before-provision). Retired the per-site
  `mymrc.env` mount + `MYMRC_{EUGENE,WOODLAND,OR,CA}_*` vars.
- `src/app/api/health/subsystems/route.ts` — the MyMRC subsystem pill now reads the DB
  credential store (`getMymrcCredentialStatus`) instead of the retired `MYMRC_*_USERNAME`
  env greps, so it reflects real configured state; a store read error degrades that one
  tile to amber rather than reddening the whole footer.
- Tests: credential + status routes, form + status components, D9 orchestration, and a
  compose-wiring guard asserting BOTH `app` and `mymrc-scrape` mount `MYMRC_CRED_KEY`.

### Added — 2026-07-21 (ADR-0057 accepted — MyMRC full-object ingestion via admin-user creds)

Ships the ADR-0057 decision (from the 2026-07-21 handoff): retire the never-honored
per-site service-account MyMRC auth, move to Bill's single admin-user credentials,
extend ADR-0038's 3 hardcoded feeds to N discovered Salesforce objects, add a manual
reconciliation queue as the write gate to operational tables, and convert the
missing-creds path from a silent skip to a fail-loud `CredentialsNotConfiguredError`
(D9). Historical framing preserved: Vision has never pulled a byte from MyMRC — all
three mirror tables are empty and Phase 0 is first contact.

- `docs/adr/0057-mymrc-full-object-ingestion.md` — Accepted (2026-07-21).
- `docs/adr/0038-mymrc-ingestion-rebuild.md` — annotated: auth model superseded by
  ADR-0057; documents the never-created service accounts + silent-no-op history.
- **NOT IMPLEMENTED YET.** Phase 0 discovery + Phase 1 foundation are HALTED on the
  credential prerequisite: `MYMRC_ADMIN_USERNAME` / `MYMRC_ADMIN_PASSWORD` are not yet
  provisioned into the `mymrc-scrape` runtime env (only the old, never-honored
  `MYMRC_WOODLAND_*` / `MYMRC_EUGENE_*` vars exist). Per operator rule these will NOT
  be a committed `.env` file — Bill injects them via the approved secrets mechanism
  when ready (security confirmed 2026-07-22). Tracked as OPEN-ITEMS **O-12**. No
  code/schema/auth changes in this PR — decision doc only.

### Fixed — 2026-07-21 (admin user creation rejected valid operator/manager payloads — ADR-0017)

`POST /api/admin/users` returned **"Invalid request payload"** (422) when creating an
operator (and managers were affected too). Root cause: the `optionalEmail` /
`optionalProcessorRole` / `optionalPin` Zod schemas used `.optional()`, which accepts
only `undefined` — but `UserCreateForm` sends an explicit **`null`** for any field that
doesn't apply to the chosen role (an operator's email + processor_role, a manager's pin).
The schema's own comment already documented that null must be allowed; the implementation
didn't. Fixed by switching the three optional fields to `.nullish()` (nullable + optional).
The existing operator test used `email: ''` (empty string, which the old schema _did_
accept), so it never caught the real form's `null` — added regression tests using the
exact null-field payloads the form sends (operator and manager). Reproduced against prod
(422 with `fieldErrors: email, processor_role`) before the fix; no schema/DB change.

### Fixed — 2026-07-21 (ADR-0048 D3 — Terex importer date plausibility + silent-drop surfacing)

Confirmed prod bug: the Terex maintenance-log importer stored a garbage
`equipment_events` row with `event_date = 1900-01-14`. When an operator leaves a
stray number in a date-FORMATTED Date cell (typing the real date into the note
instead), exceljs surfaces it as an Excel-epoch `Date` and `parseFlexibleDate`
happily returned `1900-01-14`. Verified against Janette's real workbook: 1 of the
68 imported events carried the 1900 date (its note held the real `01-15-2026`).

- **Plausibility floor/ceiling on `parseFlexibleDate`** (`src/lib/equipment/import.ts`):
  a parsed date outside `[2000, 2100]` is treated as NOT a valid date (returns
  `null`). Applied consistently, so the strict CSV path (`rowsToEvents`) now fails
  loud on an Excel-epoch date instead of storing a 1900 event, and the
  maintenance-log path stops producing the garbage row.
- **Never silently drop a real event.** A maintenance-log row that carries
  descriptive TEXT (issue/measures/notes) but no plausible date is no longer
  discarded: it is collected into a new `warnings` array (sheet, 1-based row,
  raw Date cell, content preview) and returned through `TerexImportResult` → the
  admin import API response. Money-only, dateless rows (SUM/subtotals) still skip
  silently. This surfaced a SECOND, larger data-loss pattern in the real file:
  the entire January 2026 block was entered with dates in the Issue column (or
  human formats like `Jan.6,2026`), and the old importer silently dropped all
  ~18 of those real events. They now appear as warnings for source correction.
- **Persisted `equipment_history_imports.rows_warned`** (additive migration
  `20260801_adr0048_terex_rows_warned`) + the count in the batch audit row.
- **Hardened `worksheetToGrid` cell unwrap**: exceljs formula/richText/hyperlink/
  error cells were previously leaked downstream as `[object Object]` for any shape
  other than `{result}`; all object shapes are now unwrapped (uncached formula /
  error → `null`), preventing silent note/cost corruption.
- Tests: fixture gains an Excel-epoch content row asserted into `warnings` (not
  events); plausibility-window, strict-CSV-epoch, and subtotal-not-warned cases.

Re-import hazard (operator action required): the existing prod batch
(`import_id 42d0ebdd`) already contains the 1900 garbage event. Re-uploading a
corrected file will recover the ~18 dropped January events but will NOT remove the
1900 orphan, and will create a duplicate for that incident (the corrected
`2026-01-15` row keys on a different date, so it won't dedup against the 1900 row).
Soft-void the single garbage event (`event_date=1900-01-14`, `import_id=42d0ebdd`)
BEFORE re-importing. Do not delete-and-reimport the whole batch.

### Changed — 2026-07-21 (AP approvals now require an explanatory note — ADR-0046 amendment)

Approving an AP invoice now REQUIRES a non-empty note describing what the transaction
was for and any additional context — matching the existing reject-requires-note and
NOT-DR3-requires-reason gates. Previously approvals were note-optional, leaving no
recorded transaction purpose on plain approvals (audit-trail gap). Operator directive:
_"on the AP module let's not allow approval without a note — the user needs to enter
data about what the transaction was for and explain additional context before being
able to approve the invoice."_

- **Service** — `assertDecisionNote` (`src/lib/ap/approvals.ts`) now throws
  `ApNoteRequiredError` (400) for an approval with no/blank note, same trimmed
  minimum as rejection, with an approval-specific message. NOT-DR3's own
  reason-required guard is unchanged and still enforced.
- **Route** — `/api/ops/ap/[id]/decide` continues to validate the note BEFORE any
  state change; the extended rule maps to a typed 400 with no DB write.
- **UI** — the approver panel disables **Approve** until a non-empty note is present
  (mirroring Reject/Hold); the Note field is relabeled **(required)** and prompts for
  "what this transaction was for + any additional context".
- Tests: `assertDecisionNote` unit tests + a decide-route test (approve-without-note
  → 400, no decide) + a new `DetailPanel` interaction test (Approve disabled without
  a note). No e2e/Playwright harness exists for the AP page — behavior is covered by
  the interaction test instead.

### Fixed — 2026-07-21 (full-stack audit — P1-3 backup-failure alerting)

Confirmed audit finding P1-3: the DR3 restic backup lane's failure alerting had
been dead for a month. `scripts/dr3-pg-backup.sh` (run by the `dr3-vision-pg-backup`
user-systemd timer daily) called `ntfy-publish.sh` with **positional args** against
a **flags-only** helper — every call exited 2 and was swallowed by `|| true`, so a
silent backup stoppage (R2 cred rotation, lost restic env) would have left the timer
green while data-loss exposure grew unbounded. Additionally the `--topic
dr3-vision-backup` the script intended is **not reachable** from the CHAD host token
(chad-hq-publisher scope) — it 403s.

- **ntfy contract fixed** — all publishes now use the ADR-0036 flag syntax
  (`--topic/--title/--priority`); verified delivering (exit 0) end-to-end on CHAD.
- **Fail-loud** — a missing/incomplete restic env now PAGES `high` and exits 1
  (was: log + `exit 0`, timer stayed green). Injected-failure tested: missing env
  and incomplete env both page + exit 1.
- **Snapshot-age deadman** — after the push, the script asserts the newest
  `dr3-vision` snapshot is < 26h old; any silent-skip path (env drift, wrong repo)
  now fails the run loudly.
- **Topic** — defaults to host-scoped `chad-hq-backup` (token-reachable; same topic
  the sibling host backup driver uses). Override `NTFY_TOPIC` to the per-service
  `dr3-vision-backup` only if the dr3-vision-publisher token is placed on the host.
- Verified against the live repo: full run pushed snapshot `c7cd38a2`, prune +
  deadman + OK page all succeeded.

### Changed — 2026-07-21 (Terex importer finalized + Woodland source-alias backfill)

Two ADR-0048 D3 / source-alias items. No money moved; no rates/IDs/classifications
invented; pilot mode untouched.

- **Terex equipment-history importer finalized against Janette's real file**
  (`src/lib/equipment/import.ts`, ADR-0048 D3). The pre-receipt flexible header
  detector failed on the real workbook (`could not find a date column ... TEREX
MACHINE MAINTENANCE LOG`). The real file is a 41-sheet `.xlsx`; the importer now
  targets its `"Maintenance Log <year>"` sheets (recognized by name), skips
  unrelated sheets (prices / diesel / monthly tabs), and fails loud (typed 422,
  listing the sheets it saw) ONLY when zero maintenance-log sheets are present. It
  handles the real layout — banner row, asterisk headers with an unlabeled col A,
  the literal `example` row, month-separator / year-marker / subtotal / bare-date
  noise rows (skipped, not thrown) — and maps `Actual Repair Cost` → `cost_cents`
  (kind=repair), cost-less entries → kind=maintenance, with `Amount Credited`
  preserved in the note (the model has one money column; a credit is never a
  negative cost). Contracts unchanged: `source=import`, `import_id`, `source_sha256`
  re-upload no-op, `(site, event_date, kind, note-hash)` idempotency, admin-only
  route, one audit row per batch. The generic CSV path is unchanged. Sanitized
  exceljs fixture (`src/lib/equipment/__fixtures__/build-terex-log.ts`) + tests pin
  per-sheet counts, noise exclusion, skip-sheets, zero-log fail-loud, money/cost_cents
  parsing, and sha idempotency. Real-file dev-loop parse (not committed): Maintenance
  Log 2025 → 55 events, Maintenance Log2026 → 68 events (7 with cost each), 123 total.
  Post-acceptance note added to `docs/adr/0048-june-operational-backfill.md`.

- **Woodland (CA) source aliases backfilled into the repo seed** so a rebuilt DB
  keeps them. 30 evidence-confirmed Woodland-workbook nicknames were inserted
  directly into prod `source_aliases` on 2026-07-21; they now live in
  `WOODLAND_SOURCE_ALIASES` (`prisma/seed/addendum-b-data.mjs`, seeded by
  `seedSourceAliases`) AND a prod-path migration `20260731_woodland_source_aliases`
  (`ON CONFLICT DO NOTHING`, woodland-scoped) — mirroring how the eugene/OR aliases
  were done. Each resolves to a verbatim woodland `sources.name`; a data-invariant
  test guards the 30-count, global-uniqueness (no OR-alias collision), canonical
  resolution against `sources.csv`, and migration parity. `docs/OPEN-ITEMS.md` S-10
  records the 15 still-unresolved June Woodland names (Rick), which block the June
  Woodland promotion (import `ba3beeeb-442d-46ed-ad30-b1a7975906f9`).

### Fixed — 2026-07-21 (Full-stack security/reliability audit — wave 1)

Adversarially-confirmed audit findings, fixed on `fix/audit-wave1`. No money
moved, no rates/IDs/classifications invented, pilot mode untouched.

- **P1-1 — Transportation invoice under-billing (`src/lib/invoices/generation-inputs.ts`)** —
  `resolveTransportationInputs` filtered inbound loads on `status: 'verified'` exactly,
  while the MRC Monthly Invoice export treats four statuses as billing-ready. Any load
  advanced to `submitted`/`submitted_to_mymrc`/`processed` silently dropped its freight
  - CA fuel surcharge from invoice generation. Now reuses the canonical
    `INVOICE_STATUSES` set verbatim (`src/lib/exports.ts`) so generation and the MRC
    export are structurally incapable of drifting. Inventory's `VERIFIED_INBOUND_STATUSES`
    is deliberately left distinct (billing vs verified-on-hand are different contracts).
    DB-idiom test seeds a load in every `LoadStatus` and asserts exactly the billing-ready
    set reaches both the freight and CA-fuel legs.
- **P1-4 — Payroll escalation cron could silently fail on payroll morning
  (`scripts/bonus-escalation-check.mjs`, `src/lib/bonus/escalation.ts`)** — a failed
  tier fire was logged "retry next tick" and dropped; the t4 backstop paged _through the
  app_ (the thing that's down when fires fail); and a period whose whole window was
  missed was keyed to `period_end == yesterday` and stranded forever unpaged. Fixes:
  bounded in-window retry (3 attempts / 15-min spacing, off the daemon's own timers);
  an app-independent direct-to-ntfy backstop page (primary→fallback, fingerprinted, no-op
  when publisher token unset); and t4 broadened to `period_end <= yesterday` so a stranded
  live-deadline period pages every 09:00 run until an operator resolves it (t3 keeps its
  tight `== yesterday` scoping — no late auto-sign). Does not auto-sign late; operator
  intervention is the policy-correct action.
- **P2 — Uncosted collection event silently zeroed its invoice line
  (`src/lib/invoices/event-leg.ts`)** — `fetchEventCostRows` coalesced null `*_cents` → $0,
  zeroing the EVENTO/B8 line and event-freight for an uncosted-but-real event. New pure
  guard `assertEventCosted` (`src/lib/invoices/event-leg-guard.ts`) refuses a component
  only when its billable quantity is present but the paired stored cost is null (per-diem
  only when `overnight`); a stored `0` remains a valid $0 line and zero-activity events
  pass unchanged. Throws typed `EventUncostedError` (status 422) naming the event +
  uncosted components, before the null→0 map. Full `computeEventBilling` wiring stays
  out of scope (seam C-18).
- **P2 — OpenTelemetry W3C Baggage DoS + unbounded Chromium render concurrency
  (`package.json`, `src/lib/chromium-semaphore.ts`)** — bumped `@opentelemetry/*` to the
  fixed, peer-clean paired set (core 2.9.0 line) clearing GHSA-8988-4f7v-96qf and its 26
  cascade advisories (`npm audit --omit=dev` 38 → 12). Added a process-wide single-slot
  FIFO Chromium render semaphore (`withChromium`, typed `ChromiumBusyError` 503 on
  max-wait timeout, permit always released) wrapping all three Playwright launch sites
  (COR PDF, payroll PDF, AP stamp) so concurrent PDF renders can no longer exhaust host
  memory.
- **P2 — Cron containers over-scoped on secrets (`docker-compose.yml`)** — the 10
  internal-cron daemons mounted the app's full `auth.env` (incl. `NEXTAUTH_SECRET` and
  Entra client secret) though they consume only `INTERNAL_CRON_TOKEN`. Split to a new
  single-secret `cron.env` (required, so a missing file fails `docker compose config`
  loudly and non-destructively rather than reproducing the 2026-07-16 silent cron
  blackout as runtime 404s); the app additionally mounts it after `auth.env`. Removed the
  unconsumed `msgraph-*.env` "parity" mounts from ap-poll/workbook-sync. Operator
  follow-ups (create `cron.env`, strip the line from `auth.env`, rotate `NEXTAUTH_SECRET`)
  documented in the ADR-0053 addendum and OPEN-ITEMS O-11 — the secret is contained by
  this change but not un-exposed until rotated.

### Fixed — 2026-07-21 (Addendum-B rollup — review close-out, minor findings)

Close-out pass on the Addendum-B rollup branch before PR. No money moved, no
rates/IDs/classifications invented, pilot mode untouched.

- **TONU state logic (`src/lib/event-billing/tonu.ts`)** — the no-dispatch guard now
  runs FIRST, so a stray `diverted`/`cancelledAt` flag on a never-dispatched order no
  longer bills the haul rate (Rick §5.3: TONU requires a dispatch). The
  dispatched-but-not-cancelled/not-diverted verdict now returns a distinct
  `dispatched_no_bill` reason instead of mislabeling a real dispatch as
  `not_dispatched`. Tests added for both.
- **Event-billing input validation (`src/lib/event-billing/compute.ts`)** —
  `computeEventBilling` now rejects negative/NaN/Infinity `laborHours` and
  `driverOnsiteHours` (finite ≥ 0) and non-integer/negative/NaN `perDiemDays` (Int
  column) with `RangeError`, matching the module's fail-loud money discipline.
  Fractional hours (Decimal(5,2)) still accepted. Tests added.
- **OR collections GP export (`src/lib/invoices/export-json.ts`)** — a `manual`
  adjustment line on an `or_collection_site_count` invoice is no longer stamped with
  the `OREGON MATTRESS` per-mattress item code; it now uses the canonical
  `itemCodeForLineCode` map (→ `null` for `manual`). `GpExportLineV2.item` widened to
  `GpItemCode | null`. Total still reconciles (ADR-0033 tripwire). Test added.
- **Kelsey AP-approver migration guard (`20260730b_addendum_b_seeds/migration.sql`)** —
  the 8/1 → 8/8 `active_until` bump now guards on `active_until::date = '2026-08-01'`
  (day match, TZ-independent on the TIMESTAMP(3) column) instead of exact-timestamp
  equality, so a differing time component no longer silently no-ops (which would let
  the expiry reaper delete Kelsey on 8/1). Still refuses to clobber a manual change to
  another day; idempotent; clean-CI no-op. Post-deploy verification query added to the
  migration comment.
- **Docs** — `SourceSiteType` doc comment no longer lists `Sponsors` as a
  `third_party_inbound` example (§2 reclassified it as a provenance agency).
  `docs/OPEN-ITEMS.md`: S-4 corrected to state OR billing-source `site_type`
  classification is NOT done (folded into the C-16 wiring gate); new **S-9**
  (per-location container-rental roster from Rick — CA $10,800/44, OR $900/6 incl. The
  Dalles $100) and **C-20** (rewire `onHand()` to the `unit_status_movements` ledger).

### Added / Changed — 2026-07-21 (MRC billing Addendum-B rollup — Rick/Mary/Kelsey answers)

Integrates the four Addendum-B workstreams from the 2026-07-21 rollup handoff
(`docs/handoffs/2026-07-21-mrc-billing-addendum-rick-mary-kelsey-rollup-2026.md`).
Pilot mode is untouched; **no live customer rates seeded** and **no mode flipped**.
No monetary values, rates, or IDs were invented — anything unstated is seeded
null/unset and tracked in `docs/OPEN-ITEMS.md`.

**Schema foundation (ADR-0037 amendment + ADR-0056; migrations
`20260730_adr0037b_addendum_b_schema` + `20260730b_addendum_b_seeds`):**

- **Loads/inventory ledger surface** — new `unit_status_movements` (aggregate,
  status-bucketed movement ledger; `UnitStatus` enum `on_floor | saved |
processed | sold | landfilled`, reusing existing `LandfilledReason` where "wet"
  ⇒ `water_logged`), `provenance_agencies` + `inbound_loads.provenance_agency_id`,
  and the 5th `SourceSiteType.svdp_internal_store`. Bare-scalar-FK convention (no
  Prisma relations; constraints in migration SQL), matching existing tables.
- **Event-billing schema** — `event_legs` (+ `EventLegType` enum), `event_vehicles`,
  `collection_events.{driver_onsite_hours, per_diem_days, overnight}`, and
  `tonu_billing`. Added `StateProgramRuleKind.irs_mileage_rate` (no rate rows
  seeded — figures not in the handoff).
- **Seeds** — 5 OR sources renamed id-preservingly to verbatim MyMRC names (incl.
  the verbatim typo "Glenwood Central Recieving Station"); 14 new eugene rows
  (11 `svdp_internal_store` billing-off + The Dalles/Rifes/Roseburg parked);
  22 `source_aliases` rows (retired names + §12 month-to-month variants →
  canonical); 3 provenance agencies (incl. Sponsors, reclassified from a source);
  Kelsey AP approver `active_until` 8/1 → **8/8**.

**Event billing + TONU (ADR-0056 — pure compute layer, `src/lib/event-billing/`):**

- `computeEventBilling` prices the six §5.3 components (per-leg tier transport,
  labor wages, driver wages, per-diem, IRS mileage) and `assessTonu` the TONU
  verdict. Fail-loud on billable-but-unseeded rate (`EventRateUnavailableError` 409) — never silent $0; a zero-activity event totals $0 with all rates null.
  Driver-vs-labor no-double-count is structural. Not yet wired into the invoice
  generator (EVENTO/MILES-0 membership deferred — see OPEN-ITEMS C-18).

**Invoice generation + commodity attachment (ADR-0040/0041 amendments):**

- v2 GP presentation rewritten to the real §10 PDFs: 7 LOCKED GP item codes
  (`LOCATION`/`UNITSMO`/`REIMBO`/`EVENTO`/`MILES 0`/`FUEL`/`OREGON MATTRESS`,
  spaces significant), MILES-0 transportation aggregation + FUEL, and
  REIMBO/EVENTO subtotal lines. Reconciles all four real June invoices.
- Kind-aware PO builder `buildPoNumberForKind` (`M/DD/YY DR3 W` / `DR3 OREGON` /
  `TRANS` / `TRANS OR`, `M/YY OR COLLECTIONS`) and `seedGpSiteBillingConfig`
  corrected to the confirmed identifiers (Woodland `DR3W`→`DR3 W`; Eugene
  null→`MRCL001`/`DR3 OREGON`), `update` branch now re-applies them.
- Invoice-combination guard (`assertValidInvoiceCombination`) rejects illegal
  mid-month/discount pairings; EOM-processing commodity breakdown rendered as a
  computed attachment (`src/lib/commodity/`, pdf-lib, Letter-landscape). Metal→
  Steel/Xtraction-Landfill/Covanta-WTE split awaits Rick (OPEN-ITEMS S-8).

**Floor-inventory dashboard tile (ADR-0037 §3):**

- New per-site floor tile (`src/lib/dashboard/floor-inventory-tile.ts`,
  `src/app/dashboard/[site]/floor-inventory-tile.tsx`) consuming the single
  ADR-0037 `onHand()` pool computation + trailing-7-day closes; program/
  non-program/total on-floor + optional days-remaining projection; refreshes via
  the existing DockPoller. Degrade-never-throw.

**Intake alias normalization (ADR-0037/0038 amendments):**

- `sourceAliasResolver` extended to return `sourceId`, so intake LINKS records.
  Workbook promotion now resolves every inbound `site_name_raw` (writing
  `inbound_loads.source_id`) and REFUSES promotion on any unresolved name
  (`PromotionUnresolvedSourceError` 422, deduped list) — closing a silent-drift
  gap where explicit program splits bypassed resolution. MyMRC upsert gains a
  normalized alias fallback (verbatim `source_name_at_sync` retained on miss).

### Changed — 2026-07-21 (ADR-0037 D7 activation gate → admin-flippable rollout surface)

The loads/inventory + floor-operator activation gate becomes admin-controllable
without a redeploy, reusing the ADR-0047 rollout-surface mechanism. The operator
flips it from the same `/admin/rollout` surface they already use.

- **New rollout surface** `loads_inventory` (UI, per-site) registered in the
  ADR-0047 registry (`src/lib/notify/rollout.ts` `UI_SURFACE`), seeded **born
  `pilot`** (admin-only — today's behavior). State→behavior: `pilot` = admin-only;
  `live` = operators/managers activated for that site.
- **`assertLoadsInventoryActivated` rewired** (`src/lib/loads/record-guards.ts`)
  from hardcoded admin-only to reading the persisted surface via `isUiSurfaceLive`.
  Admin ALWAYS passes (no DB read); operator/manager pass only when the surface is
  `live`; otherwise throws `LoadsInventoryNotActivatedError` (403) exactly as
  before. **Signature change:** now `async` and takes `(role, siteId, db?)`. The
  sole caller — the chokepoint `requireActivatedManager` — awaits it with
  `ctx.siteId`; **no manager route signature changed** (all 14 thread through that
  one call). The loads-inventory dashboard page gate consults the same surface.
- **Default-safe guarantee:** default/unset/unregistered/read-error ⇒ admin-only
  (fail-closed) — a fresh deploy changes nothing until an admin flips it.
- **Migration** `20260729_adr0037_loads_inventory_rollout_surface` — purely
  additive (ADR-0035 clean-replay; sorts after `20260728_ap_not_dr3_location`),
  idempotent (`ON CONFLICT DO NOTHING`), inserts the two per-site rows born `pilot`
  so the surface appears on `/admin/rollout` without a manual re-seed. `seed.mjs`
  also lists it for first-deploy/dev parity.
- **How to activate:** at `/admin/rollout`, flip `loads_inventory` (per site) from
  `pilot` → `live` with a criteria note (admin-only + audited); revert is the
  inverse flip. No code deploy.
- **Docs:** ADR-0037 D7 amended; ADR-0047 records `loads_inventory` as a surface.
- **Tests:** `src/lib/loads/record-guards.test.ts` (admin-always-passes/no-DB-read,
  operator+manager blocked at pilot/unregistered/read-error [default-safe],
  allowed at `live`, 403 shape, registry sync) + a `loads_inventory` flip case in
  `src/lib/notify/__tests__/flip.test.ts` (pilot→live, audited).

### Added — 2026-07-20 (ADR-0046 amendment: third AP location disposition "NOT DR3 — See Reason")

Accounting-critical. The AP approval portal's location dropdown (Woodland / Eugene)
gains a third option, **NOT DR3 – See Reason**, for an invoice that is not for a DR3
location at all (mis-addressed, wrong entity, a parent-org bill). Choosing it requires
a reason and records the decision WITHOUT filing it against a real site's books.
Migration `20260728_ap_not_dr3_location` (purely additive, ADR-0035 clean-replay;
sorts after `20260727_adr0041_pilot_mode_gp_export`; default false backfills every
existing row as a normal site-filed decision).

- **Schema.** `ap_requests.filed_not_dr3 Boolean @default(false)` + a partial DB CHECK
  (`NOT (filed_not_dr3 = true AND site_id IS NOT NULL)`) enforcing the "never both"
  half of the location invariant (deliberately partial so historical NULL-site rows
  stay valid).
- **Location invariant (app-enforced in `decideRequest`).** A decided row is EXACTLY
  ONE of: site-filed (`site_id` NOT NULL, `filed_not_dr3 = false`) OR NOT-DR3
  (`filed_not_dr3 = true`, `site_id` NULL, reason required) — never both, never
  neither. New `ApLocationConflictError` (400) guards "both"; the reason requirement
  reuses `ApNoteRequiredError` (400). The existing site-required path is unchanged.
- **Route** `POST /api/ops/ap/[id]/decide` accepts `notDr3?: boolean`: rejects
  `notDr3 + siteId` (mutual exclusion, 400), rejects `notDr3` without a non-empty note
  (400), and files NOT-DR3 without resolving/asserting a site.
- **UI.** The `NOT DR3 – See Reason` option (field relabeled **Location**) shows an
  inline "reason required" hint, disables Approve until a reason is entered, and posts
  `notDr3: true` instead of a `siteId`.
- **Accounting surfaces.** So Mary never mistakes it for a DR3-site invoice, the
  decision email (subject `— NOT DR3`; body `NOT DR3 — see reason: <reason>` leading
  the facts) and the stamped PDF/cover/image (per-page stamp line `— NOT DR3 (see
reason)`; meta block `Location: NOT DR3 — see reason: <reason>`) render the
  disposition in the same slot the site name occupies today.
- **Tests.** NOT-DR3 persistence (filed_not_dr3=true + site_id NULL), reason-required
  (rejects empty note, approve AND reject), mutual-exclusion rejection, mail/PDF NOT-DR3
  rendering, and a regression that the Woodland/Eugene path still requires a real site.
  Full suite green: 2214 passed, 2 skipped.

### Added — 2026-07-18 (ADR-0041 amendment: SIMPLIFIED invoice generation — pilot mode, program split, GP v2 export; rollup §A.1/§A.7/§4.2/§8.3)

Billing-critical, launch-facing. Extends the accepted ADR-0041 invoice engine (nothing
rebuilt — the immutable-version discipline, pure math, trust gate, and credit-memo /
void-and-reissue state machines are unchanged and verified to still integrate). Migration
`20260727_adr0041_pilot_mode_gp_export` (purely additive, ADR-0035 clean-replay; sorts
after `20260726_adr0040_rate_infrastructure`; `invoices.mode` defaults `pilot` so every
pre-existing row backfills safely — nothing on file can reach MRC until an admin flips it).

- **B10-5 CLOSED (§A.1).** The invoice math is single-line (`program_units_processed ×
rate + trade_discount`) — no commodity→invoice-block mapping is required for billing.
  Compliance commodity classification (recycling rate) stays a separate concern
  (ADR-0043/0055). Both ADR-0041 and ADR-0043 doc references updated.
- **Pilot / production mode (§3.4) — the launch safety net.** `InvoiceMode` enum + the
  `mode` column (default `pilot`). `src/lib/invoices/delivery.ts`: `planInvoiceDelivery`
  is a TOTAL function on `mode` with NO branch that yields MRC recipients / `sendsToMrc`
  for pilot — a pilot invoice is structurally undeliverable to MRC; `assertProductionForMrc`
  is the tripwire a future sender calls. Pilot previews route to `invoice_pilot_recipients`
  (Bill + Rick, seeded). `invoice_mode_config` (per site+kind; no row ⇒ pilot) is the admin
  flip via `POST /api/manager/[site]/invoices/mode` (authorized like approval). No live MRC
  sender exists yet — the boundary ships first (mirrors the frozen export contract).
- **Program vs non-program split (§8.3).** `invoices.program_units_processed` (billable
  basis, == B6/B20 line quantity) + `invoices.non_program_units_processed` (tracked,
  off-invoice). Aggregated from `processed_units_daily.stripped_program` /
  `stripped_non_program` and persisted on processing invoices.
- **Two-line GP export v2 (§4.2), C-1 bump.** `invoiceExportV2` ships ALONGSIDE the FROZEN
  v1 (`export-json.ts`); `GET …/export?format=json&v=2` (v1 stays default). Carries the
  §4.2 two-line processing structure (header + "MRC-Processed Units DR3 <Site>" UNITSMO)
  - Subtotal/Misc/Tax/Freight/Trade-Discount/Total, the GP header identifiers, the split,
    and the trade-discount fields; the v1 leaf lines are also carried (nothing lost). GP
    total reconciles to `invoice.total_cents` (ADR-0033 tripwire).
- **GP identifiers (§4.2).** `gp_billing_config` (singleton: MRC Bill-To/Ship-To — Attn
  Ryan Trainer, 501 Wythe Street, Alexandria VA 22314; Sales ID 34; Net 30) +
  `gp_site_billing_config` (Woodland: Customer ID MRCL001, PO suffix DR3W). OR MRC Customer
  ID + Eugene PO suffix left NULL — pending Mary, never invented. CA processing rate reuses
  `state_program_rules` ($16.50/unit), not re-seeded.
- **Tests:** delivery (pilot never reaches MRC, structural) · gp-identifiers (PO format,
  null-unknown rule) · export-v2 (two-line shape, EOM subtracts mid-month, reconciliation,
  v1 frozen, OR/Eugene null) · program/non-program split on the composer. Suite 2173 green.

### Added — 2026-07-18 (ADR-0040 amendment: MRC billing rate infrastructure; rollup §8.2 + §3.3/§3.5/§3.6/§3.7)

Billing-critical. Extends the accepted ADR-0040 rate infrastructure with the MRC
billing-composition + transitional-freight rules. Migration
`20260726_adr0040_rate_infrastructure` (purely additive, ADR-0035 clean-replay) —
ONE enum + ONE table only; the rest is resolver code over EXISTING rate tables.

- **Per-source OR service rates (§3.3).** New `source_service_rates` table +
  `SourceServiceRateKind` enum (`trans`/`trailer`/`per_mattress`/`mrc_unit`) — per-source,
  effective-dated rates for the OR billing components, mirroring the existing
  `account_haul_rates` shape. Resolver `src/lib/billing-rates/service-rates.ts`
  (`resolveSourceServiceRateCents`) picks the in-force row, detects same-`effective_from`
  ties, and throws `ServiceRateUnresolvableError` when none is in force (never a silent $0).
  **No rows seeded here** — the §7 seed PR loads the OR sources (The Dalles effective
  2026-06-01; the rest 2026-01-01) after this merges.
- **Per-site-type billing composition (§3.2/§8.2).** `src/lib/billing-rates/site-type-billing.ts`
  (`resolveSiteTypeBilling`) maps a source's `site_type` → the component set
  (mrc_inbound = trans+trailer+MRC unit; cvp_retailer = trans+trailer; collection_site =
  trans+trailer+per-mattress+MRC unit; third_party_inbound = MRC unit only), then applies the
  ADR-0037 `bill_trans`/`bill_trailer` overrides with **suppress-only** semantics (a flag can
  turn a defaulted component OFF, never ON — Cottage Grove pattern). `active_billing=false`
  suppresses all; an active source with no `site_type` throws `SiteTypeUnclassifiedError`.
- **Transitional Woodland freight (§3.5).** `src/lib/billing-rates/woodland-freight.ts`
  (`resolveWoodlandFreightCents`) — for any Woodland (CA) load, freight is ALWAYS priced off
  the source's Primary rate + Primary mileage regardless of site Assignment. Delegates to the
  audited `resolveFreightCents` (one money path): override = Primary rate; tier = Event Mile
  Rate fallback; else `FreightUnresolvableError`. Rejects a non-CA source with
  `WoodlandJurisdictionError`. The CA non-Woodland / normal-Assignment path is unchanged.
- **Event Mile Rate resolver (§3.7).** `src/lib/billing-rates/event-mile-rate.ts`
  (`resolveEventMileRateCents`) — the named, fail-loud mileage→flat-rate lookup used by the
  Woodland fallback. **No new table:** the Event Mile Rate tier IS the already-seeded CA
  `transport_rate_tiers` set (identical 7 bands, Variables!D6:F13), so this reuses those rows
  rather than forking a second source of truth for the same numbers. Out-of-range throws
  `EventMileRateOutOfRangeError`.
- **Container rentals never prorated (§3.6, closes C-10).** `src/lib/billing-rates/rental-billing.ts`
  encodes the policy explicitly (`monthWindowUTC`, `rentalOverlapsMonth`, `billedRentalCents`):
  any month-overlap bills the FULL monthly rate — a rental starting on the 28th and spanning
  into the next month bills full in BOTH months. `resolveRentals` (generation-inputs.ts)
  refactored to share the pure helpers so the DB query and the policy can't drift. This
  confirmed + locked the existing behavior (it already never prorated).
- **OR fuel surcharge skip (§6.5) — confirmed, no change.** The CA-only gate was already
  enforced by `resolveProgramRule` (throws `RuleStructurallyDisallowedError` for an OR
  fuel-surcharge lookup before any price is read) and covered by an existing test; the
  transportation composer also refuses `or_transportation_no_fuel`.

### Added — 2026-07-18 (ADR-0042 amendment: mid-month COR; rollup §4.1 + §8.4 + §9.2)

Billing/compliance. The COR (Exhibit 5) form is filed for BOTH the end-of-month
close and a mid-month period; Rick files the mid-month version with Inventory + FT +
PT **blank** (Signature + Date only). Migration `20260726_adr0042_midmonth_cor`
(purely additive, ADR-0035 clean-replay: one enum + one defaulted column + one
NOT-NULL widening). See `docs/adr/0042-cor-generator.md` "Amendment — 2026-07-18".

- **`period` discriminator.** New enum `CorPeriod { end_of_month, mid_month }` +
  column `cor_certificates.period NOT NULL DEFAULT 'end_of_month'`. The default
  backfills every existing row and caller — all current behavior is preserved.
- **Nullable inventory.** `cor_certificates.inventory_units` widened to `Int?`: a
  mid-month cert stores `NULL` (never a placeholder `0`). `inventory_source` stays
  `NOT NULL` with a typed `mid_month_blank_adr0042_amendment` marker (honest
  provenance, no fabricated figure).
- **Mid-month fork (EOM path untouched).** `computeCorPrefill` short-circuits before
  any ledger query for mid-month (inventory/FT/PT blank, signer only). The D2.1/D3
  reconcile tripwire (`assertCorInventoryReconciles`, in BOTH `finalizeCor` and
  `generateCorPdf`) is **end-of-month only** — mid-month returns a passing `skipped`
  result. `finalizeCor` requires the FT/PT split ONLY for end-of-month. The internal
  print page renders inventory/FT/PT/total **literally blank** for mid-month (no
  em-dash, no `0`), suppresses the balance note, and labels "Mid-month filing". The
  display-only **capacity banner is end-of-month only**.
- **Period-scoped version chain.** A mid-month and an end-of-month certificate for
  the same `cover_month` are independent immutable-version chains and never void one
  another (`generateCorDraft` + `getCorDetail` filter on `(site, cover_month,
period)`; supersede stays in-period).
- **UI + API.** `POST /api/manager/[site]/cor` accepts `period`; the manager COR
  surface adds a filing-period selector and renders mid-month certs with blank
  figures + a "mid" chain tag.
- **Fixtures → 3,977.** All COR fixtures updated from the stale **4,062** to the
  ADR-0037-corrected **3,977 (3,748 program + 229 non-program)**; `prefill.test.ts`
  now reproduces it through the D6 running balance using the same Processed-ledger
  totals as the §2.3 close (cross-validating `onHand` vs `computeInventoryClose`).
  New mid-month tests: prefill blanks + signer, reconcile skip, finalize without
  headcount, and the end-of-month gates still firing.
- **Signer title** "Transportation Manager" (Richard Albritton) confirmed correct —
  no change.

### Added — 2026-07-18 (ADR-0055: recycling-rate configuration + outbound stewardship derivation; rollup §A.4)

Answers the workbook `B10-5` / `%` column. Recyclers count different fractions of a
load as recycled vs landfilled (Green Zone metal 100%; Xtraction metal 81%/19%;
Biomass wood 100%). These splits feed CalRecycle stewardship (O-7) — they are NOT
billed (ADR-0041). Migration `20260726_adr0055_recycling_rates` (purely additive).

- **`outbound_vendors`** — GLOBAL recycler master (mirrors `transporters`, not the
  site-scoped `sources`). Formalizes the free-text `outbound_materials.buyer`.
  `outbound_materials` gains a nullable `vendor_id` FK (legacy `buyer` retained for
  backfill/reconciliation).
- **`recycling_rates`** — effective-dated `recycling_percent` (`Decimal(5,4)`, DB
  `CHECK [0,1]`) per `(vendor, commodity)`, commodity reusing the existing
  `OutboundCommodity` enum (**steel → `metal`**; Biomass is a `wood` vendor — no
  parallel enum). Resolver `src/lib/loads/recycling-rates.ts` mirrors the
  `state_program_rules` pattern (latest covering `effective_from` wins). Overlap is
  guarded three ways: partial-unique on open windows + a transactional
  advisory-locked write guard (`createRecyclingRate`) + a resolver throw on any
  double-cover.
- **Outbound derived fields** — `recycled_lbs`, `landfilled_lbs`,
  `recycling_percent_applied` (durable snapshot), `recycling_rate_id` (provenance),
  computed at entry time from `(vendor_id, commodity, ship_date)` and re-derived on
  edit. Rounding rule: `recycled = round_half_up(weight × pct)`, `landfilled =
weight − recycled` (**complement by subtraction → exact sum, no pound drift**).
  Worked example: 5,541 lb @ 0.81 → **4,488 recycled / 1,053 landfilled** (see the
  ADR's flagged 1-lb delta vs Kelsey's verbal 4,487/1,054 — an 80.98% split, not
  the nominal 0.81; seeded rate stays 0.81 pending confirmation).
- **No-rate policy** — when no rate covers `(vendor, commodity, date)`, derived
  fields are left **null and flagged**, never assumed 100% (would over-report to
  CalRecycle).
- **Seeds** — the three confirmed rates only; other wood-recycler rates PENDING
  Morena (not invented).
- **iPad outbound entry** — recycler picker + live recycled/landfilled preview
  (`GET …/outbound/{vendors,rate-preview}`) wired to the same resolver the save path
  uses, plus two new table columns.
- **O-7 seam** — CalRecycle stewardship reporting consumes these fields; the
  reporting surface is a separate feature (not built here).

### Added — 2026-07-18 (ADR-0037 amendment: inventory + sources foundation; rollup §8.1)

Billing-critical. The MRC billing tune-and-launch foundation. Migration
`20260725_adr0037_inventory_foundation` (purely additive, ADR-0035 clean-replay).

- **Correct-arithmetic inventory close (§2.3).** New `src/lib/inventory/inventory-close.ts`
  (`computeInventoryClose`) computes the month close via the CORRECT arithmetic —
  `program_close = program_open + program_inbound − program_stripped`;
  `non_program_close = non_program_open + non_program_inbound − non_program_stripped −
saved_units`; `total = program_close + non_program_close − sold − landfilled` — NEVER
  the workbook's latently-buggy `D45`/`D48` formulas. The authoritative pool aggregates are
  read from the workbook's own **Processed sheet** (per-day F/G/D/E/H/I + opening D5/F5 +
  the DAY `Saved` box), exposed on `ParsedWorkbook` as `inventoryLedger` + `inventoryClose`.
  **The corrected June workbook (SHA `1eeeccb…`) closes to 3,977 (3,748 program + 229
  non-program)**, verified against the real oracle: programInbound 19,451, nonProgramInbound
  229, programStripped 17,126; cross-checked against the DAY31 Ending-inventory cell (3,977).
  This SUPERSEDES the prior 4,062 figure — that was the raw DAY per-shipment grid over-sum
  (+85 from DAY23's `NP`-marked Recology Healdsburg row, which the workbook's `F = I38 − L39`
  accounting nets out). The parser stages an `inventory_ledger` staging row and the ADR-0048
  promotion close (D2) reads it, so `expectedCloseTotal` for June Woodland is now 3977.
- **§1.1 sequential depletion** (`sequentialDepletion` / `depleteSeries`): program-first —
  non-program is stripped only once the program pool is exhausted (no-op for June, E40 = 0).
- **§A.2 `saved_units`** wired into the shared `computeRunningBalance` — subtracts from the
  non-program pool (was previously excluded from all inventory math). `onHand` + the
  promotion close pick it up (0 for June).
- **Sources site-billing taxonomy (§3.2):** `Source.site_type` (`SourceSiteType`:
  mrc_inbound/cvp_retailer/collection_site/third_party_inbound), `Source.active_billing`
  (Roseburg pattern), `Source.bill_trans` + `Source.bill_trailer` (Cottage Grove overrides).
- **Pool routing (§3.2, §A.5):** `src/lib/inventory/pool-routing.ts` — the single
  inbound-channel → pool map. Illegals + unpaid + collection + events → program pool;
  non_program → non-program pool. No new `illegal_dropoff` enum — `ConsumerDropoffKind.illegal`
  already carries it.
- **Consumer drop-off traceability (§1.3):** `ConsumerDropoff.consumer_name` (optional CIP
  PII) + `incentive_amount_cents` (explicit unpaid check amount, default `units × 300`¢,
  overridable). Wired through the dropoffs service + manager API.
- **§A.6:** the stale `Summary!` / `Trans Summary!` tabs are advisory only and never feed
  billing aggregation — surfaced via the `[summary-stale]` parse flag.
- **Docs:** new `docs/parsers/woodland-daily-log-schema.md` (§2.2 cell-reference table + the
  F9/D45/D48 workbook-bug notes); ADR-0037 amendment section.
- **Tests:** `inventory-close.test.ts` (incl. the explicit June 3748/229/3977 assertion +
  the D45-bug guard), `pool-routing.test.ts`, and new woodland reconciliation assertions.
- **STAGING ONLY** — no promotion WRITE path was run or modified (operational-table inserts
  are unchanged; only the close-VERIFICATION math is now authoritative). tsc + full vitest +
  prod build green.

### Fixed — 2026-07-17 (CRON incident: missed daily report + silent 503)

Production-hardening follow-up to the 2026-07-16 cron outage. Root cause: the
audit's new `guardInternalCron` fail-closed branch returns **503 for every
internal cron when `INTERNAL_CRON_TOKEN` is unset in prod** — and the token had
**never been provisioned**, so ALL internal crons 503'd. The daily production
report was missed for both sites (2026-07-16) and the 503 was silent until a
human spotted the gap. Token is now provisioned in `auth.env`; these two changes
let us backfill the miss and prevent a silent recurrence.

- **Date-parameterized daily-report BACKFILL.** `runDailyReportFire(now, opts)`
  gained an optional `{ forDate?, siteCodes?, force? }`. With `forDate` (a Pacific
  `@db.Date` key) it uses that day directly as the `dayKey` and **bypasses the
  "not due yet" send-time gate** (a past day is always due) while keeping every
  other guard — weekend (read on the TARGET day in UTC, not the run instant),
  holiday, `skip_if_zero`, `(site, report_date)` idempotency, recipient
  resolution, the REAL (non-`[TEST]`) subject, the roster send, and the
  `bonus_daily_report_log` row write. `force` re-sends over an existing row
  (reuses it — the unique constraint forbids a second — and re-finalizes
  delivery). No `forDate` → behavior is byte-identical to the scheduled path.
  Exposed on `POST /api/internal/bonus/daily-report` (behind `guardInternalCron`):
  an optional JSON body `{ date?: "YYYY-MM-DD", siteCodes?: string[], force?: bool }`.
  No body → the unchanged scheduled tick (daemon sends none). A body runs ONLY
  the targeted backfill (the alert/update-digest riders are the scheduled tick's
  concern, keyed to "now", and are not re-fired for a historical re-send).
  Idempotent: a second call is `skipped_already_logged` unless `force`.
  Files: `src/lib/bonus/daily-report-runner.ts`,
  `src/app/api/internal/bonus/daily-report/route.ts`.
  _This is the tool used to re-send the 2026-07-16 report to both sites after
  deploy._

- **Unset `INTERNAL_CRON_TOKEN` in prod is now LOUD.** `guardInternalCron`'s
  503-unconfigured branch fires a fail-soft ntfy page (`dr3-vision-system`,
  priority `high`, tags `cron,config,dr3-vision`, fingerprint
  `dr3-vision-internal-cron-token-unset`, 30-min cooldown per ADR-0037) so a
  missing token can't silently strangle every cron again. The 503 stays
  (fail-closed is correct); the alert is non-blocking (fire-and-forget — the
  guard stays synchronous across its 12 call sites) and never throws out of the
  guard. File: `src/lib/internal-auth.ts`.

- **Tests.** Backfill: past-day `forDate` sends+logs to the roster (real subject,
  not-due bypassed), idempotency (second call skips unless `force`), `force`
  reuse-over-existing (+ P2002 race), weekend/holiday/zero still skip on the
  target day, `siteCodes` filter, route body wiring (forDate/siteCodes/force,
  422 on bad date/site, no-body unchanged, digests not re-fired). Guard: unset-prod
  path attempts the page (mocked) and still 503s, publish-throw still 503s,
  token-set + non-prod never page.

### Changed — 2026-07-17 (ADR-0048/0049 §8.2: source inbound from the DAY grid — close now reconciles)

Billing-critical follow-up to the parser finalization below (operator-approved).
The first pass sourced promotable `inbound_loads` from the category sheets
(`inb_trans_charges`/`inb_no_trans_charge`/`nonprogram`) — only the **B2B/trans
subset** (June 5220 units / 57 loads), so a flow-recompute of the close was
wildly wrong (June −10209 vs authoritative 4062). Fixed: `inbound_loads` **and**
`consumer_dropoffs` now come from the **DAY per-day INBOUND grid** (the complete
all-channel inbound — B2B hauls + unpaid/incentive/illegal drop-offs), located
below each DAY sheet's inbound header and bounded by the OUTBOUND single-list /
OUTBOUNDS marker. The `commodity` column classifies each row's channel. The
staged inbound-unit total now equals the workbook's own per-day INBOUND total
**exactly** (June 19765, July 8822), and the flow-recomputed close **reconciles
to the authoritative workbook close: June = 4062, July = 2577** (verified via
`decodeStagingRows` → `computeRunningBalance` against the real oracles). The
category sheets (+ `incentive_unpaid`) are the same rows re-categorized for
billing — now staged as **evidence** (section `detail`), never promoted, so
there is no double-count. Fixture gained a DAY inbound grid; new
reconciliation + inbound-sourcing tests. Residual flags retained (processed date
construction, drop-off `personName`, opening-inventory non-program begin).
STAGING ONLY — no promotion write invoked. tsc + full vitest (2084) + build green.

### Changed — 2026-07-17 (ADR-0048/0049 §8.2: finalize the workbook parser against the REAL Woodland files)

Billing-critical. `parseWorkbook` matched sheets by exact lowercase name
(`summary`/`inbound`/`outbound`/`inventory`) — sheets the real Woodland daily-log
workbooks do not have — so it returned **0 staging rows** and
`templateGeneration='unknown'`. Rewired the parse path to address sheets by
`classifyWorkbookSheets` **semantic type** (new `section-extractors.ts`), so the
real June + July files now parse into promotion-consumable `StagingRow`s
(June: 273 rows, July: 237) that `decodeStagingRows` accepts. Extractors:
inbound (`inb_trans_charges`/`inb_no_trans_charge`/`nonprogram` → `inbound_loads`),
outbound (DAY0–31 per-shipment grid → `outbound_materials`, incl. DAY6's 9th
COTTON block), processed (`Day N` close → `processed_units_daily`), drop-offs
(`incentive_unpaid` → `consumer_dropoffs`), opening inventory, and best-effort
Summary figures (still feed `recomputeSummary`/`resolveInboundSites`).
Rollup sheets (`commodities`/`renovation`/`all`) are staged as **evidence only**
(section `detail`, promotion-skipped) — they are the DAY grid rolled up, so
promoting them would double-count. The **authoritative month-close** is now read
from the workbook's own "Ending inventory" cell (June = **4062**, July = **2577**;
July's opening = June's close, cross-validated) rather than the stale hardcoded
`4062`. Fixed a real crash: `cells.ts` `cellText` threw `RangeError` on invalid
Date cells present in the real files. Reconciled `day-sheet-layout.ts` to the
real grid (blocks anchor col **3** not 4; 7 standard fields not 8; DAY6 cotton at
col 68 + `revenue`). Backward-compatible: the legacy ADR-0039 synthetic path is
kept (branched on the `figure_key` Summary signature); all prior parser/resolver/
day-sheet/summary-recompute tests stay green. New `parser-woodland.test.ts` +
synthetic Woodland fixture. **STAGING ONLY** — no promotion write path was
invoked or modified. Every ambiguous mapping (nonprogram=inbound-not-outbound,
inbound-completeness gap, processed date construction, drop-off `personName`,
DAY-outbound `subCategory` default) is surfaced in `ParsedWorkbook.flags` for
operator review before promotion. tsc + full vitest (2082) + prod build green.

### Security — 2026-07-16 (D3: nonce-based CSP — drop `script-src 'unsafe-inline'`)

Operator-directed. Replaced `script-src 'unsafe-inline'` with a **per-request
nonce** so CSP is a real XSS control on this finance app (ADR-0053 D3). The CSP
moved out of `next.config.js` into `src/middleware.ts` (single source): the
middleware mints a base64 nonce per request (Web Crypto, edge-safe), forwards it
on the request headers so Next auto-stamps its own bootstrap scripts, and sets
the response CSP. `script-src` is now `'self' 'nonce-…' 'strict-dynamic'` with no
`'unsafe-inline'`; added `object-src 'none'`, `base-uri 'self'`, `form-action
'self'`. `style-src 'unsafe-inline'` kept (Tailwind, no code-exec). The login
FOUC guard now carries the nonce via `next/headers`. Per-route `frame-ancestors`
survey exception + `X-Frame-Options` distinction preserved. New unit tests
(`src/lib/csp.ts` builder + middleware wiring). tsc + full vitest + prod build
green. ADR-0053 D3 → done. Auth/middleware logic unchanged.

### Added — 2026-07-16 (O-2: admin file-drop inbox)

Operator-directed (O-2): _"just allow me to upload [files] in the vision portal
and then you can settle out what they are and where they belong… I can just dump
the data there."_ New admin-only **File Drop** capture inbox at
`/admin/file-drop`. Bill drops ANY file (any content-type, ≤100 MB); the system
stores it in R2 under `file-drops/<id>/<sanitized-name>` and records one manifest
row. Downstream classification/routing stays a human step (Claude Code reads the
manifest + downloads objects) — this ships **only** the capture surface, no
parsing/promotion.

- **Schema:** additive `file_drops` table + `FileDropStatus` enum (migration
  `20260724_admin_file_drops`, ADR-0035 clean-replay; sorts after `20260723`).
  `uploaded_by` is a bare audit-actor id (no FK, like AP `held_by`/`decided_by`).
- **Upload:** server-buffered multipart (matches the workbook/AP server-side R2
  put path — admin uploads from a browser). New `putFileDrop` / `signFileDropDownload`
  helpers in `src/lib/r2.ts`; R2 is fail-soft (unconfigured → `pending-r2-filedrop-…`
  placeholder key so capture never fails).
- **Classification:** `classifyFileDrop` pure fn (advisory `detected_kind` hint —
  `.xlsm`/`.xlsx`→workbook, `.pdf`→pdf_document, `.csv`→csv, `image/*`→image,
  else other). Never routes anything.
- **Routes** (all admin-gated, audited): `POST/GET /api/admin/file-drops`,
  `PATCH /api/admin/file-drops/[id]` (status/note), `GET …/[id]/download`
  (presigned). Create + status/note changes write `audit_log` rows
  (`table_name = file_drops`).
- **Surface:** deep-space themed `/admin/file-drop` page + client (dropzone,
  multi-file picker, manifest list with per-row download / status / note; no
  `<form>` per hard rule #10). Discoverable via a new admin-only **File Drop**
  dashboard tile (`Upload` icon) and an Admin-hub link.
- **Docs:** `docs/operator/file-drop.md`.

### Security — 2026-07-16 (D4: AP sender-trust comments corrected; DMARC verified)

Verified `svdp.us` DMARC is `p=reject` — external forgery of `@svdp.us` into
the AP mailbox is blocked upstream by DMARC + EOP. Corrected the misleading
"authenticated envelope" comments in `ap/senders.ts` + `msgraph-mail/normalize.ts`
to state that sender trust rests on the From header + the DMARC/EOP posture
(a documented hard precondition), not a cryptographic envelope. ADR-0053 D4 → done.

### Security — 2026-07-16 (ADR-0053 D2: session revocation kill-switch)

Operator-directed. Closes the audit's `JWT` high — a demoted / deactivated /
fired manager kept full token-cached powers (approve amendments, void invoices,
exports, `/admin/*`) until the 12h idle / 30d absolute cap. New additive
`users.sessions_invalidated_at` column (migration
`20260723_user_sessions_invalidated_at`, ADR-0035 clean-replay) is bumped in the
same audited mutation whenever an admin changes a token-cached claim (`role` /
`all_sites`) or deactivates / soft-deletes a user. The Auth.js jwt callback (Node
pass) now re-reads `is_active` / `deleted_at` / `sessions_invalidated_at` fresh
on every request and empties the token — forcing re-auth — when the user is
inactive/deleted or the switch post-dates the token's `iat`. Off-boarding is
effectively **instant**; a demotion re-mints fresh claims on the forced re-auth.
The DB read is a Node-only injected checker, so the edge middleware stays
Prisma-free (Middleware bundle unchanged). Defense-in-depth on top of the Entra
`signIn` gate; idle/absolute timeout preserved. Residual: an `is_super_admin`
demotion (raw-SQL only, no app path) must set `sessions_invalidated_at` in that
SQL to revoke a live super-admin session. tsc + full vitest (+19 tests) + lint +
prod build green. ADR-0053 D2 → done.

### Security — 2026-07-16 (D1+D5: Next.js off the middleware-bypass advisory + CVE clear)

Operator-directed. Bumped `next` 15.5.15 → 15.5.20 (patched < 15.5.18;
non-breaking within `^15.5`), clearing the App-Router middleware/proxy-bypass
and Server-Components DoS **high** advisories on the auth-boundary framework.
Non-force `npm audit fix` cleared the remaining in-range prod highs
(form-data, ws) + moderates without any framework/breaking change. Residual
high/critical are dev-only vite/vitest (not shipped). ADR-0053 D1/D5 → done.

### Changed — 2026-07-16 (ops-ledger task assignee widened to managers)

Operator call: the ledger task-assignee picker (shipped same day scoped to
admins only) now offers **admins + managers** (`listAssignableOwners` /
`assertAssignableOwner`), so site/all-sites managers like Daven can own
follow-ups. Operators remain non-assignable; the server still 422s a
non-assignable id.

### Added — 2026-07-16 (ADR-0052 BUILT: commodity payment reconciliation v1)

Bill approved D1–D3 as proposed and ordered the build. New
`outbound_material_payments` companion table (additive migration
`20260721_commodity_payment_recon`), forward-only status transitions with
audited provenance, `/dashboard/ops/commodity-payments` view (org reach —
admin/all-sites; both sites, aging, CSV) + launcher tile, and the
`m3_commodity_payment_aging` audit check (30d ship→invoice / 45d
invoice→paid, per-buyer rollup, bootstrap-gated on first payment entry,
digest-routed). ADR-0052 → Accepted.

### Added — 2026-07-16 (ops ledger: email link + assign-to-admin, ADR-0045 amendment)

The daily digest now always carries an "Open the ops ledger" button (was
tasks-only) so the team can reach the ledger from any digest email. Ops tasks
can be assigned to a particular admin — create-form + per-row admin picker,
server-validated (`assertAssignableAdmin`, 422 on a non-admin), audited
reassignment (`reassignTask`), owner shown in the queue. Ledger tile was
already live (manager+, alert_digest surface).

### Fixed — 2026-07-16 (money-path & audit-integrity audit batch — 2026-07-16 full-stack audit)

Remediated the money-path & audit-integrity findings from
`docs/security/2026-07-16-full-stack-audit.md` (branch `fix/audit-money-integrity`):

- **H1 (HIGH) — Amendment approve/reject had no CAS.** `applyApprovalInTx` /
  `applyRejectionInTx` now flip `pending→approved/rejected` via a guarded
  `updateMany({ where: { id, state: 'pending' } })` as the first mutation; the
  loser gets a `count 0` → `request_not_pending` (409) and its daily-entry
  mutation + audit never run. Closes the window where two reviewers could both
  pass a check-then-act gate and leave an entry mutation standing under a
  `rejected` state with a falsified `before: pending` audit. Group approve/reject
  CAS each member via the shared helpers.
- **M2 (MEDIUM) — AP decide flip + audit not atomic.** `writeAudit` gained an
  optional `{ tx }` client (all existing callers unchanged); `decideRequest`'s
  winning flip + its audit now commit in one `prisma.$transaction`, so a crash
  between them can no longer strand a live, unaudited decision. Email/stamp/R2
  work stays outside the tx (a committed decision never rolls back on a mail
  failure).
- **M1 (MEDIUM) — Late daily-report immediate-send not atomic.** Both the on-save
  (`daily-report-late`) and scheduled (`daily-report-runner`) paths now
  claim-before-send: they atomically create (or CAS-`updateMany`) the
  `(site_id, report_date)` log row as the claim BEFORE the Graph send; a P2002 /
  `count 0` bails without sending. Prevents duplicate production reports from a
  double-click or an on-save/scheduled race. Delivery columns finalized after the
  send; fail-soft preserved.
- **M3 (MEDIUM) — Credit memos had no cumulative cap.** `createCreditMemo` now
  enforces `Σ(applied + in-flight non-terminal memos) + amount ≤ invoice.total_cents`
  (aggregate + pure `assertWithinCumulativeCap`, typed `cumulative_exceeds_invoice`
  422). Per-memo and single-open guards retained.
- **L2 (LOW) — Credit-memo tail write unaudited.** `transitionCreditMemo`'s
  `superseding_invoice_id` write is folded into a `$transaction` with its audit
  row — the last unaudited credit-memo mutation is now on the trail.
- **M4 (MEDIUM) — AP client truncated comma currency.** `ApQueueClient` now
  normalizes the amount via `parseUsdToCents` (strips US thousands separators,
  rejects `$`-prefixed/ambiguous input with a message instead of silently coercing
  `1,234.56`→`$1.00`); `inputMode="decimal"` retained.
- **F7-AP (LOW) — AP free-text uncapped.** The decide route caps `note` (≤2000)
  and `vendor` (≤200), returning 400 on overflow before any state change.

Unit tests added/extended for each fix; `tsc` clean, full `vitest` suite green,
lint clean on changed files. Survey/input/infra findings are owned by the
parallel hardening pass and untouched here.

### Security — 2026-07-16 (input-validation + infra hardening — audit 2026-07-16)

Remediated the input-validation / infra findings from
`docs/security/2026-07-16-full-stack-audit.md` (branch `fix/input-infra-hardening`).
Money/AP-integrity findings (H1/M1/M2/M3/M4) are a separate parallel batch.

- **SSRF (HIGH)** — the body-only AP decision PDF re-render no longer fetches
  attacker URLs server-side: remote `<img>` src is rewritten to `about:blank`
  before render (`neutralizeRemoteImageSrcs`), the Playwright renderer intercepts
  and aborts every non-`data:`/`about:` request, and `waitUntil` moved from
  `networkidle` (30s) to `load` (15s bounded). Stamped-original pdf-lib path
  unchanged. (`src/lib/ap/stamp.ts`)
- **CSV formula injection (MED)** — `escapeCsvField` now prefixes a `'` to any
  field starting with `= + - @` / tab / CR before RFC-4180 quoting; one fix covers
  all finance exports. (`src/lib/exports.ts`)
- **Photo upload MIME (MED)** — `content_type` constrained to an image allowlist
  (`z.enum`) at the boundary, matching R2 `SAFE_EXT`. (`api/photos/upload-url`)
- **Health authz (MED)** — `/api/health/subsystems` now role-gates to
  manager/admin (403 otherwise). (`api/health/subsystems`)
- **Internal cron routes (MED) + constant-time (LOW)** — new shared
  `src/lib/internal-auth.ts`: `INTERNAL_CRON_TOKEN` is mandatory in production
  (unset → 503; fail-open only in non-prod), and the bearer is compared with
  `timingSafeEqual`. Applied across all 12 `/api/internal/**` routes; contact-intake
  reuses the same `constantTimeEqual` helper.
- **Unsandboxed iframes (LOW)** — `sandbox=""` added to the digest and invite
  `srcDoc` preview iframes. (`DigestsClient.tsx`, `InvitePreview.tsx`)
- **Free-text caps (LOW)** — survey draft `answer_text` capped at 10k;
  `answer_json` replaced with a depth/size-bounded schema. (`survey/[token]/draft`)
- **Committed secrets (MED)** — `legacy/` (dead predecessor PHP with a bcrypt admin
  hash + MySQL creds) deleted from the tree.
- **No `.dockerignore` (MED)** — added; excludes `.git/objects`+`.git/logs` (the
  secret-bearing history) from the builder `COPY . .` layer while keeping
  `.git/HEAD`/refs so the deploy-identity SHA bake still resolves.
- **No container limits (MED)** — conservative `mem_limit` + `pids_limit` added to
  the app (1500m/512) and the Chromium-invoking cron services (1024m/256) as a
  blast-radius cap on the shared host. (`docker-compose.yml`)

Tests added/extended for every code-level fix (stamp SSRF, CSV guard, upload
allowlist, health authz, internal-auth guard, survey caps, both iframes).

### Changed — 2026-07-16 (office dark-theme sweep executed — C-16 / ADR-0051)

Operator directive (Bill): "everything goes to the new look except the floor
iPads." Repainted every remaining green office/manager surface to the Vision
deep-space theme (`dr3-space`/`dr3-mist`/`dr3-cyan`/`dr3-steel`), following the
AP reference (PR #99) as an in-place token swap: all `/dashboard/[site]/*`
pages + clients (cor, equipment, invoices, invoices/[id], loads-inventory, ops,
yard), `/dashboard/ops/digests`, `/admin/processed-units`,
`/admin/production-report`, `/bonus/amendments`, the `/login` locale picker, and
the app-global chrome (`layout` PWA themeColor, `global-error` fallback, the
`UpdatePrompt` banner CTA). `/login` is the office Entra SSO door (the floor PIN
path is under `/operator`), so it goes dark. The floor (`/operator/*`) and the
COR PDF renderer keep the ADR-0008 green. New `office-dark-theme-sweep.test.tsx`
statically guards the "no green office pages" invariant. Closes OPEN-ITEMS C-16.

### Added — 2026-07-16 (ADR-0052 drafted: commodity payment reconciliation, Proposed)

Per the Daven Stetson personnel-wiring handoff (§4 as corrected by §7):
payment-tracking companion table for `outbound_materials`, Daven-facing aging
view (born pilot), one ADR-0039 audit check riding the 0043 digest. Status
Proposed — D1 (aging thresholds), D2 (expected-amount optionality), D3
(per-buyer rollup) presented to Bill; build starts on his answers. Numbering
per §7.4: claimed 0052 at draft time; OPEN-ITEMS O-7/S-2 corrected to stop
reserving numbers for undrafted ADRs.

### Fixed — 2026-07-15 (approver note now displays on the returned invoice PDF)

Operator directive: the decision note must be visible on the output invoice
accounting receives. The pdf-lib overlay (real-PDF path) never drew it — only
the email body and the Playwright stamp paths did. The stamp band now grows
to carry the note (wrapped, 3-line cap + ellipsis; full note stays in the
email body) on every page, both decisions. Note field labeled accordingly.

### Decided — 2026-07-15 (floor UI stays GREEN — O-9 fully closed)

Operator decision: the warehouse-floor iPad surfaces (`/operator/*`) keep the
ADR-0008 green theme; deep-space stays office/manager-only (ADR-0051
post-acceptance note). With the site-tag requirement shipped the same day
(PR #105), both halves of OPEN-ITEMS O-9 are closed. Docs-only change.

### Changed — 2026-07-15 (AP decisions: site tag now REQUIRED)

Operator directive: every AP decision must carry the Woodland/Eugene site tag
(was optional; accounting files each invoice against a site in GP). Enforced
service-side (`assertDecisionSite` → `ApSiteRequiredError` 400 before any
state change), route-side (resolve + refuse pre-CAS), and in the queue UI
(required select + client guard). Closes O-9(a); ADR-0046 post-go-live
amendment note.

### Ops — 2026-07-15 (AP MODULE LIVE — production)

Operator order following the same-day validation pass: all test requests
purged (DB + R2 + mailbox; audit retained) and `ap_notify` flipped to LIVE at
both sites (audited, criteria note on the rows). Real routing now in effect:
new-invoice alerts → the 4-approver roster; decision mail → the original
forwarder with Mary CC'd; stamped originals attached and archived. Rollback
is a pilot flip on /admin/rollout.

### Validated — 2026-07-15 (AP module operator sign-off)

Bill's live test runs passed end-to-end ("working perfectly"): ingest → tile →
dark queue → inline preview → site-tagged decision → decision email carrying
the actual stamped original, R2-archived. Validation record in ADR-0046; the
go-live flip (both sites) is O-1 in docs/OPEN-ITEMS.md.

### Fixed — 2026-07-15 (AP decision mail returns the ACTUAL invoice, not a body render)

Live defect caught by Bill in today's operator test (request `c38909b2`): an
approved invoice with a real PDF attachment **and** a forward body came back as a
stamped **body render** instead of the Hertz invoice, and
`original_attachment_sha256` was NULL — the pdf-lib overlay never ran.
`buildDecisionStamp` gave the **body precedence**, and a forwarded invoice always
has a body, so the overlay path was dead for the exact case it was built for.

- **Attachment-first precedence.** Real file attachments now win: each is stamped
  (true pdf-lib / Playwright overlay) and returned; the body render is the fallback
  for body-only invoices. When attachments exist the mail is **docs-only** — the
  approver's note is already stamped onto every attachment, so accounting files the
  actual document into GP, not the forward wrapper. Zero caller changes;
  `original_attachment_sha256` auto-populates.
- **Inline-image filter (ship-now heuristic).** Forwarded signature/logo images
  (`image/*` under 50 KB) are excluded so a stamped `logo.png` never rides the mail;
  PDFs and non-image files are always kept, and the filter never empties a decision
  mail that has real files. Durable follow-up (capture Graph `isInline` into a new
  `ap_attachments.is_inline` column, retiring the size heuristic) noted in ADR-0046.
- **Filename collision de-dup** for multi-attachment mails
  (`approved-invoice.pdf`, `approved-invoice-2.pdf`) so neither MIME part clobbers
  the other. See ADR-0046 post-amendment note (2026-07-15).

### Added — 2026-07-15 (site tag unmissable on AP decisions)

Operator directive (Bill): when an approver tags a site (Woodland/Eugene) at
decision time, accounting must see it without hunting. The site now rides the
decision email SUBJECT (`DR3-Vision AP decision (approved — Woodland) — …`),
leads the decision facts in the body (`Site: Woodland`), and is printed in the
per-page stamp line of the returned document (`… via DR3-Vision — Site:
Woodland`) plus the stamped page's meta block. Untagged decisions are
unchanged (the tag stays optional).

### Added / Changed — 2026-07-15 (AP module overhaul — functional & robust, operator-directed)

Bill: "let's do this now — functional and robust." Ships behind AP pilot mode
(ADR-0047). ADR-0046 Amendment 4 (items 2/3/5) + ADR-0051 (item 1) + ADR-0020 note
(item 6). `pdf-lib@1.17.1` added (pure-JS, MIT).

- **AP queue repainted to the Vision deep-space theme** (ADR-0051). The AP page
  shell + `ApQueueClient` tabs/selection accents move from `dr3-green-deep`/white to
  `dr3-space`/`dr3-mist`/`dr3-cyan` (chartreuse → cyan), with the dashboard's nebula
  atmosphere for continuity. The floor (`/operator/*`) stays green per ADR-0008; the
  rest of the office is a follow-up sweep. Message-body iframe stays `bg-white`.
- **Inline attachment preview** — approvers preview PDFs/images **in-panel** instead
  of a download round-trip. The attachment route enforces an inline allowlist
  server-side off `content_type` (`pdf`, `png/jpeg/jpg/webp`) and signs with
  `Content-Disposition: inline`; PDFs render in a cross-origin `<iframe>` (no
  `sandbox=""` — it kills Chromium's PDF viewer), images in `<img>`; per-attachment
  collapse/expand; >15 MB opens in a new tab. **CSP** gains
  `frame-src 'self' https://*.r2.cloudflarestorage.com` (`next.config.js`).
- **GP matching keys stripped from email bodies** — the decision, hold-notice, and
  new-request emails no longer repeat request id + original subject as body lines.
  The keys survive on the **subject line** and the **stamped decision PDF** (and the
  request id in the deep-link URL). Bodies now read as human decision notices.
- **Stamp the ORIGINAL invoice, both decisions** — reverses the §C10 no-PDF-lib
  constraint. `stampOntoOriginalPdf` overlays a visible stamp band + diagonal
  APPROVED/REJECTED watermark onto **every page** of the original PDF (pdf-lib, true
  overlay, reproducible sha via pinned metadata dates); image originals overlay via
  Playwright; **each** file attachment is stamped (multi-attachment loop). The
  stamped original(s) are attached to the decision email and archived to R2
  (`ap/{requestId}/decision/…`). The row records a **dual-sha tamper record**
  (`decision_pdf_sha256` + `original_attachment_sha256`) + `decision_pdf_r2_key`
  (migration `20260720_ap_decision_artifacts`, purely additive). Fail-soft preserved:
  a stamp/download/R2 failure never blocks the decision email; R2-unconfigured
  degrades to the stamped cover page.
- **AP Approvals dashboard tile + condensed grid** (ADR-0020 note) — new
  `ap-approvals` tile under a new `ap-approver` scope (admin OR active roster member,
  via `canActOnApRequest`), with a live pending-count cyan badge. Tiles condensed
  (`p-4`, `h-9` icon chip, `line-clamp-2`, `min-h-[88px]`) and the grid widened to
  `xl:grid-cols-4` for office-iPad tap density.

### Ops — 2026-07-14 (RAOP mail incident CLOSED — proper sender restored)

O-0 executed: `dr3-vision@svdp.us` added to the RAOP scoping group (Bill,
Exchange device-code session; pwsh + ExchangeOnlineManagement now live on the
workspace host at `~/.local/pwsh`). Post-propagation probe 201, the 2026-07-10
temporary sender unwound (`M365_MAIL_FROM_ADDRESS` back to
`dr3-vision@svdp.us`), app recreated, live test report delivered from the
proper identity. Daily/late reports and payroll mail send as DR3-Vision again;
AP decisions keep their approvals-dr3 identity by design.

### Added — 2026-07-11 (late bonus entry still sends the daily report, immediately)

Operator directive (Bill, 2026-07-11, effective immediately): "even if a site
does not get their bonus entered by the required time the report still goes
out as soon as they hit save … the production data still has to get out to
the team regardless of when it gets put in — there should just be a flag on
there that says what time it was submitted."

- **On-save late path** (`src/lib/bonus/daily-report-late.ts`): after every
  successful daily-entry save — and after every approved amendment — if the
  entry's day is past its site's scheduled Pacific send time (a prior day is
  always past), the production report goes out RIGHT THEN, flagged with the
  submission time (amber banner + " — LATE ENTRY" subject suffix; re-sends
  say the report supersedes the earlier one). Weekend/holiday skips do not
  apply to this path: data entered means work happened.
- **Idempotent per content:** re-saving unchanged numbers never re-sends; a
  save that CHANGES a day's totals after a report already went out re-sends
  the corrected numbers (subject " — UPDATED (late entry)", `resend_count`
  bumped) so the team always ends the day with the real figures.
- **Fail-soft by contract:** the late send can never fail or delay the
  manager's save (errors log loud; the save has already committed).
- Migration `20260719_daily_report_late_flag` (additive): `late_submission`,
  `data_entered_at`, `resend_count` on `bonus_daily_report_log`.
- The scheduled ADR-0030 fire is unchanged and still owns the on-time case.

### Ops — 2026-07-10 (RAOP mail incident: daily reports 403 since the 7/9 policy)

The 2026-07-09 ApplicationAccessPolicy (IT-permissions execution, PR #86)
scoped the Graph app to the approvals scoping group — which does not contain
`dr3-vision@svdp.us`, the payroll/daily-report sender. First fire after the
policy (7/9 6 PM PT daily reports) failed 403 at both sites with zero
deliveries; P15 payroll mail (7/21) would have failed identically. Mitigated
same-day by pointing `M365_MAIL_FROM_ADDRESS` at `approvals-dr3@svdp.us`
(in-policy; verified delivered via the internal test-send). PROPER FIX is an
operator action — add the dr3-vision mailbox to the scoping group and restore
the env (docs/OPEN-ITEMS.md O-0). Discovered during the 2026-07-10 sweep's
follow-through, not by an alert: a 403'd report writes a log row and pages
nothing — a delivery-failure alert is a candidate hardening item.

### Added — 2026-07-10 (open-items register)

- **`docs/OPEN-ITEMS.md`** — the single live register of everything hanging
  (operator actions incl. the AP go-live flip and the §7 file-fetch decision,
  stakeholder blocks, accepted code residuals from the 2026-07-10 sweep, and
  the §8.2 queue). Anchor deadline recorded: Kelsey's window ends 8/1. Sessions
  append loose ends there and move closed items to Done.

### Fixed — 2026-07-10 (production-readiness stack sweep — ops + 3-subsystem audit)

Operator-ordered top-to-bottom sweep (Bill, 2026-07-10) ahead of AP go-live:
CHAD ops audit + parallel code audits of the AP module, the 10 cron daemons /
internal routes, and the billing/workbook money code. Ops fixes applied live
same-day; code fixes below. Migration `20260718_billing_hardening` is purely
additive (two unique indexes; both tables empty in prod).

**AP module (go-live blockers):**

- **Live poll now hydrates the FULL message body** via `transport.getMessage`
  before ingest — the Graph delta `$select` has no `body`, so every live-mode
  invoice would have persisted a ~255-char `bodyPreview` as its content
  (body-only invoices truncated silently; masked by mock fixtures that carried
  full bodies — the mock now mirrors the real body-less delta projection).
  Duplicates are pre-checked before hydration (no wasted Graph round-trip).
- **Queue page no longer locks out single-site approvers.** It still gated on
  the pre-amendment org-reach rule (admin/all_sites) while the routes had
  moved to the ap_approvers roster — Rick (Eugene) would have gotten "Access
  denied" from the very deep link the new-invoice email sends.
- A follow-up arriving while a request is ON HOLD threads as a follow-up
  (was: created a duplicate request + second all-approver alert).
- Decision email + queue banner + queue UI timestamps are Pacific (were raw
  UTC / browser-zone).
- A poison message now quarantines (`ingest_error`) instead of stalling the
  mailbox's delta token forever; an auth failure still fails the run closed.

**Cron daemons / internal routes:**

- `mymrc-cron` recurring timer un-`.unref()`'d — the daemon exited after one
  scrape and `unless-stopped` turned "hourly" into a continuous scrape loop
  (service currently profile-disabled; safe to re-enable now).
- The three bonus daemons (daily-report, period-close, escalation-check) now
  follow the ADR-0036-addendum fetch contract (`redirect:'manual'`, non-200
  throws) — they were the last daemons that would have followed a login 307
  to a fake 200 while payroll close/auto-sign silently no-op'd.
- The naive "DST-correct" fire-time helper (double-fire on fall-back, 1h late
  on spring-forward) replaced with the offset-reprobe pattern in all seven
  daemons that carried it; DST-transition-day tests added for every schedule.
- Period-close gains bounded same-day retry (30-min × 6) — a transient 07:00
  failure on payroll day no longer permanently skips the close. (Widening the
  route's `period_end == yesterday` matcher was evaluated and REJECTED: past
  `draft` periods are legitimate — a wider matcher would mass-close them and
  mass-email signers on fresh seeds/onboarding.)
- Route-guard regression tests added for board-pack/send, workbook-sync/poll,
  bonus/generate-pdf; explicit public-paths case for bonus/daily-report.

**Billing / workbook money code:**

- **CA fuel surcharge fails loud instead of billing $0** when an
  override-priced source has no `canonical_mileage` (was: `miles ?? 0` →
  $0.00 `applied:true` per load, forever).
- **Workbook promotion writes `arrived_at` as the Pacific-midnight instant**
  (was: @db.Date UTC-midnight = 4/5 PM Pacific the PREVIOUS day — a promoted
  June-1 load fell into May's billing window and priced fuel off the prior
  ISO week). Conflict scans on the two instant columns (`arrived_at`,
  `snapshot_at`) now bound by the Pacific-day window.
- **A billing-gate override is no longer a permanent skeleton key**: it covers
  only findings first-detected before it was recorded; a newer blocking
  finding re-blocks the window and demands a fresh audited justification.
- **CA EOM refuses to compose a NEGATIVE total** (mid-month exceeds the
  revised gross) with a typed error pointing at the credit-memo path.
- Invoice approve/void are atomic CAS transitions (concurrent transition →
  typed 409, never approve-over-void); void of an APPROVED invoice now
  requires the D4 approver rule (was reach-only — an all-sites manager could
  cancel any site's approved invoice) and APPENDS its reason to notes instead
  of overwriting the generation note.
- DB backstops (`20260718_billing_hardening`): unique version per
  (site, kind, month) chain; ONE open credit memo per invoice (partial unique
  index; service maps the conflict to the typed error).
- Haul-rate admin refuses inverted windows (`effective_to < effective_from`
  silently never matched — the negotiated override quietly fell back to the
  tier rate) and duplicate `effective_from` per source; the freight resolver
  detects override/tier ties as typed errors instead of coin-flipping.
- Workbook-sync fails SAFE on an unreadable cutover state (skip the poll —
  never workbook-wins-overwrite a possibly-cut-over site); cutover also flips
  `is_syncing=false` as durable belt; the naming-pattern regex tolerates a
  repeated `{MONTH}`/`{YEAR}` token; manual invoice lines are magnitude-capped.

**Observability:**

- Prod logs, OTel traces, and boot alerts now carry the REAL deploy sha —
  next.config's env inlining rewrites only dotted `process.env.X`, and the
  repo's bracket-access convention (`noPropertyAccessFromIndexSignature`)
  silently missed the inline everywhere, stamping `version:"dev"` since the
  mechanism shipped. Fixed via a `ProcessEnv` declaration merge + dotted
  access in one `buildInfo()` source.

**Ops (applied live on CHAD 2026-07-10, no deploy needed):**

- `ap-poll` was running the previous day's image: the deployer's plain
  `up -d` never includes the `ap` compose profile, so every deploy stranded
  the profile-gated service on the old build. Recreated on the current image
  and made durable via `COMPOSE_PROFILES=ap` in the host `.env`.
- Prod seed run (idempotent): the 3 Eugene paper-form sources landed
  (111→114); everything else no-op.

### Added — 2026-07-09 (rollup §8.1 build queue — ships-without-files subset)

The OPERATOR-ordered §8.1 build queue of the 2026-07-09 full rollup
(`docs/handoffs/2026-07-09-full-rollup-mary-morena-july-terex-eugene-2026-07.md`,
PR #91): everything buildable before the real workbook files land on titan
(§8.2 promotion/fuzzing/close-balance wait on a §7 fetch method). Migration
`20260717_trade_discount_credit_memos_verify` is purely additive and
clean-replays on empty PG16.

- **Row-2 section-label resolver (ADR-0049/0048, rollup §3.2).** July's workbook
  dropped the month prefix from category tab names ("June26 Commodities" →
  "Commodities"), killing sheet-name matching. New
  `src/lib/audit/workbook/section-resolver.ts` classifies sheets into
  `worksheet_semantic_type` by (1) DAY-name regex, (2) row-2 section label,
  (3) header-row signature, (4) month-prefix-stripped name fallback — never
  throws, returns `unknown`. June + July tab names resolve identically; the
  full row-2 label set finalizes against real bytes in §8.2 (TODO markers
  distinguish confirmed vs inferred labels).
- **DAY-sheet cotton block encoded (rollup §3.1 / ADR-0037 note).**
  `day-sheet-layout.ts`: every DAY sheet carries 8 outbound commodity blocks;
  DAY6 carries a PERMANENT 9th COTTON block at cols 68–75 (confirmed in both
  June and July — not an anomaly). Taxonomy already had `cotton`; this encodes
  the structural expectation the §8.2 parser finalization asserts against.
- **Explicit GP Trade discount (ADR-0041 addendum, rollup §1.3).**
  `invoices.trade_discount_cents` + `trade_discount_reference_invoice_id`
  populated on CA-EOM generation; offset-line description + summary render now
  speak GP (gross month total → Trade discount → balance due). Totals, line
  codes, and the frozen export-v1 contract unchanged.
- **Credit-memo correction path (ADR-0041 addendum, rollup §1.4).**
  `credit_memos` + typed state machine `proposed → sent_to_mrc → accepted |
rejected → applied | void_and_reissue_triggered` (MRC acceptance REQUIRED
  before apply; rejection composes with the existing supersede chain). Service
  `src/lib/invoices/credit-memos.ts` + manager routes; admin UI is a follow-up.
- **Billing verification view for Mary (rollup §1.2).** Read-only
  `/admin/billing/verify`: latest non-void invoice per (kind, month) for the
  current + previous PACIFIC billing months, each with its ADR-0039 window
  posture (green = approved + clean / yellow = findings or still-a-draft /
  red = gate-blocked) and the GP three-line structure on CA-EOM. New
  `users.can_view_billing_verify` flag — MANAGER-ONLY with the exact
  `can_manage_rates` coercion (hard rule #2; operators never; cleared on role
  change), site reach per rule #2 (all_sites managers + admins see both
  sites). Grant Mary manager + all-sites + this flag once her account exists.
  The page reads one findings fetch per site feeding both the gate and the
  rendered list (light and list can never disagree; constant 4 queries/site).
- **Seeds.** `sources.csv` +3 Eugene paper-form sites from the rollup §4.3
  sample (Thompsons Sanitary Service, Stayton Community Center, Deschutes —
  names/addresses to confirm with Rick); `Glenwood TC 143/144` documented as
  aliases of the seeded Glenwood station and `Illegal Drop`/`Sponsors` as
  drop-off kinds, not sources. `seedWorkbookSync` + `WorkbookSource` docs now
  state Eugene is DEFINITIVELY paper-only (rollup §4.2) — never add a source row.
- **Fixture-based parser tests (rollup §5/§8.1-7).** The §5 real-byte samples
  saved verbatim at `tests/fixtures/adr-0048/sample-rows.json`; 19 new vitest
  cases round-trip them through exceljs and pin the known-good rows (Bass Hill
  2026-06-19 · 52 units · $1,619.14 total; EIA fuel week 2026-03-02 @ 4.534).
- **Review-pass hardening (same day, 8-angle review).** Credit-memo
  transitions are atomic compare-and-swaps (typed 409 on a lost race; reissue
  claims-then-supersedes with compensation on failure); memo amounts bounded
  to the invoice total + one open memo per invoice; the mid-month offset
  reference is APPROVED-invoices-only (a draft's total was never invoiced);
  no phantom $0.00 Trade discount fields; a write-time tripwire asserts the
  column mirrors the stored offset line; migration backfills the columns from
  pre-existing B22.offset lines; the GP "Balance due" framing keys on the
  STORED offset line (not the kind) across xlsx + manager detail + verify;
  shared `KIND_LABEL` (types.ts) + `formatUsdCents` (format.ts) + workbook
  `cells.ts` replace per-file copies; the section resolver runs
  header-signatures before row-2 labels (a data row containing a label word
  can't out-vote a sheet's own header fingerprint) and short-circuits DAY
  sheets; historical B22.offset rows keep the old description — `line_code`
  is the only stable join key.
- **Docs.** Post-acceptance notes on ADR-0037 (cotton permanent), ADR-0039
  (read-only findings surface), ADR-0041 (addendum above + §D review items),
  ADR-0046 (outgoing stewardship AP stays out of scope — ADR-0051 candidate).

### Added — 2026-07-09 (dr3-intel-2026-06 survey export — campaign closure)

- **Survey campaign `dr3-intel-2026-06` closure completed.** Mary Scott (final
  outstanding respondent) self-submitted 2026-07-07 12:29 PM PT after 5 automated
  reminders; ADR-0036 auto-close fired 3 minutes later. Response export (9
  respondent files + `_summary.md`) generated from the prod DB in `buildExport`
  format and committed under `docs/operations-intel/dr3-intel-2026-06/` — the
  close route builds but does not push the export (ClaudeSync push is still a
  follow-up), so this commit is the export artifact. Operator runbook campaign
  log updated with the final standing.

### Added — 2026-07-09 (ADR-0046 Amendment 3 — AP go-live features)

Operator-directed (Bill, 2026-07-09) ahead of AP going LIVE ~2026-07-11. Amends
ADR-0046 §C5; mock-first transport architecture unchanged. Migration
`20260716_ap_hold_and_notes` is purely additive and clean-replays on empty PG16.
All AP mail still routes through `notifyStaff('ap_notify')` (born pilot — reroutes
to admins until Bill flips it live).

- **New-invoice notification to ALL active approvers, enriched.** The one-per-request
  new-request email (already sent to the full expiry-aware roster, excluding any
  approver past `active_until`) now carries the requester, subject, received-at
  (Pacific), attachment count, and a **tier-1 deep link** to the specific queue item
  (`/dashboard/ops/ap?request=<id>`).
- **Approval / rejection notes.** A **rejection now REQUIRES a note** (plain-English
  400 at the decide route + disabled Reject until a note is present); approvals stay
  note-optional. The note rides the decision email, the **stamped decision PDF**, and
  the audit row.
- **`pending_review` (hold) status.** An approver may place a pending request **on
  hold** with a required hold note (`ap_requests.held_by`/`held_at`/`hold_note`,
  enum value `pending_review`). Accounting (the original forwarder) is emailed that
  it is held (who + note + "a final decision follows"). The queue shows an amber
  **ON HOLD** chip with holder + note visible to all approvers. From hold, any
  approver may approve/reject (first-action-wins unchanged) or update the hold note.
  Held items are excluded by design from any future staleness alert (none exists
  today). Every transition is audited.

### Added — 2026-07-09 (planning rollup 2026-07-08 — build-now subset)

The OPERATOR-ordered build-now subset of the 2026-07-08 planning rollup
(`docs/handoffs/2026-07-09-planning-session-decisions-rollup-2026-07-08.md`). Four
features + two proposal ADRs. Every new staff-facing surface is **born pilot**
(ADR-0047); no email is sent by anything added here in pilot (decision/board-pack
mail reroutes to admins). Migrations `20260715_pool_split` +
`20260715b_rollup_ap_boardpack_yard` clean-replay on empty PG16.

- **ADR-0037 §3 — inventory pool split.** `site_inventory_snapshots` gains
  `program_units` / `non_program_units` (`Decimal(7,1)`) + `pool_attribution`
  (`measured` | `legacy`). Physical counts record the program and non-program pools
  separately; a `measured` count is validated `program + non_program == total`
  (typed `PoolSplitMismatchError`, 422). Existing rows backfilled `legacy`
  (all-to-program). The count-entry UI gains the two fields + a live running-total
  helper + plain-language mismatch error (EN/ES/UR). `running-balance.ts` `onHand()`
  uses the measured split as the anchor when present, else legacy fallback;
  `{ program, nonProgram, total }` return shape unchanged.
- **ADR-0046 §3 — AP mailbox expansion.** Explicit `ap_approvers` roster (Morena,
  Rick, Janette, Kelsey; Bill acts as admin) with `active_until` — single-site
  managers are now full approvers (queue permission = admin OR active approver).
  Kelsey auto-removes 8/1 via a daily `ap-approver-expiry` cron (audit + Bill ntfy).
  Optional site tag at decision (`ap_requests.site_id`). Decision email routes to
  the original internal `@svdp.us` forwarder (intake sender validation unchanged),
  carrying a visible-stamp PDF (no crypto) whose sha256 is a tamper record
  (`ap_requests.decision_pdf_sha256`); stamping reuses the repo's Playwright→PDF
  mechanism (no PDF library added — see the ADR §3 amendment for the deviation).
- **ADR-0045 §3 — board-pack digest.** New org-wide `board_pack_digest` notification
  surface (born pilot) sent via `notifyStaff`. `board_pack_recipients` roster
  (Bethany + Bill; Bethany is a documented placeholder). Fires the 2nd Wednesday +
  preceding Monday (Pacific, reusing `digest-calendar.ts`), one send/month
  (`board_pack_send_log`). Payload: prev-month processed units, MTD, YoY, P&L
  placeholder, no safety section. First LIVE send targets 2026-08-10 (ships pilot).
- **Trailer/yard list scaffold (rollup §1.8).** Manager `/dashboard/<site>/yard`
  view behind the new `yard_list` UI surface (born pilot ⇒ admin-only). Reads
  `container_rental_sites` + on-hand context; `yard_trailers` table (label,
  location, status) with add/edit (audited). EN/ES/UR.
- **ADRs 0049 (workbook sync bridge) + 0050 (compliance-admin ledger)** drafted as
  Proposed (no code) and indexed. ADR post-acceptance notes added to 0030 / 0028 /
  0029 / 0047 (Q-0047 grandfather resolutions).
- **ADR-0049 — Woodland workbook → Vision sync bridge (BUILT, mock-first).** Status
  → Accepted (2026-07-09 operator build-all order; parser finalization + enable flip
  gated). The `Files.Read.All` tenant grant landed 2026-07-09 (app
  `2da2…`). Mirrors each site's monthly Woodland daily-log workbook from Kelsey's
  OneDrive into `processed_units_daily` every 10 min (business hours, PT). New
  `src/lib/msgraph-files/` READ-ONLY Graph Files transport (live + fixture mock; creds
  fall back to the shared `MSGRAPH_MAIL_*` app — one app, two capabilities) and
  `src/lib/workbook-sync/` engine: current-month discovery + auto rollover (D5), cTag
  delta (no re-download when unchanged, D2), **workbook-wins** upsert with an audit row
  per Vision-overwrite (D3), mid-edit skip+count (D11), `workbook_sync_runs` ledger
  (mymrc shape, always written), 403 fail-soft (log + ntfy, no crash, D6). Cutover flip
  (in `/admin/rollout` OR `/admin/workbook-sync`) stops sync + fires R2 archival to
  `workbooks/{site}/{yearMonth}.xlsm` (D8), soft-gated on Rick's parity signoff (D7).
  `/admin/workbook-sync` admin surface (sources add/edit/enable, run ledger, cutover).
  10-min cron (`scripts/workbook-sync-cron.mjs`) + business-hours-enforcing internal
  route + public-paths exemption (+ regression test) + `workbook-sync` compose profile.
  Migration `20260716b_workbook_sync` (`workbook_sources` + `workbook_sync_runs`,
  `RolloutSurfaceKind` gains `workbook_sync`) clean-replays on empty PG16. Seed adds the
  Woodland source (born `is_syncing=false`) + `workbook_sync` surface (born `pilot`),
  idempotent. GATED: the per-day parser mapping (`daily-adapter.ts`) reads the
  Addendum-B fixture layout until Kelsey's real `.xlsm` lands (D12); each source is
  born disabled pending a deliberate operator enable.

### Fixed — 2026-07-07 payroll-morning hotfix

- **Signature-chain cache TTL (30s).** The per-site chain cache was keyed on the
  prisma singleton and lived for the process lifetime — the 2026-07-07 chain
  repair (override actors pointed at a deactivated duplicate admin user) was
  invisible to the t3 auto-override until an app restart. Config repairs now
  take effect within 30s.
- **Future-period close guard.** The manual "ready to sign" close now refuses
  (409, plain-English) any period whose end date is still in the future —
  Eugene's current P15 was closed by mistake during the P14 signature scramble,
  locking daily bonus entry site-wide. Early close on the final day remains
  allowed.

### Added — 2026-07-07 (ADR-0047 — staff-output rollout gate + ADR-0039 A1 bootstrap gating; INCIDENT)

Response to the 2026-07-06 incident (the ADR-0043 digest emailed a site manager
two true-but-useless bootstrap findings the day the feature merged). Two
release-discipline fixes, deployed together.

- **`notifyStaff()` chokepoint (`src/lib/notify/`).** The ONLY sanctioned path to
  non-admin recipients. Resolves the `(surface_code, site)` rollout state:
  `pilot` reroutes to admins with a `[PILOT — would have sent to: …]` subject +
  body banner (validates content AND targeting); `live` sends to the real
  recipients; an unregistered surface throws `UnregisteredSurfaceError` (never a
  silent send). Every decision is audited + logged.
- **Rollout registry (`rollout_surfaces`, migration `20260713_rollout_gate`).**
  One row per staff-facing surface × site, default `pilot`. Notification
  surfaces seeded pilot (alert_digest, task_reminders, contact_intake_notify,
  invoice_approval_notify, cor_notify, ap_notify) except the grandfathered
  production surfaces (bonus_signature_chain, survey_sends) → live. UI surfaces
  (workbench_manager_read, loads_events_or_tabs, equipment_entry, equipment_trend)
  seeded pilot (admin-only, the ADR-0037 D7 template made data-driven).
- **Rewired through the gate:** the ADR-0043 alert digest (which still fires in
  pilot for admin validation even while the roster is muted), ADR-0045
  contact-intake routing, ADR-0046 AP notifications (new-request + quarantine +
  decision email). Task reminders ride the digest.
- **Repo guard (`src/lib/notify/__tests__/no-direct-mail.test.ts`).** Scans the
  real `src/` tree and fails if feature code imports `@/lib/m365-mail` outside the
  allowlist (transport core, notify layer, auth, payroll delivery, and the
  grandfathered signature-chain + survey + daily-report + amendment senders).
  Proven with an in-memory synthetic-import test-of-the-test.
- **Admin panel `/admin/rollout`** (admin role) — every surface × site with
  state + last-flip evidence; flip requires a criteria note; audited + immediate;
  rollback = inverse flip (no code).
- **Bootstrap gating (ADR-0039 Amendment 1, `src/lib/audit/bootstrap-gate.ts`).**
  `c4_billing_basis` / `m1_missing_close` / `m2_missing_snapshot` (registry-driven)
  emit findings only once their leg (billing/close/snapshot) has ever had data
  OR an admin `go_live_date` (`audit_bootstrap_gates`) has passed. Suppressed
  counts land in `audit_runs.suppressed_bootstrap` (visible in admin, never
  silent). Comparators untouched. Existing bootstrap findings auto-resolve with
  cause `bootstrap_suppression` + provenance via migration
  `20260713b_bootstrap_resolve` (never deleted).

### Changed — 2026-07-07 (bonus period-close moves to payroll-day 07:00 PT — ADR-0019.1 amendment)

- **Period close now fires 07:00 PT on the payroll day (the day AFTER
  `period_end`)**, not 17:30 on `period_end` itself. `scripts/bonus-period-close.mjs`
  fire time 17:30 → 07:00 (`msUntilNext1730Pacific` → `msUntilNext0700Pacific`);
  the close route predicate moved from `period_end == appToday()` to
  `period_end == previousDayKey(appToday())` (idempotency preserved — still filters
  `state = 'draft'`). Escalation tier **t1 moved 06:00 → 07:10** (a post-close
  nudge; t2 07:30 / t3 08:30 / t4 09:00 unchanged). Pacific date matrix + DST
  boundary tested; the escalation route already keyed off yesterday, so its logic
  is unchanged.
- **Amendment error messages** are now plain English at the UI layer
  (`src/lib/bonus/amendment-error-messages.ts`) — no more raw `period_not_draft`
  codes on the request-creation + approve/reject surfaces; every
  AmendmentRequestError code has a sentence (period_not_draft references the new
  7:00 AM payroll-day close window).
- **Report-email logo fix.** `SVDP_LOGO_URL` in the daily production report now
  points at our own asset `https://dr3-vision.svdp.us/brand/svdp-logo-white.png`
  (checked in at `public/brand/svdp-logo-white.png`), not the dead
  `svdp.us/wp-content` WordPress hotlink. No other live hotlinked logo exists (the
  bonus-PDF uses an embedded data URI; the audit digest has no logo).

### Added — 2026-07-07 (ADR-0048 — June operational backfill + Terex history import)

- **Staging→operational promotion (`src/lib/audit/workbook-promotion.ts`).** The
  ADR-0023 historical-import discipline (SHA gate + idempotency + provenance +
  audit) applied to loads/inventory. `promoteWorkbookImport(importId, scope)`
  reads a workbook's parsed staging rows (ADR-0039 `workbook_import_rows`) and
  promotes them, in ONE transaction, into `processed_units_daily`,
  `inbound_loads`, `outbound_materials`, `landfilled_units`, `consumer_dropoffs`,
  and the anchor `site_inventory_snapshots` — every row `source=import` (or, for
  `inbound_loads` which has no RecordSource column, tagged by `import_id`) with the
  promotion id stamped in a new bare `import_id` column on each table.
  - **Idempotent** on `workbook_promotions.import_id` (UNIQUE) — a re-run is a
    no-op that returns the prior counts; a re-run whose staged content changed is
    REFUSED (SHA mismatch).
  - **Conflict refusal** — any live (non-import) row in the (site, table, window)
    is a typed `PromotionConflictError` listing table + dates; no partial merge.
  - **Scope enforcement** — table-driven allow-list (`backfill-scopes.ts`):
    Woodland Jun 1–30, Eugene Jun 24–30; rows outside the window are clipped.
    Enforced in the promote ROUTE (a request may only promote an allowed window).
  - **D2 live assertion** — the June-1 opening inventory is promoted as the
    physical anchor and the June-close balance is recomputed via the shared
    `computeRunningBalance`; the transaction REFUSES COMMIT unless Woodland closes
    to exactly **4,062** (the expected total is scope config, not a hardcode).
  - One audit row per promoted table with counts (append-only, hard rule #6).
- **Terex history import (`src/lib/equipment/import.ts`).** Admin upload
  (xlsx/csv) → `equipment_events` (`source=import`). Flexible header detection
  (date/notes/hours/downtime); downtime rows → `kind=downtime` (hours where
  stated), everything else → `kind=note`. FAILS LOUD (typed `TerexParseError`,
  listing what it saw) on an unrecognized shape — never guesses rows. Idempotent
  on (site, event_date, kind, note-hash); re-uploading the identical file is a
  no-op (`equipment_history_imports.source_sha256` UNIQUE). The mapping is
  **finalized against Janette's real file on receipt** — the upload UI says so.
- **Admin surfaces.** Promotion panel on the workbook-import detail
  (`/admin/audit/workbook/[importId]`): scope options → dry-run preview (per-table
  counts + conflicts + recomputed close vs the known figure) → commit. Terex
  upload page (`/admin/equipment/import`). Both admin-only, both audited.
- **Migration `20260714_june_backfill`.** Purely additive: two ledger tables
  (`workbook_promotions`, `equipment_history_imports`) + a nullable `import_id`
  column (with a sparse partial index) on each of the seven promotable operational
  tables. Clean-replays on an empty PG16.
- **Blocked on Bill's three files (ADR-0048 D4):** the June Woodland `.xlsm`, the
  Eugene June log, and Janette's Terex spreadsheet. Until supplied, everything
  ships tested against Addendum-B-shaped fixtures. Click-path in
  `docs/operator/june-backfill.md`.

### Ops — 2026-07-06

- **Restore drill PASSED (readiness P1-3 closed).** Latest restic/R2 snapshot restored into a throwaway postgres and verified against prod on five invariants (migration head, entry counts, paid-payroll cents exact). Two DR-procedure gotchas discovered and documented in `docs/operator/restore-drills.md` (R2\_\* env mapping; the postgres init-server race that yields a silent empty restore). Remaining D7 activation gate item: RESTIC_PASSWORD off-box confirmation (operator).

### Added — 2026-07-06 (ADR-0046 — vendor-invoice approval via Graph mailbox ingestion)

- **ADR-0046.** Vision's FIRST inbound-email transport. Accounting mails an
  approval request to `approvals-dr3@svdp.us`; Vision polls the mailbox by
  Microsoft Graph delta, turns each valid message into an approval request,
  Morena/Janette (as data: org-reach approvers) decide inside Vision
  (first-action-wins, atomic), and Vision mails the decision back to a FIXED
  recipient list for Mary's Great Plains filing. Built **mock-first**: it runs
  complete against a fixture-driven transport and flips to live creds with
  configuration only (SVdP IT delivers the mailbox + Graph app + tenant consent +
  ApplicationAccessPolicy — the 8/1 risk is IT lead time, not code).
- **Generic transport `src/lib/msgraph-mail/`** (deliberately NOT AP-scoped —
  Morena's parked dispatch↔Outlook ask consumes it later): a `MailTransport`
  interface (`listDelta`/`getMessage`/`listAttachments`/`moveMessage`, typed
  `AuthFailedError`/`GraphContractDriftError`), `graphTransport`
  (client-credentials via `@azure/identity` + plain `fetch` against Graph v1.0 —
  no heavy Graph SDK, `MSGRAPH_MAIL_{TENANT_ID,CLIENT_ID,SECRET,MAILBOX}`,
  `Mail.ReadWrite`), and `mockTransport` (the DEFAULT until creds land). Mode is
  self-reported at startup + in every ledger row; the transport NEVER sends
  (outbound stays `sendSystemEmail`). Delta tokens persist per mailbox+folder
  (`ap_delta_tokens`); a lost token degrades to a full resync, absorbed by
  idempotency.
- **Sanitization (C10.2, non-negotiable):** email HTML is allowlist-sanitized
  with `sanitize-html` AT INGEST into `body_html_sanitized` (raw HTML is never
  stored for render); the queue additionally renders it inside a maximally
  restrictive `<iframe sandbox="">`. Regression test asserts a
  script/onerror/iframe/style-url fixture renders inert.
- **Pipeline (D3):** every polled message reaches exactly one terminal state
  (created/followup/quarantined/duplicate). Sender validation on the
  authenticated envelope sender (forwarder rule, C10.4); full Graph attachment
  taxonomy (fileAttachment → R2 `ap/`; itemAttachment unwrapped one level, deeper
  nesting kept as a visible marker; referenceAttachment recorded, NEVER fetched);
  idempotency on `internet_message_id` UNIQUE; same-conversation follow-ups;
  move-to-Processed hygiene; **quarantine-never-drop** with a Bill page/email
  carrying row id + sender DOMAIN only (no body/attachment/amount — PII-absence
  tested).
- **Approvals (D4):** `/dashboard/ops/ap` queue (org reach — admin or all_sites),
  atomic first-action-wins (`updateMany` count; loser sees "already decided by
  {actor} at {time}"; both attempts audited), optional vendor/amount at decision,
  decision email to the FIXED `ap_decision_recipients` (refuses + pages when the
  list is empty — never the inbound Reply-To), new-request notification to
  approvers, and a pending-AP count line on the ADR-0043 daily digest.
- **Daemon + ops (D5):** thin `scripts/ap-poll-cron.mjs` (10-min tick) →
  loopback-guarded `/api/internal/ap/poll` (+ `public-paths.ts` exemption with a
  mandatory regression test). Profile-gated compose service `ap-poll`
  (`profiles: [ap]`) cloned from `mymrc-scrape`'s shape. Poll-run ledger
  (`ap_poll_runs`) ALWAYS written incl. throw paths; 45-min deadman page.
- **Schema (one additive migration `20260712_ap_approvals`, sorts after
  `20260711_ops_ledger_intake`; clean-replays on empty PG16):** five enums +
  `ap_requests` (org-level, not site-scoped) / `ap_attachments` / `ap_followups` /
  `ap_sender_config` + `ap_sender_entries` (mode `tenant_wide` default |
  `explicit_list`) / `ap_decision_recipients` (seeded EMPTY) / `ap_delta_tokens` /
  `ap_poll_runs`.
- **Dependency:** `sanitize-html` (+ `@types/sanitize-html` dev). Operator doc
  `docs/operator/ap-approvals.md`; `.env.example` gains `MSGRAPH_MAIL_*` +
  `AP_QUARANTINE_EMAIL`.

### Added — 2026-07-05 (ADR-0044 — P4 Terex equipment module)

- **ADR-0044 (P4).** The Terex operational record moves out of a side spreadsheet
  and hallway conversation into Vision: one capture table for
  downtime/maintenance/repair/cost/notes, a derived-throughput trend view, and a
  small site-dashboard tile. Throughput needs NO new capture — it is DERIVED from
  the daily processed-units close (the same number billing bills from). No new
  container, no second entry path.
- **Schema (one additive migration `20260710_equipment_events`, sorts after
  `20260709_alert_recipients`; clean-replays on empty PG16):** the
  `EquipmentEventKind` enum (`downtime`/`maintenance`/`repair`/`cost`/`note`) +
  `equipment_events` (`equipment_code` String default `'terex'`, `event_date`
  @db.Date, `hours_down` Decimal(5,2)?, `cost_cents` Int?, `vendor`, `notes`,
  `source`, audit-actor columns, `voided_at`/`voided_by`). There is **no
  `locked_at`** — events are freely editable and the full history lives in
  `audit_log`; removal is a **soft-void** (never a hard delete, hard rule #6).
  `equipment_code` is a plain string so a second machine is a data value, never a
  migration.
- **Service (`src/lib/equipment/service.ts`, TDD):** `create`/`list`/`update` +
  `void` (soft, audited, idempotent) — no delete. Site-scoped; every write emits an
  `audit_log` row. Validation: `hours_down` only meaningful for
  downtime/maintenance/repair (rejected on cost/note), `cost_cents >= 0`.
- **Derived throughput (`src/lib/equipment/throughput.ts`, pure builders + one
  aggregator, TDD):** units/day (`stripped_program + stripped_non_program`),
  units/run-hour where downtime hours exist (`assumed_day_hours − hours_down`, the
  8h assumption a labeled module constant — not a config table), 7/30-day rolling
  means (null days skipped, never counted as zero), monthly cost series, downtime
  bands, and the `pocketcoil_estimate` overlay series. Downtime hours for the
  run-hour denominator + red bands use `kind=downtime` only (planned
  maintenance/repair hours are captured but not folded in — documented decision).
- **Tile (`src/lib/equipment/tile.ts`, TDD):** last event + 7-day units/day mean,
  site-scoped.
- **Routes (`/api/manager/[site]/equipment` + `[id]`):** manager-scoped
  (`requireManagerForSite` — NOT the ADR-0037 D7 activation gate). GET lists events
  or (`?view=throughput`) the derived series; POST creates; PATCH edits; DELETE
  soft-voids.
- **UI (`/dashboard/[site]/equipment`):** English-first office surface, green/black
  palette, `onClick` handlers (no `<form>`, hard rule #10). Trend chart (units/day
  bars + 7-day mean line + red downtime bands + pocketcoil overlay), monthly-cost
  bars, CSV export, and an event entry row + audited log with soft-void. Plus the
  launcher **Equipment** tile (manager+) and the site-dashboard tile.
- **Docs:** operator guide `docs/operator/equipment.md`; ADR-0044 post-acceptance
  implementation notes.

### Added — 2026-07-05 (ADR-0045 — P5 ops ledger + Updates digest + contact routing)

- **ADR-0045 (P5).** Three of Kelsey's residual functions become thin, audited
  surfaces over existing machinery (no new pipeline, no new container): a
  meeting-notes + task-follow-up ledger, a Vision-drafted / human-sent DR3 Updates
  digest + board pack, and website contact-form routing. Everything human-sent stays
  human-sent — Vision never impersonates Morena/Bethany.
- **Schema (one additive migration `20260711_ops_ledger_intake`, sorts after
  `20260709_alert_recipients` and the parallel ADR-0044 `20260710_`; clean-replays on
  empty PG16):** four enums (`OpsTaskStatus`, `OpsTaskSource`, `UpdateDigestStatus`,
  `UpdateDigestKind`) + five tables — `ops_notes`, `ops_tasks` (source
  manual/meeting/contact_form, `note_id` FK), `update_digests` (draft/finalized, no
  send column), `contact_intakes` (visitor-PII columns), `contact_routes` (seeded
  idempotently in-migration: `tour*` → rick.albritton@, `*` → morena.gomez@). Sibling
  FK columns (`site_id`, audit-actor cols) are bare DB-level constraints per the
  ADR-0040/0041/0042 precedent; the two intra-block relations (`ops_tasks.note`,
  `contact_intakes.task`) carry Prisma relations.
- **Ledger (`src/lib/ops/`, TDD):** notes + tasks services with hard-rule-#2 reach
  (site rows site-scoped; `site_id = NULL` rows org-wide, admin/all_sites only),
  the meeting → action-items motion (one note + N tasks in one transaction), audited
  status transitions, and `dueSummaryForSite` (overdue / due-today). Dashboard tile
  - `/dashboard/[site]/ops` surface (notes list/editor, task queue with filters). The
    ADR-0043 daily digest gains a second **Follow-ups due** section and now sends when
    findings OR due tasks exist (a quiet day still sends nothing).
- **Updates digest + board pack (`src/lib/ops/update-digest.ts`, D2):** weekly draft
  on the Monday tick + board pack on the 2nd-Wednesday-and-preceding-Monday cadence
  (`digest-calendar.ts`, pure, TDD incl. month/year edges), composed from
  closes/movement/open-findings/completed-tasks and equipment events via an injected
  provider with a documented **absent-table fallback** (ADR-0044 equipment table not
  in this worktree — see MERGE-WIRING note). Review surface `/dashboard/ops/digests`
  (admin/all_sites): markdown edit, audited finalize, copy-ready HTML + copy button.
  The module has **no mail path** (a test scans the source and fails on any send).
- **Contact intake (`src/lib/intake/`, D3):** `POST /api/intake/contact` — public,
  fail-closed shared-secret (`x-intake-token`, absent env → 503), honeypot, in-memory
  per-IP rate limit, zod validation; routes via `contact_routes` (first active match,
  `*`-suffix glob) → creates an `ops_task` + `sendSystemEmail` to the routed address.
  PII discipline: name/email/phone never logged (row ids only; log-absence test).
  Middleware exemption `/api/intake/` + `public-paths.test.ts` case. `.env.example`
  gains `INTAKE_TOKEN`.
- **Docs:** operator runbook `docs/operator/ops-ledger-and-intake.md` (incl. the WP
  form wiring), ADR-0045 post-acceptance notes.

### Added — 2026-07-04 (ADR-0043 — P3 rate alerts + missing-record detection)

- **ADR-0043 (P3, first post-P2).** Early warning before MRC computes the official
  numbers: recycling/recovery rates and missing daily records become four new check
  codes on the existing ADR-0039 audit engine (same nightly sweep, same findings
  lifecycle, same `audit_check_config` thresholds, same review surface) — plus two
  dashboard rate tiles and one daily digest email. No new pipeline, no new container.
- **Schema (one additive migration `20260709_alert_recipients`, sorts after
  `20260708_cor_certificates`; clean-replays on empty PG16):** four `AuditCheckCode`
  enum values (`r1_recycling_rate`, `r2_recovery_rate`, `m1_missing_close`,
  `m2_missing_snapshot`) + `alert_recipients` (digest roster, `active` toggle,
  admin-editable) + `alert_digest_logs` (the `(site, digest_date)` idempotency
  ledger). Recipients seeded idempotently: Morena + Janette → Woodland, Rick →
  Eugene (emails from `prisma/seed/users.csv`).
- **Rate computations (`src/lib/rates/`, pure, TDD):** `recyclingRate` (by weight —
  non-`trash` outbound ÷ total; `trash` counted DISPOSED conservatively pending
  Addendum B10-5, so the alert fires early, never late; landfilled units × the
  55-lb `unit_weight_estimate` carry an `estimated` marker) and `recoveryRate` (by
  units, renovation whole-units credited). Both return
  `{ rate, numerator, denominator, components, estimatedInputs }`; a zero
  denominator yields a typed no-data result — never `NaN`, never a throw-through.
- **Four checks (`src/lib/audit/comparators/`, registered exactly like C1–C7):**
  R1/R2 grade the rolling ~9-month rate against `floor + margin` (CA 75 / OR 70,
  warn +3 pts · high +1 pt — all data in `audit_check_config`), window-normalized
  so a persisting low rate UPDATEs one finding instead of duplicating. M1 flags a
  business day (site-calendar-aware via `site_holidays` + weekend logic) with
  inbound activity but no daily close past a 1-business-day grace; M2 flags no
  physical snapshot within 35 days. R-findings link any concurrent open M-finding
  ids into their detail (explain-don't-flag: a low rate over a data gap is likely
  data, not operational).
- **Dashboard (`/dashboard/[site]`):** two site-scoped rate tiles — current rolling
  rate vs floor, trend arrow vs the prior equal-length window, an `estimated` badge
  when the 55-lb estimate contributed; the whole tile links into the site audit
  queue filtered to the R-check.
- **Digest (`src/lib/audit/alert-digest.ts`):** rides the existing daily-report
  cron tick (the internal route runs it after the production-report send) — one
  SVdP-shell email per site per day, ONLY when open R/M findings exist, to the
  `alert_recipients` roster via `sendSystemEmail` from `dr3-vision@svdp.us`,
  idempotent through `alert_digest_logs`. A total delivery failure pages
  `dr3-vision-system` (fingerprint `alert-digest-failed:<site>`, 6-h cooldown); a
  healthy send is silent; ntfy is otherwise untouched (hard rule #5).
- **Operator doc:** `docs/operator/rate-alerts.md` (editing thresholds via
  `audit_check_config`, editing recipients, what the tiles mean, the estimate
  caveat).
- **Deviation from the ADR (documented):** the digest rides the existing daily-report
  tick, which fires at each site's `send_time_pt` (18:00 PT today), not the 07:00 PT
  the ADR assumed — there is no separate 07:00 tick and the ADR mandates no new
  container. The dedup ledger keeps it to one email per site per day regardless.

### Added — 2026-07-04 (ADR-0042 — COR generator: Exhibit 5 pre-fill + human-signs-always boundary)

- **ADR-0042 COR generator (P2, third of three).** Generates the monthly CA
  Certificate of Recycling, Employment and Inventory (Exhibit 5) with every number
  pre-filled from provable Vision data — a human reviews, enters the FT/PT split,
  and **signs the printed copy** (Vision never auto-certifies; the rendered
  signature block is empty). CA-only: an Oregon site gets a typed error / 404 (no
  Exhibit 5 exists there).
- **Schema (one additive migration `20260708_cor_certificates`, sorts after
  ADR-0041's `20260707_…`; clean-replays on empty PG16):** `cor_certificates`
  (immutable-versioned artifact with a `supersedes_id` chain — draft regenerates
  freely, finalized is immutable, corrections are new versions) + `cor_site_config`
  (site-scoped signer) + enum `CorStatus`. `site_id` FKs are DB-level (migration),
  keeping the ADR block self-contained (no back-relation on `Site`), mirroring
  ADR-0040/0041.
- **Service (`src/lib/cor/`, TDD):** `prefill.ts` pre-fills the three numbers with
  provenance — inventory = the ONE pool-aware running balance (ADR-0037 D6) as of
  month-end + anchor-snapshot ref + reconcile delta (`inventory_source`); headcount
  = the month-end daily-close totals + the full month series (`headcount_source`),
  the FT/PT split entered by the preparer at review with the pre-fill retained.
  `lifecycle.ts` finalize / supersede / void mirror the ADR-0041 immutability
  discipline (manager-of-site or admin; audited). A **pre-render reconcile tripwire**
  (ADR-0033 style) recomputes inventory via the one balance function and refuses on
  mismatch with both numbers, in both finalize and PDF render.
- **Render (D3):** internal loopback-guarded print route `/internal/cor-pdf/[id]`
  (added to the middleware public-paths allowlist + its regression test — the
  mandatory ADR-0036 lesson) rendered to PDF via the bonus-PDF Playwright pipeline
  FROM the stored row, stored to R2 under `cor/`. The **signature block renders
  EMPTY** — Rick prints, signs, submits.
- **UI (D4):** `/dashboard/[site]/cor` (CA-only; hidden/404 for OR) — month picker,
  the three numbers with drill-down (inventory → balance ledger + snapshot;
  headcount → the daily-close series), FT/PT entry, display-only capacity banner,
  version diff, penalty-of-perjury finalize confirmation, print-and-sign download.
- **Observability (D5):** generation / finalize / supersede / reconcile-refusal log
  with certificate id / month / site / actor; typed errors carry the numbers. No PII.
- **June acceptance fixture (§7-b):** `prefill.test.ts` reproduces the Woodland June
  2026 inventory of **4,062** from the balance function's own semantics.
- **Config choice (D2.3):** signer implemented as a simple site-scoped `cor_site_config`
  row (Rick Albritton / "Transportation Manager"); the title is flagged **TBC with
  MRC** (`docs/QUESTIONS.md` Q-5) — a one-row edit to confirm, never a code change.

### Added — 2026-07-04 (ADR-0041 capture half — collection events, OR counts, DR3# sequences)

- **ADR-0041 capture half (P2; the invoice-engine half ships separately).** Closes the
  two capture gaps the invoice math needs — collection events and the DR3#
  document-number sequence — plus Oregon collection-site counts. **Schema (one
  additive migration `20260706b_events_and_sequences`, sorts after ADR-0040's
  `20260706_…` and before the engine half's `20260707…`; clean-replays on empty
  PG16):** three new tables — `collection_events` (daily-log Events tab: freight,
  driver/labor hours + wages, mileage, per diem, misc — money in cents, dates
  `@db.Date`), `or_collection_site_counts` (Oregon monthly per-location unit counts),
  `document_sequences` (per-`(site, sequence_code)` atomic counter) — plus a nullable
  `inbound_loads.dr3_number` column. FK constraints are DB-level (migration) so the
  capture block stays self-contained (no back-relation fields on the sibling-touched
  `Site` model), mirroring ADR-0040.
- **Collection events (`src/lib/events/service.ts`, TDD):** create / list /
  update-before-lock. **Wages are stored as entered**; the B5 rules (`driver_hourly`,
  `general_labor_hourly`, `per_diem_nightly`, via the ADR-0037 program-rule resolver)
  only DEFAULT blank wages from `hours × rate` — deviation is derivable, never flagged;
  a missing rule leaves the wage null rather than blocking capture. **Mileage is
  captured twice:** `mileage` (informational miles) + `mileage_cents` (the billed
  dollars that feed the §3.1 B8 event total); freight is a distinct B8 term.
  `EventCostRow` (`src/lib/events/types.ts`) + `eventMiscCents` are the cross-agent
  seam the invoice engine codes against.
- **Oregon collection-site counts (`src/lib/events/or-counts.ts`, TDD):** Eugene-scoped
  create / list / update-before-lock; a non-Oregon site is refused with a typed
  `JurisdictionNotAllowedError`. The $2.25/unit rate stays in `state_program_rules`;
  no invoice math here (the engine half consumes at merge).
- **DR3# issuance (`src/lib/events/sequences.ts`, TDD + real-DB concurrency proof):**
  `issueDocumentNumber` hands out a per-site number via a single atomic
  `UPDATE … RETURNING` (row-lock serialized; a 64-way concurrent test against Postgres
  yields 64 unique contiguous numbers). Woodland-style (CA) inbound loads get a
  Vision-assigned DR3# at the office **verify** step (inside the verify transaction,
  so a failed verify rolls the counter back); Eugene (OR) gets none; **Material # is
  MyMRC-owned and never issued by Vision**. Trigger is `jurisdiction == california`
  with a `TODO(B10-6)` to become a per-site config flag.
- **Manager surfaces:** `/api/manager/[site]/events` (+ `[id]`) and
  `/api/manager/[site]/or-counts` (+ `[id]`), and two new tabs (**Collection events**,
  **OR collection counts**) on the loads/inventory page — admin-only behind the same
  ADR-0037 D7 activation gate.
- **Seed:** Woodland `dr3_number` counter seeded at a **safe-high `5000`** (> the June
  daily-log ceiling 4805). **⚠ Operator action before go-live: align `next_value` to
  the real current counter** (runbook: `docs/operator/events-and-sequences.md`).
  Eugene gets no counter.

### Added — 2026-07-04 (ADR-0041 — invoice generation, engine half)

- **Invoice engine (ADR-0041, P2; second of 0040/0041/0042).** Vision now generates
  what Rick assembles by hand from several spreadsheets — the six-invoice set with
  line-level provenance, immutable-once-approved versioning, Rick's approval gate, and
  the Great-Plains export boundary. Every number on an invoice is a query result with
  a `rate_ref` + `source` provenance trail (Rick's typo class, survey Q8, dies at the
  root). **Schema (one additive migration `20260707_invoice_generation`, clean-replays
  on empty PG16):** two new tables — `invoices` (six-kind enum with NO
  `or_processing_mid_month` by construction; `billing_month @db.Date`; `version` +
  `supersedes_id` self-chain; `status draft|approved|void`; `total_cents` DERIVED but
  stored for query efficiency with a service-layer Σ-lines invariant enforced on every
  write and re-asserted at approval) and `invoice_lines` (`line_code`, `quantity`,
  `rate_ref` jsonb, `amount_cents` incl. negatives, `source` jsonb, `position`).
  Site-FK is a bare DB-level constraint (self-contained block, mirrors ADR-0040).
- **Math (§3.1 verbatim, pure + TDD).** `generate.ts` composers: B6 processing
  (stripped_program × effective `processing_rate`), B7 incentives, B8 event misc
  (via the `EventCostRow` interface — INTEGRATION-PENDING on the sibling's
  `collection_events`), B15 = B6+B7+B8, B20 mid-month (1st–15th inclusive, Pacific
  calendar), B22 = B15 − B20 rendered as an explicit NEGATIVE offset line (the
  "$118,239 trade discount" artifact becomes an honest subtraction). B16
  transportation = per-load `resolveFreightCents` (ADR-0040, per-load ref in source)
  - event freight + fuel surcharge (`fuel.ts`, CA-only, missing-week = typed error)
  - Σ active `container_rental_sites`. OR: EOM-only, transportation with NO fuel line
    (structural guard, tested), collection-site count = manual lines (`source.manual`).
    Zero-guard: a 0¢ processing charge on nonzero units → typed `InvoiceZeroError`.
- **Trust gate + lifecycle.** Approval enforces the ADR-0039 `gateForWindow`
  (refuse-with-finding-codes; super-admin override with audited justification),
  the `can_manage_rates`-is-NOT-sufficient approver rule (manager-of-site or admin),
  and immutability (approved rows never mutate — corrections are a superseding new
  version). Draft regenerate voids the prior draft and takes the next version.
- **Renders + surfaces.** xlsx Summary (exceljs, processing + transportation kinds;
  commodity blocks excluded per D5) + neutral `invoice_export` JSON (frozen v1
  contract) as the GP boundary. Routes `/api/manager/[site]/invoices` (list/generate)
  - `/[id]` (detail w/ inline gate findings + prior-version diff) +
    `/[id]/{approve,void,supersede,export}`. Manager UI at
    `/dashboard/[site]/invoices` (list/generate + line drill-down to source rows,
    approve-with-confirmation). D6 structured logging on every path; no PII in lines
    or logs.
- **INTEGRATION-PENDING (wired at merge with the CAPTURE half):** the events (B8 /
  event-freight) leg — `event-leg.INTEGRATION-PENDING.ts` (ts-nocheck, excluded from
  tsc/eslint/vitest) maps `collection_events` → `EventCostRow`; until wired,
  generation prices events at 0¢ with `source.pending = 'events-integration'` (never
  silently absent).

### Added — 2026-07-03 (ADR-0040 — billing rate infrastructure)

- **Billing rate infrastructure (ADR-0040, P2; first of 0040/0041/0042).** Puts every
  rate the invoice layer needs that isn't already in `state_program_rules` into
  effective-dated tables so ADR-0041 invoicing becomes pure computation. **Schema
  (one additive migration `20260706_billing_rate_infrastructure`, clean-replays on
  empty PG16):** four new tables — `transport_rate_tiers` (freight ZONE table,
  jurisdiction `CA|OR`, mileage band → flat `rate_cents`, effective-dated),
  `account_haul_rates` (per-account freight override, FK→sources, effective-dated),
  `container_rental_sites` (monthly trailer rentals, FK→sites/sources, `active`,
  effective-dated), `fuel_prices` (`week_of @db.Date UNIQUE`, `usd_per_gal
Decimal(5,3)`, source `eia_api|manual`, `fetched_at`) — plus `users.can_manage_rates`
  (scoped rate-write flag). FK constraints are created at the DB level (migration) so
  the ADR-0040 schema block stays self-contained (no back-relation fields on the
  sibling-owned `Source`/`Site` models).
- **Seeds:** the CA freight zone table (7 tiers, effective 2026-01-01) is seeded;
  `account_haul_rates` and `container_rental_sites` seed **empty by design** (Rick
  populates from the workbook after confirming current values — seeding contested
  numbers would launder a discrepancy into "truth"); **no OR tiers** are seeded (the
  freight resolver returns a typed error for OR until they exist).
- **Money-path libraries (`src/lib/billing-rates/`, all TDD):** `tier-validation.ts`
  (a proposed tier set must be contiguous-from-0, non-overlapping, no gaps — typed
  problems name the offending rows); `freight-resolver.ts` (`resolveFreightCents` —
  account override → tier by `Source.canonical_mileage` → typed
  `FreightUnresolvableError`, with provenance ref for the retro-audit; never a silent
  $0); `fuel.ts` (Monday-of-week normalization, `price > $5.05` trigger predicate,
  `(price/mpg)×miles` surcharge, typed `MissingFuelPriceError`; OR guarded by the
  existing `RuleStructurallyDisallowedError`); `eia.ts` (EIA API **v2**
  `petroleum/pri/gnd` weekly West-Coast PADD-5 ULSD fetch; **fail-open** — absent
  `EIA_API_KEY` never crashes).
- **Weekly fuel fetch:** `scripts/fuel-price-cron.mjs` (thin Pacific daemon, Tue 06:00
  PT) → internal route `/api/internal/billing/fuel-fetch` (loopback-guarded; **added
  to `public-paths.ts` + its test on day one** per the ADR-0036 lesson) → upserts
  `fuel_prices` (manual entries never overwritten; a fetch failure pages
  `dr3-vision-system` fingerprint `fuel-fetch-failed`, success silent). New compose
  service `fuel-price-fetch`; `EIA_API_KEY` wired fail-open in `app` env +
  `.env.example`.
- **Scoped rate-write access (D5):** `users.can_manage_rates` grants writes to the four
  rate tables ONLY (never any admin power — enforced by construction:
  `requireAdmin` checks role, the flag is never in the session and is read fresh from
  the DB in `requireRateManager`). Grantable from `/admin/users` (mirrors the
  `all_sites` toggle, manager-only). Admin rate-table CRUD under
  `/api/admin/billing-rates/*` (write = admin|can_manage_rates, read = manager+); every
  write emits an audit row + structured log (actor, table, before→after).
- **Variance report (D6):** `/dashboard/billing-variance` + CSV export
  (`/api/manager/billing-rates/variance?format=csv`) — per trans-charge source,
  tier-now vs tier-last-billed, per-haul delta, monthly leakage. Last-billed history
  reads through a provider seam; until the ADR-0039 audit-engine workbook staging
  lands the report shows an honest empty state (tier-now only) with a TODO banner.

### Added — 2026-07-03

- **Loads & inventory foundations (ADR-0037, P1 groundwork; reconciled to mission
  Addendum B).** Takes the loads/inventory/commodity layer from built-but-dormant
  toward production, CA-first, in the **Addendum B** shape (operator-directed,
  2026-07-03; docs/QUESTIONS.md Q-4 ANSWERED). **Schema (one additive migration
  `20260703b_loads_inventory_foundations`, clean-replays on empty PG16):** five new
  tables — `state_program_rules` (effective-dated rate/rule table; rates are DATA,
  never code), `consumer_dropoffs` (CA CIP drop-offs, with a
  `kind` incentive|unpaid|illegal), `outbound_materials` (commodity × sub-category —
  renovation folds the old renovator channel in), `landfilled_units`,
  `processed_units_daily` (the daily close) — plus a `source_aliases` table and
  `sources` flags (`is_non_program`, `is_trans_charge`, `canonical_mileage`),
  `inbound_loads` extensions (`retrac_id` indexed, `slip_number`, `transport_charged`,
  `freight_cents`, `fuel_surcharge_cents`, `program_unit_count`,
  `non_program_unit_count`), `site_inventory_snapshots` extensions (`snapshot_kind`
  physical|computed, `reconciled_delta`, `source`), and `LoadSourceType` + `event`.
  `outbound_materials.commodity` is the **daily-log 9** (`trash, toppers, foam, metal,
wood, cardboard, plastic, shoddy, cotton`), with `sub_category`
  (renovation|baled|shredded) + nullable `whole_units`/`program_units`/
  `non_program_units` on renovation rows. `processed_units_daily` carries
  `stripped_program`/`stripped_non_program`, `saved_units` (captured, EXCLUDED from
  inventory math — B10-2 open), and daily-close metadata (`material_ticket_number`,
  `employees_count`, `processors_count`, `pocketcoil_estimate`). All ids TEXT; money
  integer cents; unit counts Decimal(7,1). Idempotent `state_program_rules` seed
  (Addendum B5): CA processing effective-dated 2025=1600¢/2026=1650¢/2027=1700¢, OR
  processing 1700¢, OR satellite 225¢, CA collector_incentive 300¢ cap 5/day, CA
  fuel_surcharge formula-driven with a $5.05/gal trigger — **never seeded for
  Oregon** — plus CA driver_hourly 12500¢, general_labor_hourly 9000¢,
  per_diem_nightly 27500¢, and `unit_weight_estimate` {lbs:55, estimate_only} both
  sites. No mattress/foundation categories anywhere; no DR3#/Material# sequence
  issuance yet (B10-6 open).
  **Libs (TDD):** `program-rules/resolver.ts` — strict effective-date resolver; OR
  fuel surcharge structurally disallowed at BOTH layers (never seeded AND the
  resolver throws `RuleStructurallyDisallowedError`, reading site jurisdiction, not
  hardcoding ids); fuel computation refuses (typed error).
  `dropoffs/incentive.ts` — pure per-person-per-day cap function (cap on UNITS paid;
  incentive kind only). `inventory/running-balance.ts` — the ONE shared pool-aware
  balance `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`
  (WholeUnitsSold reads renovation-sub-category outbound; baled/shredded never
  subtract; saved excluded) + `reconcilePhysicalCount` (records
  `reconciled_delta = physical − computed` with an audit row). `loads/verify-gate.ts`
  — server-side enforcement that a load cannot reach `verified` unless
  `program + non_program == total_units`, with the DEFAULT split derived from the
  load's source `is_non_program` flag (manager override wins, B7).
  `loads/processed-units.ts` — daily close derives whole-units-sold + landfilled
  from the day's renovation outbound + landfilled rows for confirmation (never
  entered twice). **Surfaces:** super-admin `/admin/processed-units` daily close
  (stripped split + saved + close metadata; close writes audit; post-close edits
  blocked → amendment path); admin-gated manager `/dashboard/<site>/loads-inventory`
  CRUD-lite for drop-offs / outbound (commodity × sub-category) / landfilled + a
  running-balance readout; all site-scoped, `onClick` handlers (no `<form>`), audit
  row in the same transaction as every mutation. Drop-off `person_name` is CIP PII
  (Exhibit I / ADR-0010) — kept off every export. New surfaces linked from the
  dashboard tile matrix but **admin-only for now** (ADR-0037 D7 activation gate — the
  manager audience opens once the restore-drill + off-box-backup ops gates close).
  **Investigation findings (1a/1b):** (1a) there was **no** verify action on `main`
  at all — `submitted → verified` existed only in the load-service state table with
  no implementation, so the new columns are the persistence and this build adds the
  gate; (1b) `processed_units_daily` is a NEW site-level billing record, distinct
  from the ADR-0030 daily production total (a query over `bonus_daily_entries` +
  adjustments) — it does not duplicate the payroll tables and does not touch payroll.
  **Reconciled to Addendum B** (PR #47, workbook reverse-engineering): dropped
  `renovator_shipments` (folded into `outbound_materials.sub_category = renovation`),
  re-based the commodity taxonomy to the daily-log 9, added `sub_category` +
  whole-unit pool columns, `consumer_dropoffs.kind`, `LoadSourceType` + `event`,
  site-driven program-ness (`sources` flags + `source_aliases` + verify-gate
  default), the restructured daily close (stripped + saved + metadata; whole-sold +
  landfilled derived), the `End = Start + Inbound − Stripped − WholeUnitsSold −
Landfilled` balance, and the Addendum B5 rate seeds. Still open per B10: outbound→
  invoice block mapping (B10-5), `saved_units` semantics (B10-2), DR3#/Material#
  sequences (B10-6), CA fuel COMPUTATION (P2). ADR-0037 "Post-acceptance revision —
  Addendum B" itemizes every change vs the accepted text. Operator guide:
  `docs/operator/loads-inventory-foundations.md`. (ADR-0037)
- **MyMRC ingestion rebuild — JSON transport, mirror tables, loud failure (ADR-0038).** The MyMRC feed (0 rows because the old DOM scraper broke silently twice — most recently landing logged-out on a 404 and reporting "ok") is rebuilt on the Salesforce **Aura/JSON** transport. New migration `20260704_mymrc_mirrors` adds four additive tables: `mymrc_hauls_mirror`, `mymrc_processed_mirror`, `mymrc_outbound_mirror` (raw audit-evidence mirrors keyed by Salesforce record id, with `external_*_id` UNIQUE, full `payload` jsonb, and first/last_seen/disappeared/detail_fetched lifecycle) and `mymrc_sync_runs` (per-site-per-feed run ledger, status `ok|auth_failed|contract_drift|error`). New `src/lib/mymrc/`: `portal-client.ts` (the ONLY transport — Playwright login + in-page Aura interception; typed `AuthFailedError`/`PortalContractDriftError`; **hardened `isLoginPage()`** that catches the 404/logged-out shell), `mappers.ts` (JSON record → mirror rows; DST-correct Pacific parse of `Docking_Appointment_Time__c`), `sync.ts` (one run per site per feed: list → mirror upsert with disappeared detection → bounded ≤3 detail pass → run-ledger row ALWAYS, incl. on throw; **zero-anomaly** rule = 0 listed where the last success listed >0 ⇒ error), and `ntfy.ts` (self-contained `dr3-vision-system` pager with per-fingerprint dedup). Hauls also feed `expected_loads` via the existing upsert, now with **source=manual overwrite protection** (operator/manual rows — any non-`H-` id — are never scrape-cancelled). Deadman (no successful run >26h) pages per tick. The old `parser.ts` (HTML) + `scrape.ts` were deleted and replaced by fixture-tested JSON mappers (fixtures captured LIVE 2026-07-03, person names redacted, under `src/lib/mymrc/__fixtures__/`). Transport ladder decided empirically = in-page interception (#2); raw fetch-replay (#1) proven viable but deferred (fwuid-fragile) — see the ADR post-acceptance notes. The `mymrc-scrape` compose service is rebuilt but stays profile-gated (`mymrc`); enabling is an operator action per the new `docs/operator/mymrc-ingestion.md`. A green run with no data is now impossible by construction. (ADR-0038)
- **Survey daily reminders + campaign auto-close (ADR-0036).** For every OPEN survey campaign, a new 09:00 America/Los*Angeles daemon (`scripts/survey-reminder-cron.mjs`) POSTs an internal, loopback-guarded route (`/api/internal/survey/reminder-tick`) that sends **one reminder per day** to each still-unsubmitted invite until it completes, then **auto-closes** the campaign once the last response lands. Reminder copy is tiered on the invite's live state: opened-with-saved-answers ("your progress is saved" → \_Finish your survey*), opened-but-empty (friendly nudge → _Open your survey_), and sent-but-never-opened (original subject + a "resending in case it got buried" line). A 20h DB gate (`survey_invites.last_reminder_at`/`reminder_count`, additive migration `20260703_survey_invite_reminder_tracking`) makes reminders idempotent — a restart or slightly-early fire never double-sends, and a no-op fires cleanly when no campaign is open. Auto-close closes under a system actor (`actor_label: 'system:survey-reminder-cron'`), fires a `dr3-vision-system` ntfy (fingerprint `survey-campaign-autoclosed:<id>`), and does NOT run the export — the admin Export button still works after close. Drafts do not block auto-close; approved/sent/opened invites do. Reminders are unbounded by design (operator directive) — stop them by closing the campaign in the admin UI or `docker stop dr3-vision-survey-reminder`. New compose service `survey-reminder` (no `db.env` — the daemon reads nothing). The invite + three reminder tiers now share one branded email shell. (ADR-0036)

- **3-way audit engine + Audit Workbench + retro-audit (ADR-0039).** The third P1 ADR. Compares three structurally-independent legs — Vision operational data (ADR-0037), MyMRC mirrors (ADR-0038), and billing (P2 / historical workbooks) — via pure comparators, so no leg feeds another. New tables (migration `20260705_audit_engine`, additive, clean-replays standalone): `audit_findings` (fingerprint UNIQUE, status/cause_category enums, lifecycle), `audit_check_config` (per-check tolerance/severity DATA not code — seeded defaults incl. C3 EOD+1 grace and the C4 45-day vendor window), `workbook_imports` + `workbook_import_rows` (retro-audit staging with tab/row/col provenance), and the `audit_runs` ledger. **Comparators C1–C7** (`src/lib/audit/comparators/`) are pure `(window, legA, legB, config) → Finding[]` functions with distinct finding kinds (missing_counterpart / value_mismatch / date_mismatch): C1 inbound, C2 processed, C3 outbound (EOD+1 grace), C4 billing basis, C5 program/non-program conservation (passes Rick Q11's 150P+25NP-legal / 151P-illegal worked example), C6 inventory continuity (Addendum B §B4 equation + the Friday→Monday / DAY6 roll-break class), C7 business-day deadline clocks (3d inbound / 1d processed / 3d outbound-from-EOD, reusing `compliance.addBusinessDays`). **Findings lifecycle**: upsert-by-fingerprint (stable across runs + windows), last_seen refresh, auto-resolve when legs agree, auto-reopen on recurrence, manual acknowledged/resolved/not_an_issue transitions with cause_category + note — every transition audited in the same transaction (append-only, hard rule #6). **Retro-audit**: an admin uploads a historical monthly workbook (`exceljs` added — the repo had no xlsx lib; papaparse is CSV-only); the parser tolerates ≥3 template generations and the Summary-recompute check reproduces the §4.1 sum-range drift — recomputing every Summary figure from the workbook's own detail rows and flagging the rows the template's SUM range clipped (the fuel-rows-71–130 "money already dropped" class, caught by a synthetic fixture). Site names resolve through an alias interface; unresolvable names emit an `unresolved_site` finding, never a dropped row. **Nightly sweep**: thin 02:30 PT daemon (`scripts/audit-sweep-cron.mjs`, `redirect:'manual'`) → internal loopback-guarded route (`/api/internal/audit/sweep`) with the middleware exemption added on day 1 (`/api/internal/audit/` in `src/lib/public-paths.ts` + regression test — the ADR-0036 lesson); it writes a run record and pages `dr3-vision-system` only on sweep failure. New compose service `audit-sweep`. **UI** (`/dashboard/[site]/audit`, site-scoped, English-first office surface): findings queue with check/status/severity filters, per-finding expected/actual JSON + provenance + classify/act controls (onClick, not `<form>`), and a Workbench tab rendering three rollup frames from a typed provider + drill-down wiring points. **Billing trust gate** (`src/lib/audit/billing-gate.ts`): pure `gateForWindow` + audited super-admin override for P2 to consume. **Integration complete (2026-07-03):** the DB-fetch layer (`src/lib/audit/leg-fetchers.ts`, `buildRunChecksForWindow`) maps the merged ADR-0037/0038 Prisma models onto the comparator interfaces and is wired into the sweep, so the nightly sweep and a new **on-demand run** action (`POST /api/audit/<site>/run`, site-scoped manager/admin) audit the LIVE legs. Real sibling shapes forced adjustments: C7's "entered in MyMRC" instant derives from the matched mirror row (no Vision-side submit column exists); C2's program/non-program sub-checks degrade to the total-units comparison (the processed mirror carries no split); the outbound Material-# join is `external_materials_id` (the outbound mirror has no ticket/units columns and uses `shipment_date`); the inbound-load provenance is `manual` with the site name from the `source` relation (no scalar record-source). C5/C6 internal-invariant inputs derive per-day from the operational rows anchored at, and reusing, the ONE shared `computeRunningBalance` (cross-checked in tests); C6 gained an `npStripped` term to model Woodland non-program co-processing (`stripped_non_program`). The Workbench is **live** over the real tables (`dbWorkbenchProvider`) with honest empty-window states; historical workbook site names resolve through the `source_aliases`-backed resolver (canonical `Source.name` first, then the alias table; unresolved → `unresolved_site` finding). The audit `Commodity` type was corrected to the daily-log-9 (Addendum B §B1) to match the merged `OutboundCommodity` enum. (ADR-0039)

### Fixed — 2026-07-03

- **P1 observability & correctness hardening of the just-merged ADR-0037/0038 code
  (operator-directed: "make sure error logging is baked into everything so we can
  diag later easily").** One pass, TDD where behavior changed, all diagnosable now.
  - **Loud, structured logging on every non-2xx.** The `processed_units_daily`
    routes (GET/POST + `[id]/close`) now emit a request-correlated (`x-request-id`
    child logger) `warn`/`error` line — `{op, actor, site, status, reason}` — on
    every rejection incl. `forbidden`/`invalid_input`/`site_not_found`/service
    errors/unexpected 500s. `loadsErrorResponse` (the four manager resource families
    — dropoffs, outbound, landfilled, loads-verify) now logs the mapped error with
    `reason`/`status` (and an `error`-level line before re-throwing an unexpected
    500), threading a `{site, id, op, requestId}` context from every call site.
  - **MyMRC sync run correlation + failure logging (ADR-0038).** Each site+feed run
    mints a `runId` (crypto.randomUUID), prefixes every log line with it, and
    persists it on the `mymrc_sync_runs` row (new nullable `run_id`, additive
    migration `20260704b_sync_run_correlation`, clean-replays on PG16). The
    run-ledger write is now a real try/catch that logs the **error class** + run
    context (never a silent `.catch`); detail-fetch failures log the record's
    business `externalId` alongside the Salesforce record id. `upsertScrapedHauls`
    now logs (warn, once per run) the **deduped unmatched source/transporter NAMES**
    (a missing seed row → null FK) and returns them in `UpsertSummary`, not just
    counts.
  - **Verify-gate never defaults billing attribution blind (ADR-0037 D2).** When an
    inbound load has **no source** and no explicit split is supplied, `verifyLoad`
    now THROWS a typed `VerifyGateError('no_source_for_default')` (422) instead of
    silently crediting the whole load to the program (billed) pool; a source-driven
    default now logs `{loadId, defaulted:true, source flag}`.
  - **Daily-close negative-balance guard (ADR-0037 D6).** Closing a
    `processed_units_daily` day now computes the pool-aware running balance (the ONE
    `onHand`/`computeRunningBalance`) as of end-of-day; if either pool would go
    negative (an upstream inbound gap) it returns a typed 422 with the numbers —
    UNLESS `acknowledgeNegative: true` accompanies the request, in which case the
    close proceeds and the acknowledgment + balances are recorded in the close audit
    row (warn-and-confirm posture).
  - **Effective-dated rate resolution proven unambiguous (ADR-0037 D1).**
    `resolveProgramRule` now fetches all covering rows and throws a typed
    `AmbiguousProgramRuleError` (naming the tied row ids) when two rows share the
    winning `effective_from` — money math never coin-flips a rate. Legitimate
    supersession (distinct `effective_from`) is unaffected.
  - **Dropoff incentive failures fail loud + typed (ADR-0037 D3).** A missing
    `collector_incentive` rule (`NoActiveProgramRuleError`) is logged with
    `{site, date}` before re-throw; recovering prior paid units from a stored
    `incentive_cents` that no longer divides the rate now throws a typed
    `IncentiveComputationError` (500 with `{person, date, incentive_cents}` logged)
    instead of a bare `RangeError`.
  - **Efficiency (N+1 kills, behavior identical).** `listProcessedUnits` replaces
    per-row `deriveDailyOutflow` with two grouped aggregate queries over the date
    range (tests assert list == per-day-derive equivalence); `upsertScrapedHauls`
    replaces the per-haul `expectedLoad.findUnique` with one batched `findMany` +
    live map.
  - **Route-layer pagination clamp.** The manager list surfaces (dropoffs, outbound,
    processed-units) now clamp a client `?limit=` to `[1, 200]`, falling back to the
    default on absurd/non-numeric input, so no request can force an unbounded scan.
  - **Portal list completeness diagnostics (ADR-0038 D4).** The MyMRC Aura getItems
    payload carries no absolute record total (verified against the captured
    fixtures — only `hasMoreData`/`offset`), and `hasMoreData=true` is a NORMAL live
    state for large feeds, so a throwing count-guard would false-page every run;
    instead `extractListView` surfaces the `hasMoreData` window signal and the
    transport WARNs loudly when a list is windowed (disappeared-detection sees only
    that page), while the existing "no getItems action" / error-list-view / settle
    guards stand.
- **Survey reminder-tick was blocked by the auth middleware (ADR-0036 hotfix).** `/api/internal/survey/reminder-tick` was missing from the middleware public-path exemptions (only `/api/internal/bonus/` was listed), so the daemon's first 09:00 PT fire was 307'd to `/login` — and because `fetch` follows redirects by default, the login page's 200 made the tick log **success while sending nothing**. Three-layer fix: (1) the public-path predicate moved to `src/lib/public-paths.ts` (pure, edge-safe) with the `/api/internal/survey/` exemption added and a regression test over the whole exemption list (`src/__tests__/public-paths.test.ts`); (2) the daemon now uses `redirect: 'manual'` and treats any redirect or non-200 as a failure (a login 307 can never masquerade as success again); (3) response bodies in daemon logs are truncated to 300 chars (the failure had dumped a full HTML page). The route's own loopback/cf-connecting-ip + bearer guards are unchanged — the exemption only lets the session-less in-fleet caller reach them, same trust model as the bonus cron routes. After deploy the missed 2026-07-03 tick was re-fired manually (in-network POST), so the outstanding invites still got their day's reminder.
- **Pre-push gate (ADR-0033 / P0-4) no longer blocks deletion-only pushes.** `git push origin --delete <branch>` pushes no code, but the hook still ran the full tsc + payroll-suite gate — which blocked the 2026-07-02 stale-branch sweep on type errors from an unrelated stale generated Prisma client. The hook now reads the ref list git supplies on stdin and skips the gate only when EVERY pushed ref is a deletion (all-zero local sha); a mixed push (deletion + real ref) still gets the full gate. Regression tests in `src/__tests__/pre-push-hook.test.ts` cover deletion-only, empty-ref, mixed, and normal pushes.

### Fixed — Sprint 6

- **Migration ordering: clean-replay invariant (ADR-0035)** — `prisma migrate deploy` replays migrations in lexical directory-name order. On disk, `20260616_amendment_submission_group` sorted _before_ `20260616_amendment_workflow`, so a clean/DR replay ran the `ADD COLUMN submission_group_id` ALTER before the `CREATE TABLE bonus_amendment_requests` it depends on → `P3018 / 42P01 relation … does not exist`. The **live** DB was never affected (it applied them in the correct order: `_amendment_workflow` 2026-06-15 21:51, then `_amendment_submission_group` 2026-06-16 01:39). Renamed the directory to `20260616_amendment_workflow_submission_group` (byte-identical SQL — checksum unchanged), which provably sorts between `_amendment_workflow` and `20260617_daily_production_report`. Clean replay now applies all 16 migrations with `migrate status` up to date. The new `migrations` CI job (clean Postgres 16 replay) is the gate that caught this and now enforces the invariant. **Live ledger reconciliation required before next deploy** — single pure-rename `UPDATE _prisma_migrations SET migration_name='20260616_amendment_workflow_submission_group' WHERE migration_name='20260616_amendment_submission_group';` (1 row; no schema/data change); see ADR-0035 for sequencing.

### Added — Sprint 6

- **Operational intelligence survey system (ADR-0034)** — Vision-native survey for structured intelligence gathering across the DR3 team. New tables `survey_campaigns`, `survey_invites`, `survey_questions`, `survey_responses`. Public token-gated route `/survey/{token}` with no auth (token IS the access). Super-admin route group `/admin/operations/intel` for campaign management with per-invite approval gate and send confirmation interstitial that requires matching `confirmed_recipient_count`. Email send via existing M365 path, extended to support per-campaign sender display name, reply-to, and CC. SVdP-branded email shell matching the daily production report style. Idempotent seed pre-loads the DR3 Intel 2026-06 campaign with all 10 recipient packets (Bethany, Leisha, Shannon, Mary, Rick, Janette, Morena, Kelsey, Juan, Patrick) in draft status. Closing question "What are we missing?" appended to every packet. On campaign close, responses export as markdown to `docs/operations-intel/{slug}/` via the same ClaudeSync handoff mechanism used for sprint work. (#34)

### Fixed / Changed — Sprint 6 (survey launch hardening, 2026-06-23)

- **Public survey form (`/survey/[token]`)** — required-field validation now runs client-side: submitting with unanswered required questions no longer bounces the respondent off a bare server 422; the first gap is scrolled into view, focused, and every gap is outlined in red with an inline "required" note. Submit now opens a confirmation step before locking (irreversible action guard). Accessibility: inputs are associated with their prompt via `aria-labelledby`/`aria-describedby`, required fields carry `aria-required`/`aria-invalid`, radio/checkbox groups use `role="radiogroup"`/`role="group"`, and the save-status line is an `aria-live` region. A select question that reaches a respondent with no configured options now renders a clear empty-state instead of a blank gap (and does not trap the required gate). An `already_submitted` race now refreshes cleanly into the thank-you view.
- **Invite editor** — saving a packet with an empty prompt, or a `single_select`/`multi_select` with zero options, is now blocked client-side with a precise inline message (previously POSTed an invalid packet and surfaced a bare "save failed: 422"). Server error reasons are translated to human text. Added a Label|value hint under select kinds.
- **Campaign detail** — header now shows a status pill and a roster summary (invites / approved / submitted); the Send button explains why it is disabled and a hint guides the operator to approve first; Export/Close actions give typed success/error feedback that auto-clears; busy states are reflected on every action button.
- **Survey input legibility + mobile (post-launch hotfix)** — respondents reported the text they typed was nearly invisible. Cause: the `<input>`/`<textarea>` set no explicit `color`/`background`/`color-scheme`, so a device in dark mode (common on phones) painted the field text with a light system color, and `fontSize:14` triggered iOS zoom-on-focus. Fixed by setting explicit `color:#1a1a1a` (+ `-webkit-text-fill-color` to defeat iOS/autofill light text), `background:#fff`, and `colorScheme:'light'` on both text fields, bumping field text to `16px` (no zoom-on-focus, more legible), and adding a dark base `color` + `colorScheme:'light'` on the page `<main>` so inherited-color text (select-option labels, radios, checkboxes) is also high-contrast on the cream theme regardless of OS dark mode. Input behavior (value/onChange/aria) unchanged — no inputs broken; SurveyForm tests green.
- Added component tests for the survey-form required-gate + select empty-state and for the invite-editor validation guards. Full gate green (tsc, eslint, vitest, next build).
- **Admin survey preview now renders (2026-06-23)** — the invite-preview "Survey page" tab (`InvitePreview.tsx`) embeds the survey in a same-origin `<iframe src="/survey/{token}?preview=1">`, but a global `X-Frame-Options: DENY` in `next.config.js` forbade _all_ framing — including same-origin — so the iframe came up blank ("vision won't connect"). Fixed by adding a more-specific `/survey/:path*` header block that sets `X-Frame-Options: SAMEORIGIN` and appends `frame-ancestors 'self'` to the (otherwise identical) CSP, while every other route keeps the hard `DENY` via a negative-lookahead `source` so the global block never re-emits `DENY` onto the survey route. Verified against the _emitted_ response headers (not config intent) and with a headless same-origin iframe load. Separately, the survey page now SKIPS `markInviteOpened` when `?preview=1` is present, so an admin previewing a sent invite never flips its status to `opened` or stamps `first_opened_at`. New regression test asserts the resolved header blocks (`src/__tests__/next-config-headers.test.ts`).

### 2026-06-23 — Payroll incident resolved + enterprise P0 hardening

Resolved the 2026-06-22→23 Woodland P13 incident: the delivered payroll PDF was
always correct ($2,125.50, verified from R2 bytes); only the internal
`total_payout_cents` field was wrongly $0 (Decimal type bug). **Audited backfill**
0→212550¢ (audit_log row, fresh restic snapshot). Three root causes fixed
(`5192345`, `526f46d`). Four P0 guardrails added (ADR-0033, `6d14406`): payout
reconciliation tripwire, implausible-$0 delivery guard, loud payroll-failure ntfy,
and a pre-push/CI correctness gate. Enterprise-readiness gameplan + buildout
checklist: `docs/handoffs/2026-06-23-current-state-and-buildout-readiness.md`.

### 2026-06-23 — Payroll-correctness guardrails: reconciliation tripwire, zero-payout guard, loud failures, correctness gate (ADR-0033)

Four P0 enterprise-hardening guardrails closing the OUTER RING around the
payroll-critical path, all on top of the Decimal-lock fix below. No payout/period
data touched; no calculator math changed. **NOT deployed** — operator coordinates
deploy after the in-flight signature.

- **P0-1 — Reconciliation tripwire.** New invariant: for a `signed`/`paid` period,
  the recomputed grand total MUST equal the locked `total_payout_cents`. Pure
  logic in `src/lib/bonus/reconcile-payout.ts`; independent recompute + page in
  `src/lib/bonus/reconcile-fetch.ts`. Wired into `generateBonusPdf` (pre-upload)
  and `triggerPayrollDelivery` (pre-mail) so a mismatched PDF can never reach R2 or
  payroll. On mismatch → refuse + URGENT ntfy `payout-reconcile-mismatch:<monthId>`.
  Exact integer equality of the same computation → no false positives by design.
  This is the assertion that would have caught tonight's $0-lock-vs-$2,125.50-PDF
  disagreement.
- **P0-2 — Implausible-(zero)-payout delivery guard.** Predicate: block delivery
  iff `lockedTotalCents === 0` AND `recomputedTotalCents > 0`. A `$0` that AGREES
  with the entries (everyone sub-threshold, e.g. Timothy Elich 24 mattresses) is a
  real `$0` and is ALLOWED; a `$0` that DISAGREES is blocked + URGENT ntfy
  `payout-zero-suspected:<monthId>` for human confirmation.
- **P0-3 — Loud payroll failures.** ntfy pages added to previously log-only paths:
  signer unresolvable / no email (`signer-unresolved`), signature-request mail
  failed (`signer-mail-failed`), PDF generation failed for a signed period
  (`payroll-pdf-failed`), missing `pdf_storage_key` (`payroll-pdf-missing-key`),
  R2 unconfigured (`payroll-r2-unconfigured`), sign-route notify threw
  (`signer-notify-threw`). Per-fingerprint cooldowns. CONFIG-ABSENT (M365 unset)
  stays SILENT and fail-open — the app still boots without M365 (hard rule #5).
- **P0-4 — Correctness gate.** `.husky/pre-push` runs `tsc --noEmit` + the
  bonus/payroll vitest suite, blocking the push on failure, and SKIPS cleanly when
  `node_modules` is absent (the in-container deploy clone can still commit/push).
  `.github/workflows/ci.yml` runs `tsc` + lint + full `vitest run` + `next build`
  on push/PR (targets `ubuntu-latest`; self-hosted runner labels unconfirmed —
  switch `runs-on` if desired). This is the gate the original `total_payout_cents:
number` type-lie would have tripped.

Tests: `reconcile-payout.test.ts` (pure matrix), `reconcile-fetch.test.ts`
(recompute coercion + mismatch pages + zero-guard agree/disagree),
`payroll-delivery.test.ts` (P0-3 pages + pre-send blocking), and additions to
`signature-notifications.test.ts` (P0-3 signer pages, config-absent stays silent).
See `docs/adr/0033-payroll-payout-reconciliation-guards.md`.

### 2026-06-23 — Payroll-correctness fix: sign-time payout lock zeroed by Prisma Decimal

Confirmed payroll-correctness defect. When a bonus pay period reached `signed`,
the sign-time lock in `src/lib/bonus/signatures.ts` (the `if (fullySigned)` block)
passed each entry's `mattress_count` **raw** into `calculateMonthlyBonusCents`.
`mattress_count` is a `Decimal(5,1)` — Prisma returns a `Decimal` object, not a JS
number — and the calculator's `Number.isFinite()` guard rejects a non-number, so
**every entry contributed 0 and the period locked to `total_payout_cents = 0`**.
The on-screen / PDF / CSV paths coerce with `.toNumber()` and computed the correct
figure, which is why the screen showed a real bonus while the locked (and paid)
total was $0. Woodland period `9b3dc951-4c0c-4c2c-b68c-e3e7ac726211` (2026-06-09→22,
99 entries) locked **$0** but should be **$2,125.50 (212550 cents)** — verified by
reproducing the corrected formula against the live entries + active rule.

Why static typing didn't catch it: the `SignatureDb` structural type declared
`bonusDailyEntry.findMany` as returning `{ mattress_count: number }[]` (a type lie),
so `tsc` saw a number and the number-based mock in `signatures.test.ts` never
exercised a real `Decimal`.

**Fixes:**

- **Lock site:** coerce via a new `toCount()` helper before calling the calculator
  (`entries.map((e) => toCount(e.mattress_count))`), mirroring the `.toNumber()`
  coercion the on-screen/PDF/CSV paths already use so the signed total can never
  diverge from the displayed total. `SignatureDb.bonusDailyEntry` retyped to the
  truthful `DecimalLike` (`number | { toNumber(): number }`).
- **Calculator hardening:** `calculateDailyBonusCents` now THROWS `TypeError` on a
  non-`number` `units` (Prisma `Decimal`, numeric string, object) instead of
  silently returning 0 — a payout calc must never silently yield $0 from a type
  error. Existing numeric behavior is unchanged: genuine `NaN` / `Infinity` /
  negative / below-threshold numbers still return 0.
- **Regression tests:** `signatures.test.ts` feeds real `Prisma.Decimal` counts
  through the sign-time lock path and asserts the correct non-zero total (FAILS on
  pre-fix code: locks `+0`); `calculator.test.ts` asserts non-number input throws.

NOT deployed. **No payout / `bonus_pay_periods` data mutated** — the operator
re-triggers the recompute via the amendment flow once this fix ships.

### 2026-06-23 — Payroll-signing incident fixes: signer-notification + PWA stale-shell

Two confirmed defects from the 2026-06-22 payroll-signing incident (contributed
to a missed deadline). NOT yet deployed — held until payroll clears (a deploy
re-triggers the PWA shell swap).

**Defect 1 — signer notification resolved the WRONG signer (signers never emailed).**
`resolveSlotSigner` (`src/lib/bonus/signature-notifications.ts`) resolved the ops
signer by a legacy heuristic (`primary_site_id IS NULL`), which disagreed with the
authoritative `bonus_signature_chains` row used by the sign route and the month
page. Woodland's ops signer (Morena Gomez) has a non-null `primary_site_id`
(Woodland), so the null query returned nobody and she was **never emailed her
signature request** ("no email for the responsible signer; skipping", signer_id
null). Fix: resolve the signer from `getSignatureChain(siteId)` (the same source
`naturalSlotFor` / the month page / `signer-names.ts` use), then load that user by
id. Regression test added (ops signer with a non-null `primary_site_id` must still
be found + emailed). No payout/`bonus_pay_period` data touched.

**Defect 2 — PWA stale-shell stranded signers after a deploy (read-only error).**
`src/app/UpdatePrompt.tsx` (ADR-0027) only detected a waiting SW on `updatefound`
(navigation / ~24h browser cadence), so an open signer tab could keep serving the
stale read-only shell indefinitely. Hardened: poll `registration.update()` every
60s and on tab-visible; **auto-promote** the waiting worker silently when the tab
is hidden (safe — operator not mid-entry), keeping the explicit reload banner only
while the tab is visible. `skipWaiting:false` and the offline-queue caching are
unchanged. See ADR-0027 addendum.

### 2026-06-22 — DB backups + MyMRC portal-redesign login fix

**Backups (NEW — DB previously had NONE):** nightly encrypted Postgres backups to
Cloudflare R2 via restic — `scripts/dr3-pg-backup.sh` + systemd
`dr3-vision-pg-backup.{service,timer}` (03:45 PT, retention 7d/4w/12m/5y, AES-256).
First snapshot verified. RESTIC_PASSWORD (recovery key) → 1Password. See
`docs/operator/backups.md`.

**MyMRC:** MRC redesigned the Salesforce portal; the old scraper silently failed
(logged-out 404 parsed as "0 hauls ok"). Login selectors fixed + verified live, no
MFA (SELECTOR_VERSION 2026-06-22). Data pages moved/expanded (`/s/hauls`,
`/s/processed-materials`, `/s/outbound-materials`); parser rebuild + loads/inventory
ingestion handed off to claude.ai. See `docs/MYMRC-PORTAL-REDESIGN-2026-06-22.md`.

### 2026-06-22 — SVdP ad-hoc mail sender (scripts/send-svdp-mail.sh)

Added `scripts/send-svdp-mail.sh`: sends ad-hoc Vision email **from dr3-vision@svdp.us**
via Microsoft Graph, reusing the running app container Entra credentials, with To + CC
support (the in-app `sendSystemEmail` has no CC field). Vision is the Society of St.
Vincent de Paul — a separate org from BarnardHQ — so Vision correspondence must originate
from an @svdp.us identity; this is the sanctioned channel for one-off reports. Used to
re-deliver the Woodland June 1–8 reconciliation report to morena.gomez@svdp.us
(cc bill.barnard@svdp.us) from the correct org identity.

### 2026-06-20 — Reporting-only production adjustments, decoupled from bonus math (ADR-0032)

**Headline.** Woodland **production totals** (daily-report month-to-date and the annual year-over-year aggregate) now reflect the operator's true paper figures, **without moving any bonus/payout dollar**. The closed pay period 2026-05-26…2026-06-08 stays frozen at `legacy_total_payout_cents = 96475` ($964.75), byte-for-byte. Operator decision 2026-06-19 ("Option B": reporting-only, keep payroll frozen).

**Mechanism.** A new, additive table `bonus_reporting_adjustments` (migration `20260620_bonus_reporting_adjustments`) — one signed unit delta per site per day (`UNIQUE(site_id, entry_date)`, TEXT ids/FKs per convention). Chosen over a "phantom employee" (would leak — bonus paths don't filter `is_active`) and over a `reporting_only` column on `bonus_daily_entries` (would force a filter onto every bonus-dollar query; high blast radius). **No bonus-dollar read path queries this table**, so an adjustment is structurally incapable of reaching payroll math.

**Invariant.** Production-QUANTITY read paths INCLUDE adjustments; every bonus-DOLLAR read path EXCLUDES them. Wired the complete production-quantity set: `sumRangeOrNull` in `daily-report.ts` (covers MTD, prior-month, **and same-day-last-year** YoY); the annual page `totalMattresses` (new `annualAdjustmentUnits` helper in `aggregates.ts`); the annual CSV export (a single `"Reporting adjustment (ADR-0032, production-only)"` provenance row, mattress column carries the delta, bonus column `0.00`). Left untouched: `employeeHistory`, per-employee `annualTotals` rows, `pdf-data.ts`, the bonus-PDF page, and `current-period.ts` standings — all bonus dollars / per-employee.

**Launch-month load.** Five Woodland adjustments — 6/1 −4, 6/2 +13, 6/4 +694, 6/5 +653, 6/8 +451 (net **+1,807**). Reason recorded on each row: _"Launch-month backfill: missing-day production (6/4,6/5,6/8) / paper reconciliation (6/1,6/2); reporting-only, payroll frozen per operator 2026-06-19."_

**Proof (before → after).**

- Frozen closed-period payout `legacy_total_payout_cents`: **96475 → 96475** (unchanged).
- Annual 2026 bonus-dollar total for Woodland: **unchanged** (adjustments never enter it).
- Woodland June MTD through 2026-06-18: **9,067 → 10,874**; per-day 6/1→940, 6/2→695, 6/4→694, 6/5→653, 6/8→451.
- Annual 2026 production-quantity aggregate: **+1,807** (now includes the adjustments).

**Test.** New cases in `daily-report.test.ts` (MTD includes ±adjustments; same-day-last-year non-null on adjustment-only window; bonus-dollar totals invariant under a large adjustment) and `aggregates.test.ts` + `export.route.test.ts` (`annualAdjustmentUnits` year/site scoping; CSV provenance row present/absent/negative; export integration). Suite **928 green**; `tsc` 0; ESLint clean. Migration auto-runs on deploy.

### 2026-06-17 — Hotfix: per-employee history 500 on historical periods (ADR-0031 / ADR-0023)

**Bug.** Opening a processor's history (`/bonus/employee/[id]`) — newly prominent via the ADR-0031 standings drill-in — returned the generic error page ("The error has been reported…"). Root cause from the app log: `NoActiveRuleError: no active processor_bonus_rules row for site …`. `aggregates.ts` (`employeeHistory` / `annualTotals`) resolved each period's rule with the **strict** `resolveActiveRule`, but the ADR-0023 historical import seeded entries back to **Jan 2025** while the `processor_bonus_rules` table only goes back to **2026-01-01** (verified on prod: 27 Woodland periods pre-2026 with 3,092 entries). Any processor with 2025 entries threw and 500'd the whole page. The same class was already fixed for the historical-PDF path in ADR-0023; the aggregate views were missed.

**Fix.** `ruleResolver` now uses `resolveRuleForHistorical` (the ADR-0023 fallback): a pre-rule period resolves to the site's earliest rule instead of throwing; live periods still resolve strictly. One-line behavioral change; also un-breaks the annual aggregate for prior years. (The new current-period standings/banner were never implicated — they resolve only the open period, which always has a rule.)

**Test.** Failing-first regression in `aggregates.test.ts` reproducing the prod `NoActiveRuleError` (rule effective 2026-01-01 + a 2025 period with entries), now green; the rule mock was upgraded to honor `effective_date`/`end_date` so the fallback path is actually exercised. Suite **919 green**; `tsc` 0; ESLint clean; `next build` ok. No migration.

**Status (ADR-0031 set).** All three pieces — live standings + per-employee banner, canonical `Period N · <range>` labels, and this historical-rule hotfix — are shipped to prod (svdp-dev) and **operator-confirmed 2026-06-17** (Bill confirmed the history page loads).

### 2026-06-17 — Current pay-period standings (ADR-0031)

**Headline.** Adds a live, in-progress view of where every processor stands in the **open** bi-weekly pay period — the piece the cross-period history and closed-period reports never surfaced. Fixes the Reports "Per-employee history" card, which linked to the employee **roster manager** (`/bonus/employees`) and showed no bonus data: it now opens **"Current pay period — live standings"** (`/bonus/standings`).

**What you see.** Per active processor for the open period (e.g. _Period 13 · Jun 9–22_): **units so far · days qualified · days short of the minimum · bonus accrued**. "Days short" = a keyed day whose bonus is $0 because units didn't exceed the rule's daily minimum (Woodland: >50/day); `daysQualified + daysShort = days keyed`. Days with no entry count on neither side. The qualifying threshold is read from the effective `processor_bonus_rules` row, never hardcoded.

**Surfaces (the operator's "both").**

- `/bonus/standings` — new `force-dynamic` report: live all-processor table, name-sorted, each row drilling into that processor's full history. Same `tryBonusAccess` gate as the other bonus surfaces; Eugene + Woodland via `?site=`. "No open period" empty state when today falls outside every seeded period.
- `/bonus/employee/[id]` — now leads with a **Current pay period** banner (the four live metrics, marked _in progress_) above the existing YTD + last-12 + history.

**Service layer — `src/lib/bonus/current-period.ts`** (new, isolated, read-only). Resolves the period covering Pacific "today" by the daily grid's date-range contract, then tallies every keyed entry through the shared `calculateDailyBonusCents`, so standings can never diverge from the daily grid or the signed PDF (hard rule #3). `currentPeriodStandings(siteId)` returns all active processors (a processor with no keyed day yet shows at zero, so the full roster is visible); `currentPeriodForEmployee(siteId, employeeId)` is a focused per-employee query (correct for a since-deactivated processor; never loads the roster).

**Reports card.** "Per-employee history" → **"Current pay period — live standings"** pointing at `/bonus/standings`. The roster manager stays reachable from the `/bonus` landing ("Manage Employees"), so nothing is orphaned.

**History-table labels fixed (same ADR).** The cross-period history table on the detail page had labeled periods by calendar month (`monthLabel`, e.g. "June 2026"), a pre-cadence artifact — so two bi-weekly periods in one month rendered **duplicate** labels. Now a shared `src/lib/bonus/period-label.ts` is the single source of truth for the canonical `Period 13 · Jun 9–22, 2026` label, used by the standings table, the current-period banner, and the history table alike. `employeeHistory` emits `label` (full) + `shortLabel` ("Period 13", for the trend bar list); detail-page copy corrected ("Last 12 months" → "Last 12 pay periods", "Monthly totals" → "Per-period totals", "Month" column → "Pay period"). The PDF/email surfaces keep their own labels (separate concern, untouched).

**Gates.** New `current-period.test.ts` (8 cases) + a duplicate-label regression test in `aggregates.test.ts` + updated `BonusReports.test.tsx`. Full suite **918 green** (was 909); `tsc --noEmit` 0; ESLint clean; `next build` ok. No migration (read-only over existing tables).

### 2026-06-17 — Sprint 5: daily production report (ADR-0030)

**Headline.** Replaces Morena Gomez's manual 6 PM Pacific daily processing email for Woodland and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile (`/admin/production-report`). Recipients, send time, subject template, and skip rules are all editable through the UI; every config change is audit-tracked. Email body includes per-employee mattress count + bonus dollars + total processed + total bonus paid + four comparison lines (same day last year, MTD, prior month same period, percentage delta).

**Migration `20260617_daily_production_report`:** three new tables — `bonus_daily_report_config` (per-site, unique on site_id), `bonus_daily_report_recipients` (child table, unique on (config_id, email)), `bonus_daily_report_log` (per-day idempotency, unique on (site_id, report_date)). Plus a new `is_super_admin` boolean column on `users`, defaulting false, with the seed flipping Bill to true.

**Seed:** Both sites enabled at 18:00 Pacific. Woodland recipients: bill, bethany, morena. Eugene recipients: shannon, bill, bethany, rick. Re-running the seed is idempotent (`ON CONFLICT DO NOTHING` on recipients; `ON CONFLICT DO UPDATE` on config).

**Service layer:**

- `src/lib/bonus/daily-report.ts` — pure aggregation. Per-employee bonus via `calculateDailyBonusCents` against the site's effective `processor_bonus_rules`. Date math handles leap years, year boundaries, and short-month clamping. Comparison totals return `null` on empty windows so Eugene's sparse history renders gracefully.
- `src/lib/bonus/daily-report-config.ts` — config + recipient CRUD with in-transaction audit logging. Email validation app-side (lowercase normalization, regex). Time validation accepts `HH:MM` or `HH:MM:SS`.
- `src/lib/bonus/daily-report-notifications.ts` — subject + HTML body rendering, per-recipient `sendSystemEmail`. Header reads "DR3 - {Site} Automated Production Report" + dated subtitle. Color-codes the pace delta (green up, red down). Conditional sections honor `include_bonus_dollars` and `include_comparisons`. **SVdP-branded** (operator request 2026-06-17): St. Vincent de Paul Society of Lane County palette from `svdp.us` — red `#a3151a` masthead with the white SVdP wordmark, gold `#ffcc69` accent, cream `#f7f3ea` panels. Table-based, inline-styled, ≤600px for Outlook/M365 fidelity. (Deliberately the SVdP parent-org palette, distinct from the DR3 green/black in-app brand.) Default subject tightened to `DR3 Daily Production Report — {site} — {date}`.
- **Math-correctness hardening (correctness audit, 2026-06-17):** floor each `Decimal(5,1)` entry consistently across per-line units, the bonus basis, and every range sum — so `totalToday` always reconciles with MTD and per-line bonus equals the signed payroll PDF (`month-list.ts` floors raw). Collapsed the redundant MTD double-query/`?? totalToday` fallback to a single range read. Masthead title is now `{Site} Daily Production Report` (DR3 led the subject + footer — no longer duplicated). Regression tests added (fractional reconciliation, tier-boundary bonus parity, MTD left boundary, pace-edge). Accepted limitation: month-end "pace vs last month" compares against the clamped prior-month window (informational; absolute totals authoritative).
- `src/app/api/internal/bonus/daily-report/test/route.ts` — loopback+bearer-guarded internal **test-send** (`POST { siteCode, to, date? }`); returns a clean 422 for a back-dated day with no active rule. Renders the production-identical email and sends to one address with a `[TEST]` subject prefix; writes **no** log row, so it never blocks the scheduled fire. Lets an operator preview branding/quality from the host without a browser session.

**Daemon:**

- `scripts/bonus-daily-report.mjs` — long-running thin Pacific scheduler, same shape as `bonus-period-close.mjs`. Imports only `@prisma/client` (no `tsx`, no `.ts` import — the prod image is `npm ci --omit=dev` and `tsx` is a devDependency). Reads each enabled config's `send_time_pt`, sleeps until the soonest next-fire across all sites, then POSTs to the loopback+bearer-guarded internal route `/api/internal/bonus/daily-report`, which runs the tested TS runner `src/lib/bonus/daily-report-runner.ts` (`runDailyReportFire`) inside the Next app — mirroring the `bonus-period-close.mjs` → `/api/internal/bonus/close-months` pattern. The runner fires per site within a 60-second wake window (handles two sites configured for the same time). Idempotency via `bonus_daily_report_log` uniqueness; container restart cannot re-send a delivered report.

**Admin UI:**

- `/admin/production-report` route gated on `session.user.is_super_admin`. Per-site card with enable toggle, send time picker, subject template, recipient chips (add/remove), skip rule checkboxes, include flag checkboxes, Save/Send Test/View Recent buttons.
- "Recent sends" table shows last 30 sends across all sites with delivered_count vs attempted, today's total + bonus, and last Graph HTTP status for diagnostics.

**Auth plumbing:** `is_super_admin` propagated through next-auth `jwt` and `session` callbacks; `next-auth.d.ts` extended.

**docker-compose:** New `bonus-daily-report` service alongside the three existing bonus daemons.

**Operator action on first deploy:**

1. `prisma migrate deploy` applies the additive migration.
2. Seed runs (or run `npx prisma db seed`) to populate both configs and the super-admin flag.
3. `docker compose up -d` starts the new daemon.
4. Bill verifies via `/admin/production-report`; first scheduled fire is the next 18:00 PT.

**Tests:** ≥ 32 new vitest cases — aggregation, date math, comparison nulls, config CRUD with audit assertions, notification rendering with conditional sections, route-level super-admin gating (Bill 200, Kelsey 403).

### 2026-06-17 — Fix: EOD bonus alert now fires only when a site has zero entries (ADR-0019 §2)

Bill was being paged whenever **any** active processor lacked a bonus entry by
the 5:00 PM PT cron — but not every processor has a bonus every day (different
position, day off), so the alert false-fired on normal partial days. The check
now pages only when a bonus-enabled site has **zero** entries for the Pacific
day (nobody logged anything). A partial day never pages.

- `src/lib/bonus/eod-check.ts` — `evaluateEod` now alerts iff `enteredCount === 0`;
  the `all_entered` skip reason becomes `has_entries`; `missingCount` →
  `enteredCount`. The pure decision and its tests are the source of truth.
- `scripts/bonus-eod-check.mjs` — `checkSite` fires only when the site has no
  entries; the ntfy title/body now read "No bonus entries for &lt;site&gt;"
  instead of an N-processors-missing count. Fingerprint (`bonus-entry-missing:…`)
  and dedup behaviour unchanged.
- Weekend / holiday / no-active-employees skips and the fire-once-per-day
  fingerprint guarantee are unchanged.

### 2026-06-16 — Feature: amendment notification batching — one notification per root action (ADR-0029)

ADR-0028 modelled each amended line item as its own request, so a manager
correcting N rows in one save fired N approval emails to the approver, N pushes
to Bill, and would need N approve-clicks + N result emails. A real 16-line
correction sent Morena 16 emails. ADR-0029 groups the requests submitted
together and notifies once per root action (applies the ADR-0037 "deduplicate
against root cause" rule).

- **Schema (`prisma/schema.prisma` + `prisma/migrations/20260616_amendment_submission_group/`):**
  adds a nullable `submission_group_id TEXT` column (+ index) to
  `bonus_amendment_requests`. **TEXT, not UUID** — all ids/FKs in this DB are
  TEXT (the UUID/TEXT mismatch is what broke prod in the ADR-0028 migration).
  The migration is additive + idempotent (`ADD COLUMN IF NOT EXISTS` /
  `CREATE INDEX IF NOT EXISTS`), safe against the existing live-test pending row.
- **Batch submit → ONE notification (`src/lib/bonus/amendment-requests.ts`,
  `src/app/api/bonus/amendments/route.ts`):** the submit endpoint now accepts a
  batch body (shared `bonusPayPeriodId` / `targetEntryDate` / `justification` +
  an `items[]` array) as well as the legacy single-item body. `submitAmendmentBatch`
  creates all N rows in one transaction, stamps the shared `submission_group_id`
  (null for N=1), writes a per-row audit row for every item (hard rule #6), and
  fires exactly one `notifyAmendmentBatchSubmitted` (one approver email, one ntfy
  to Bill).
- **Single batch modal (`src/app/bonus/RequestEditBatchModal.tsx`,
  `DailyEntryGrid.tsx`):** the per-item modal **queue** is replaced by one batch
  modal that lists every pending prior-day change, takes one ≥20-char
  justification, shows who it routes to, and POSTs the whole batch in one request.
  `RequestEditModal.tsx` (the per-item modal) is removed.
- **Batch approve/reject → ONE result notification
  (`AmendmentQueue.tsx`, `[id]/approve`, `[id]/reject`):** the queue groups
  pending requests by `submission_group_id` and offers **Approve all** /
  **Reject all** (reject shares one reason, entered inline — no `window.prompt`).
  `approveAmendmentGroup` / `rejectAmendmentGroup` apply every item (each with its
  own entry write + per-item audit, in one transaction) and fire one
  `notifyAmendmentBatchDecided`. All ADR-0028 invariants (four-eyes eligibility,
  requester≠approver, period-still-draft, Patrick carve-out, ping-Bill) hold per
  request. The queue's prior **red** buttons/banner are corrected to DR3
  green/black (hard rule #3).
- **In-app discoverability (`src/app/bonus/page.tsx`):** a "Pending Amendments"
  nav link with a pending-item count, shown only to admins (all-site) and
  managers who are a signature-chain signer at their site (Patrick / non-signers
  never see it).
- **Tests:** batch submit creates N rows + ONE notification + a shared group id;
  N=1 submit is a null-group singleton; batch approve/reject applies all + fires
  ONE result notification; one bad item rolls the batch back; the grid pivots to
  ONE batch modal (not a queue) and POSTs a single `items[]` request.
- **Deployed & verified (2026-06-16, svdp-dev prod):** merged to `main` (PR #28),
  built + deployed; the `migrate` init container applied
  `20260616_amendment_submission_group` (column verified `submission_group_id text
YES`). Typecheck clean, 536/536 tests pass.
  - **Legacy-backlog note (important):** amendment requests created **before** the
    migration carry `submission_group_id = NULL` and — by design — behave as
    singletons, so each fires its own notification. When the first approver cleared
    the ~13-row pre-migration backlog right after rollout it produced one email per
    row. **This is expected, not a regression** — only un-grouped legacy rows do
    it, and the backlog is now drained (0 pending). New multi-line saves get a
    shared group → one email.
  - **Live prod self-test:** a 3-line grouped batch was submitted + approved
    against the production DB (data layer only, no notifications fired), confirming
    one shared `submission_group_id` across all rows and atomic group approval,
    then **fully reverted** with a verified before==after row-count assertion
    across `bonus_amendment_requests` / `bonus_daily_entries` / audit rows (zero
    residue). Confirms one-notification-per-batch holds on real prod data.

### 2026-06-15 — Fix: complete the ADR-0028 amendment client wiring + remove the stale today-only gate

The Sprint 4 amendment workflow (ADR-0028, PR #26) shipped the server side, but
the client glue was missing and a stale gate blocked the feature end-to-end. A
non-admin Woodland manager (Janette) trying to edit a prior day's bonus record
hit `403 "Entries may only be recorded for today"` — the change never reached
the amendment routing.

- **Gate fix (`src/app/api/bonus/entries/route.ts`):** the pre-ADR-0028
  today-only gate (`date !== appToday()` → 403) is replaced with a future-only
  gate. A non-admin may now POST for **today** (direct write) or a **prior day**
  (the data layer routes it through the four-eyes amendment workflow and returns
  `409 requires_amendment`); only a **future** date is rejected `403`. Admins
  keep unconstrained back-dating. The client stays untrusted — all draft/period/
  prior-day scoping is re-enforced in `upsertDailyEntries` →
  `shouldRequireAmendment`; a prior day in a closed period still returns
  `month_locked` (409) and an uncovered day still returns `NoOpenPayPeriodError`
  (409).
- **409 payload carries `approverName`:** the route resolves the counterpart
  signer via the signature chain (`resolveAmendmentApprover`) and looks up the
  user's display name, surfacing it top-level on the `requires_amendment` 409 so
  the modal can show "sent to X for approval". A requester structurally outside
  the workflow (Patrick / non-chain manager) is surfaced as the 403 the
  amendment submit would itself return, rather than dangling an unsubmittable
  modal.
- **Client wiring (`src/app/bonus/DailyEntryGrid.tsx`):** `handleSave` now
  detects the `409 requires_amendment` response and pivots to the previously
  orphaned `RequestEditModal` instead of showing the raw error string. Each
  pending change becomes a modal payload, mapping `bonus_employee_id → full_name`
  from the grid's own rows and old/new values from `pending[i].existing` /
  `.proposed`. Multiple pending changes are handled as a **queue** — one modal at
  a time; submit or cancel advances to the next; the last one drained triggers
  `router.refresh()`. Uses `onClick` (no `<form>`, hard rule #10); brand styling
  preserved.
- **Tests:** route — non-admin prior day → 409 `requires_amendment` with
  `approverName`, non-admin future → 403, admin prior day → direct write; grid —
  a 409 opens the modal with the mapped payload and a multi-pending queue
  advances one modal at a time. Full suite green (830 tests), tsc 0, eslint 0,
  `prisma validate` clean, `next build` succeeds.

This completes ADR-0028's intended flow; no new ADR.

### 2026-06-16 — Fix: amendment-workflow migration used UUID columns against a TEXT-id schema

The Sprint 4 migration `20260616_amendment_workflow` (ADR-0028) declared every
id/FK column as `UUID`, but this database stores all primary keys as `TEXT`
(Prisma `String @default(uuid())` → `text`). On deploy the migration failed at
`bonus_amendment_requests_period_fk` (Postgres 42804: "Key columns
bonus_pay_period_id and id are of incompatible types: uuid and text"), which
(a) blocked the deploy's `migrate deploy` step and (b) left the app container
unable to start. The CI gate (tsc/eslint/vitest/`next build`) never executes the
migration against a real Postgres, so it passed while the migration was broken.
Fix: all id/FK columns in `migration.sql` are now `TEXT` (and the
`gen_random_uuid()` default removed — ids are generated client-side by Prisma,
matching every other table). Recovered on prod by cleaning the partial state +
re-running the corrected migration; the table, both enums, and all existing data
verified intact. The Prisma schema (`String`) was already correct; only the raw
`migration.sql` was wrong.

### 2026-06-16 — Added: prior-day bonus amendment workflow + manager date picker + bi-site EOD check (ADR-0028)

Morena Gomez asked (2026-06-15) what the correct process is to fix a prior day's
bonus entry. There wasn't one. Within a `draft` pay period, a manager could
silently rewrite any prior day; closed periods had no manager path at all. This
sprint defines the answer: a **four-eyes prior-day amendment workflow**.

- **Workflow (Sprint 4):** within the current `draft` period, a non-admin
  manager's change to a prior day's `mattress_count` (an `update`, or an
  `insert` of a missed day) no longer writes directly — it opens a Request Edit
  modal requiring a ≥20-char justification and routes to the signature-chain
  counterpart for approval. Approval applies the entry change, writes the
  entry-audit row (`actor_label='system:amendment-approved'`), marks the request
  `approved`, and links the applied audit id back into the request — all in one
  Prisma transaction. Rejection requires a reason. Bill is notified (ntfy +
  email) on **every** approval and rejection. A requester whose approver is
  unavailable can "Ping Bill" to add the Director as a second eligible approver
  (soft control; the audit log records ping timing for abuse detection).
- **Carve-outs:** same-day corrections, note-only prior-day edits, and admin
  writes stay direct. Patrick Dills (Eugene Lead processor) is excluded from the
  workflow by separation of duties — his prior-day grid is read-only. Closed
  periods stay immutable for managers; Bill keeps the existing audit-labeled
  admin escape valve in `src/lib/bonus/amendment.ts` (unchanged).
- **Concurrency:** a new request from the same requester for the same
  `(target_entry_date, bonus_employee_id)` auto-cancels their prior pending
  request (audit-tracked, `superseded_by_new_request`).
- **Date picker:** the admin-only `AdminDatePicker` is replaced by
  `BonusDatePicker`, visible to all managers and constrained to the current
  draft window (`min=period_start`, `max=today` Pacific); admins remain
  unconstrained. Both the client `min/max` and the server-side `resolveEntryDate`
  enforce the bound. The PR #25 grid date-key remount fix is preserved.
- **Bi-site EOD check:** the 5 PM Pacific missing-entries notification, formerly
  Woodland-only and not wired into the production stack, is now bi-site (iterates
  every site with an active signature chain) and runs as a long-running
  `bonus-eod-check` docker-compose daemon alongside `bonus-period-close` and
  `bonus-escalation-check`. `missingFingerprint(siteCode, dateIso)` and
  `evaluateEod` are now site-scoped so Woodland and Eugene alerts never collide.
- **Migration `20260616_amendment_workflow`** (pure additive): one new table
  (`bonus_amendment_requests`), two enums, five DB-level CHECK constraints
  (requester ≠ approver, justification ≥20, decided rows have a reviewer,
  rejected rows have notes), five indexes.
- New service modules (`amendment-approvers`, `amendment-requests`,
  `amendment-notifications`), five routes
  (`GET/POST /api/bonus/amendments`, `POST .../[id]/(approve|reject|cancel|ping-bill)`),
  three UI components (`BonusDatePicker`, `RequestEditModal`, `AmendmentQueue`)
  and the `/bonus/amendments` queue page. ADR-0028 + operator runbook
  `docs/operator/bonus-amendment-workflow.md` document the design and deploy/verify/rollback.

### 2026-06-15 — Fix: bonus daily-entry grid now repopulates when the admin changes the date

Picking a different business day in the admin date picker left the grid showing
the **previous** day's counts (or blanks) until a manual page reload. Root cause:
`DailyEntryGrid` seeds its input state from `rows` in the `useState` initializer,
which runs once per mount; client-side date navigation (`router.push`) passes new
`rows` but React reuses the same instance, so the seed never re-ran. Fix: a
`key={entryDate}` on the grid in `src/app/bonus/page.tsx` forces a remount on date
change, re-seeding from the new day's rows. Save/`router.refresh()` is unaffected
(same date → same key → no remount, in-progress edits preserved). New
`DailyEntryGrid.test.tsx` (+3) pins the seed-on-mount contract and documents why
the key is required. Suite 762 → 765 green.

### 2026-06-15 — Added: PWA "update available — tap to reload" prompt (ADR-0027)

An installed, always-open PWA never reloads on its own, so after a deploy it
kept serving the **old precached app shell** — whose hashed
`/_next/static/chunks/*.js` references 404 against the new deploy, rendering
blank pages. This once read to the operator as "all my data is gone" (nothing
was lost; the shell was simply stale). DR3-Vision now surfaces an explicit,
user-controlled update prompt so a stale shell can never silently strand anyone.

- **SW change (minimal):** `src/app/sw.ts` flips `skipWaiting: true` →
  `false` so a freshly installed SW parks in the `waiting` state where the page
  can detect it. `clientsClaim` stays `true`; the existing `SKIP_WAITING`
  message handler is retained and now drives the user-initiated promotion. The
  **offline-queue / BackgroundSyncPlugin runtime caching is untouched.**
- **New client component:** `src/app/UpdatePrompt.tsx` watches the SW
  registration (`getRegistration()` + `updatefound`/`statechange`, and checks
  `registration.waiting` on mount), and shows a non-intrusive bottom banner —
  "A new version is available. Reload" — only on a real update (worker
  `installed` **and** a controller already exists), never the first install.
  Tap **Reload** → posts `SKIP_WAITING` to the waiting worker, then reloads
  **once** on `controllerchange` (guarded against reload loops). **Dismiss**
  defers. Never auto-reloads (operators may be mid data-entry). SSR-safe;
  no-ops where service workers are unsupported.
- **Mounted in the root shell** (`src/app/layout.tsx`) so it appears on every
  surface (operator, manager, bonus). The root layout has no `I18nProvider`, so
  the prompt is wrapped in a scoped `I18nProvider` with the operator dictionary
  (smallest correct integration; no collision with route-group providers).
- **i18n:** `update_prompt.{title,body,reload,dismiss}` added to the operator
  namespace in **en/es/ur** (CLAUDE.md #4). Banner uses brand green/cyan on the
  dark space surface (#3) with `onClick` handlers, not `<form>` (#10).
- **Tests:** `src/app/UpdatePrompt.test.tsx` — banner renders the translated
  strings + fires callbacks on tap; the prompt surfaces on a waiting worker,
  posts `SKIP_WAITING`, and reloads exactly once on `controllerchange`.

### 2026-06-15 — Added: Employee # surfaced end-to-end in Manage Employees UI (ADR-0026)

ADR-0026 added the `bonus_employees.employee_number` column + backfill but no UI
or API read or wrote it (`grep employee_number src/` returned nothing). The
"Manage Employees" screen (`/bonus/employees`) now **shows and manages** the
field — closing the gap ADR-0026 flagged ("no UI consumes it yet" + "a future
write path must add the app-level per-site uniqueness check").

- **Display:** each employee row shows `Employee #: <number>` or an italic
  "No Employee #" empty state (most rows have none — only the 21 legacy Woodland
  imports carry one).
- **Create:** the Add-employee row gains an optional "Employee # (optional)"
  input alongside the name.
- **Edit:** a per-row "Edit #" inline editor sets or clears the number
  (clearing = empty input → stored `null`). Uses `onClick` handlers, no `<form>`
  (CLAUDE.md #10).
- **Validation:** `employee_number` stays a `String?`; when present it must match
  `^[0-9]{4}$` (the live prod data format — all 21 rows are exactly 4 digits).
  Per-site uniqueness is enforced at the **app layer** among **active** rows
  (`deleted_at IS NULL`, mirroring the §9a rehire freeing) — no DB constraint,
  per ADR-0026. Duplicate → 409; bad format → 422; both surface inline.
- **Audit:** the new `set_number` PATCH action writes an `update` audit row with
  before/after DTO snapshots in the same transaction, exactly like the §9b
  rename path. The append-only audit log is never mutated destructively
  (CLAUDE.md #6).
- **i18n:** the bonus surface had no `I18nProvider` and shipped English-only
  hardcoded strings. Wired the manager-namespace dictionary into the `/bonus`
  layout (mirroring `/dashboard`) and added a `bonus_employees` namespace to
  `en` / `es` / `ur` (RTL) `manager.json`; the Manage Employees page + component
  are now fully translated (CLAUDE.md #4). Brand stays DR3 green/cyan dark
  surface — no red/navy/gold introduced (#3).

Files: `src/lib/bonus/employees.ts` (DTO + `setEmployeeNumber` +
`normalizeEmployeeNumber` + `findByEmployeeNumber`), the two
`api/bonus/employees` routes, `app/bonus/employees/{page,EmployeeManager}.tsx`,
`app/bonus/layout.tsx`, the three `manager.json` locales, and the two test
files (+21 new cases; `npm test` 755 green, `tsc`/ESLint/`prisma validate`
clean).

### 2026-06-15 — Added: `employee_number` on bonus processors (ADR-0026)

New nullable `bonus_employees.employee_number` column + `(site_id,
employee_number)` index. Migration `20260615_bonus_employee_number` backfills the
21 legacy DR3 Woodland rows whose display name carried a trailing 4-digit employee
number, strips the number out of `full_name`, and records the original name in
`previous_names` (`reason: employee_number_extracted`). Idempotent;
behavior-neutral (no UI consumes the column yet). Per-site uniqueness enforced at
the app layer, not the DB. **Deployed and verified live on prod 2026-06-15** —
migration `20260615_bonus_employee_number` applied at 18:05 UTC (11:05 AM PDT) via
the auto-deploy `migrate deploy` step; post-deploy verification on the live DB:
21/107 rows extracted, 0 names still numbered, 21 distinct numbers, 0 bad formats
(one soft-deleted row included, by design).

### 2026-06-11 — Fix: manager bonus UI shows the SITE's signers (no hardcoded Woodland names)

The manager-facing bonus UI hardcoded the WOODLAND signature-chain names, so a
**Eugene** pay period rendered **Janette Tomas / Morena Gomez** (the Woodland
facility/ops signers) instead of Eugene's **Rick Albritton / Kelsey Ruhland**.
Kelsey — reaching Eugene via the ADR-0024 `all_sites` flag — opened a Eugene
report and saw the wrong signers. Ground truth (who signs which slot at which
site) lives in the `bonus_signature_chains` data; the data layer was already
site-scoped everywhere, and the **bonus-pdf page already resolved names from the
chain correctly** — only these three presentation surfaces
