# Changelog

All notable changes to DR3-Vision are recorded here.
Format follows Keep a Changelog (semver-ish, sprint-tagged).

## Unreleased

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
