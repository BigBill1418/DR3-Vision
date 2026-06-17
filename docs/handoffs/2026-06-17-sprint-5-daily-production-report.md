# Sprint 5 Handoff — Daily Production Report (REVISED)

**Status:** Ready for build
**Branch:** `sprint-5-daily-production-report`
**ADR:** ADR-0030 (to be created — content in §3)
**Author:** Bill Barnard, Director of Operations
**Date:** 2026-06-17
**Supersedes:** any prior "Sprint 5 — Woodland Daily Processing Email" draft. Do NOT reference earlier drafts; the scope, schema, and admin model are all different.

---

## §0 — Instructions to the implementing agent (Claude Code)

You are executing Sprint 5 of DR3-Vision. This document is the only input. Every file path, every code block, every acceptance criterion is here. Do the following in order:

1. Cut `sprint-5-daily-production-report` from `main`.
2. Create every file in §2 and apply every patch verbatim. Mirror existing repo conventions (`bonus-eod-check.mjs` daemon shape, `sendSystemEmail` from `@/lib/m365-mail`, `calculateDailyBonusCents` from `@/lib/bonus/calculator`, `resolveActiveRule` from `@/lib/bonus/daily-entry`, `requireBonusAccess` and `tryBonusAccess` from `@/lib/bonus/access`, `publishNtfy` from `@/lib/ntfy`, `writeAudit` from `@/lib/audit`).
3. Run `npx prisma generate` after the schema patch lands.
4. Implement the test files in §10 to the case-list level.
5. Run the full gate:
   - `npx tsc --noEmit` exits 0
   - `npx eslint . --max-warnings 0` clean
   - `npx vitest run` green; suite grew by ≥ 32 cases
   - `npx next build` succeeds
6. Open a PR titled **"Sprint 5: daily production report (ADR-0030)"** with the description in §11.
7. **Do not deploy.** Bill merges manually.

### Non-negotiables

- **"Production report," not "bonus report."** Site managers enter daily mattress counts regardless of whether anyone hit the bonus threshold — the data is fundamentally a production volume record. Bonus dollars are a derived view inside the email. Name files, tables, routes, and prose accordingly: `bonus_daily_report_*` for tables (consistent with existing `bonus_*` namespace), but copy and ADR title use "production report."
- **Both sites, fully configurable.** Woodland AND Eugene each get their own config row, recipient list, send time, subject template, and skip-rules. The daemon iterates `bonus_daily_report_config` rows where `enabled = true`. No hard-coded site code anywhere in `daily-report.ts` or `daily-report-notifications.ts`.
- **Bill-only admin tile.** The new admin route `/admin/production-report/` is gated on a new `is_super_admin` boolean on the `User` table. Bill = true. Kelsey (currently admin via `role = admin`) = false. Any future "super admin" promotion is a seed/manual UPDATE, not a UI affordance.
- **Trigger = "any day with data," not calendar-driven.** The daemon fires at the configured time on every Pacific calendar day. If `total_today === 0`, it skips silently (the 17:00 EOD daemon already pages Bill on a zero-entry day; no need for redundant noise). The "skip weekends" and "skip site holidays" toggles default OFF — Bill's direction was that production sometimes happens Saturday and the report should reflect that.
- **Idempotency.** `bonus_daily_report_log` keyed on `(site_id, report_date)` prevents double-send under daemon restart.
- **CLAUDE.md hard rules apply:** site-scope every query; every config mutation has its audit row in the same transaction; M365 fail-soft (unconfigured → log + skip, never throw).
- **Eugene comparisons degrade gracefully.** Same-day-last-year and prior-month same-period both render as `no previous data available` when the referenced window has zero entries. Auto-populates the first time the historical window contains data.

---

## §1 — Context and decision summary

### What this replaces

Today, Morena Gomez (Woodland Operations Manager) hand-types a daily processing report at ~6 PM Pacific and emails it to Bill + Bethany. Reference email (Jun 16, 2026, Woodland):

```
Hi Bill and Bethany,
Please see today's processing numbers for Woodland.
Jeremy – 79
…
Total Processed Today: 901 units
The last month total reported was 9,252 units. Adding today's production:
Month-to-Date Total: 10,153 units
```

### What Bill asked for

Replace the manual process with automation, configurable from a Vision admin tile.

1. **Both sites** — Woodland AND Eugene each get their own daily report.
2. **Per-site configurability** — recipients, send time, subject, skip rules. All editable through a Vision admin tile.
3. **Bill-only access on the config tile.** Kelsey (also admin) cannot see or edit the config.
4. **Email header** reads "DR3 - {Site} Automated Production Report" — replaces the "Hi Bill and Bethany" greeting.
5. **Per-employee bonus dollars** displayed next to the count, and a **total bonus dollars paid for the day** at the bottom of the table.
6. **Comparisons** — same day last year, MTD, prior month same period, percentage delta vs prior month. Eugene renders `no previous data available` until enough history exists.
7. **Trigger** — any day with at least one entry. No calendar gates by default.

### Recipients (initial seed)

**Woodland:**
- `bill.barnard@svdp.us`
- `bethany.cartledge@svdp.us`

**Eugene:**
- `shannon.rockwell@svdp.us`
- `bill.barnard@svdp.us`
- `bethany.cartledge@svdp.us`
- `rick.albritton@svdp.us`

Both sites seed with **send time 18:00 Pacific**, **skip-if-zero ON**, **skip-weekends OFF**, **skip-holidays OFF**.

---

## §2 — File manifest

### New files

1. `docs/adr/0030-daily-production-report.md` (§3)
2. `prisma/migrations/20260617_daily_production_report/migration.sql` (§4)
3. `src/lib/bonus/daily-report.ts` (§6)
4. `src/lib/bonus/daily-report-config.ts` (§6.5)
5. `src/lib/bonus/daily-report-notifications.ts` (§7)
6. `src/lib/bonus/__tests__/daily-report.test.ts` (§10.1)
7. `src/lib/bonus/__tests__/daily-report-config.test.ts` (§10.2)
8. `src/lib/bonus/__tests__/daily-report-notifications.test.ts` (§10.3)
9. `scripts/bonus-daily-report.mjs` (§8)
10. `src/app/admin/production-report/page.tsx` (§9.1)
11. `src/app/admin/production-report/SiteConfigCard.tsx` (§9.2)
12. `src/app/admin/production-report/RecentSends.tsx` (§9.3)
13. `src/app/api/admin/production-report/config/route.ts` (§9.4)
14. `src/app/api/admin/production-report/config/[siteId]/route.ts` (§9.5)
15. `src/app/api/admin/production-report/config/[siteId]/recipients/route.ts` (§9.6)
16. `src/app/api/admin/production-report/config/[siteId]/test-send/route.ts` (§9.7)
17. `src/app/api/admin/production-report/__tests__/routes.test.ts` (§10.4)
18. `docs/operator/daily-production-report.md` (§12)

### Modified files

19. `prisma/schema.prisma` (§5) — adds `BonusDailyReportConfig`, `BonusDailyReportRecipient`, `BonusDailyReportLog`; adds `is_super_admin` boolean on `User`
20. `prisma/seed/users.csv` (§5.4) — Bill flagged `is_super_admin = true`
21. `prisma/seed/bonus_daily_report.sql` (§5.5) — seeds both sites' configs + initial recipients
22. `docker-compose.yml` — adds `bonus-daily-report` service (§9.8)
23. `src/lib/dashboard-tiles.ts` — adds the "Production Report" admin tile entry (§9.9)
24. `CHANGELOG.md` — entry at top of Unreleased (§13)
25. `src/lib/auth.ts` and/or auth types — propagate `is_super_admin` onto the session (see §5.3)

### Files NOT touched

- `src/lib/bonus/aggregates.ts` — patterns mirrored but no edits
- `src/lib/bonus/eod-check.ts`, `scripts/bonus-eod-check.mjs` — unrelated
- `src/lib/bonus/amendment.ts`, `amendment-requests.ts` — unrelated
- Any non-admin UI

---

## §3 — `docs/adr/0030-daily-production-report.md`

(See the full file content at /mnt/user-data/outputs/sprint-5-revised-handoff.md §3 — ADR-0030 covering context, decision, email content spec, trigger discipline, per-site configurability with schema layouts, admin tile gating with the `is_super_admin` rationale, notifications semantics, and consequences.)

---

## §4 — Migration SQL

**File:** `prisma/migrations/20260617_daily_production_report/migration.sql`

Three tables and one column:

- `ALTER TABLE users ADD COLUMN is_super_admin BOOLEAN NOT NULL DEFAULT false`
- `bonus_daily_report_config` — UUID PK, FK to sites (UNIQUE), enabled bool, send_time_pt TIME default '18:00:00', subject_template TEXT default '[DR3-Vision] {site} processing — {date}', skip_if_zero bool default true, skip_weekends/skip_holidays bools default false, include_bonus_dollars/include_comparisons bools default true, created_at/updated_at timestamps. ON DELETE RESTRICT on sites FK.
- `bonus_daily_report_recipients` — UUID PK, FK to bonus_daily_report_config (CASCADE on config delete), email TEXT, added_by_user_id UUID FK to users (SET NULL on user delete), added_at timestamp. UNIQUE(config_id, email). Index on config_id.
- `bonus_daily_report_log` — UUID PK, FK to sites (RESTRICT), report_date DATE, sent_at timestamp, recipient_count int, total_today int, total_bonus_cents int, mtd_total int, delivered_count int, graph_message_id TEXT nullable, last_status int nullable, created_at timestamp. UNIQUE(site_id, report_date). Index on sent_at DESC.

Full SQL is in the local file at /mnt/user-data/outputs/sprint-5-revised-handoff.md §4 — copy verbatim.

---

## §5 — Prisma schema additions

### §5.1 — New models

`BonusDailyReportConfig` (1:1 with Site, unique site_id), `BonusDailyReportRecipient` (N:1 with config, CASCADE delete, named relation `BonusDailyReportRecipientAdder` to User on `added_by_user_id`), `BonusDailyReportLog` (N:1 with Site, unique on (site_id, report_date), descending index on sent_at). `send_time_pt` is `DateTime @db.Time`. Full models in §5.1 of the local file.

### §5.2 — `User` model additions

```prisma
  is_super_admin Boolean @default(false)

  bonus_daily_report_recipients_added BonusDailyReportRecipient[] @relation("BonusDailyReportRecipientAdder")
```

### §5.3 — `Site` model additions

```prisma
  bonus_daily_report_config BonusDailyReportConfig?
  bonus_daily_report_logs   BonusDailyReportLog[]
```

### §5.4 — Auth session propagation

`is_super_admin` must surface on the session. Patch `src/lib/auth.ts`:

1. In the `jwt` callback, when a user is loaded, copy `user.is_super_admin` onto the token.
2. In the `session` callback, copy `token.is_super_admin` onto `session.user`.
3. Extend the `next-auth.d.ts` declaration module to add `is_super_admin: boolean` to `User` and `Session.user`.

Mirror the existing pattern used for `role`, `primary_site_id`, and `all_sites` exactly.

### §5.5 — Seed

Mark Bill super-admin in `prisma/seed/users.csv` — set `is_super_admin = true` only for `bill.barnard@svdp.us`. Add a new seed file `prisma/seed/bonus_daily_report.sql` that creates both configs (Woodland + Eugene, both enabled at 18:00 PT) and their recipient lists, idempotent via `ON CONFLICT`. Full SQL block in §5.5 of the local file.

Woodland recipients: bill.barnard@svdp.us, bethany.cartledge@svdp.us
Eugene recipients: shannon.rockwell@svdp.us, bill.barnard@svdp.us, bethany.cartledge@svdp.us, rick.albritton@svdp.us

If the project's seed runner is JS/TS rather than SQL, translate the SQL to equivalent Prisma client calls — semantic is what matters.

---

## §6 — `src/lib/bonus/daily-report.ts`

Pure aggregation logic. No side effects.

**Public surface:**
- `interface ProcessorLine { employeeId, fullName, mattresses, bonusCents, enteredAt }`
- `interface ComparisonTotal { startDate, endDate, total: number | null }` — null when zero entries in the window
- `interface DailyReport { siteId, siteCode, siteName, reportDate, lines, totalToday, totalBonusCents, sameDayLastYear, mtd, priorMonthSamePeriod, paceDeltaPct: number | null }`
- `sameDayPriorYear(d)` — clamps Feb 29 → Feb 28 in non-leap years
- `firstOfMonth(d)`, `firstOfPriorMonth(d)` — handles year boundary
- `sameDomPriorMonth(d)` — clamps short-month overflow (Mar 31 → Feb 28/29)
- `buildDailyReport(siteId, reportDate): Promise<DailyReport>`

**Bonus calc:** `calculateDailyBonusCents(mattresses, rule)` against the site's effective `processor_bonus_rules` row resolved by `resolveActiveRule(siteId, reportDate)`.

**Sort:** lines sorted by mattresses desc, ties broken by enteredAt asc.

**Pace delta:** rounded to one decimal: `Math.round(((mtd / prior) - 1) * 1000) / 10`. null when prior is null or 0.

**Site-scoped queries throughout.** Full TS source in §6 of the local file (~120 lines).

---

## §6.5 — `src/lib/bonus/daily-report-config.ts`

Config + recipients CRUD service. Audit in same transaction.

**Public surface:**
- `class DailyReportConfigError extends Error { reason, status }` — reasons: `not_found | invalid_time | invalid_email | duplicate_email`
- `listConfigs()` — both sites, with recipients and added_by info
- `getConfigBySite(siteId)`
- `patchConfig(configId, patch, actor)` — accepts `enabled? | sendTimePt? | subjectTemplate? | skipIfZero? | skipWeekends? | skipHolidays? | includeBonusDollars? | includeComparisons?`. Writes audit row with before/after snapshots in same `$transaction`. Validates time with `/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/`.
- `addRecipient(configId, email, actor)` — lowercases email, validates with `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, throws `duplicate_email` (409) on conflict. Audit row.
- `removeRecipient(recipientId, actor)` — audit with `before` snapshot.
- `listRecentSends(siteId | null, limit=30)` — desc by sent_at.

All callers must already have passed the super-admin gate. Full TS source in §6.5 of the local file.

---

## §7 — `src/lib/bonus/daily-report-notifications.ts`

Render + send. Never throws.

**Public surface:**
- `renderSubject(report, template)` — substitutes `{site}` and `{date}` (Mon DD, YYYY)
- `renderHtmlBody(report, { includeBonusDollars, includeComparisons })` — header is `DR3 - {Site Name} Automated Production Report` (h2, 18px, weight 500); subtitle is the long-form date; table with Processor/Units (and Bonus when `includeBonusDollars`); footer with Total Processed Today + Total Bonus Paid Today; comparison block with same-day-last-year, MTD, prior-month-same-period, pace delta (green up ▲ #3B6D11, red down ▼ #A32D2D); null comparisons render as `<em>no previous data available</em>`.
- `sendDailyReport({ report, recipients, subjectTemplate, includeBonusDollars, includeComparisons })` — per-recipient `sendSystemEmail`. Failures on one recipient do NOT block the rest. Returns `{ attempted, delivered_count, graph_message_id, last_status }`. Catches all errors, never re-throws. M365 disabled → returns 0 delivered, logs at warn.

Full TS source in §7 of the local file.

---

## §8 — `scripts/bonus-daily-report.mjs`

Long-running daemon. Same shape as `bonus-eod-check.mjs`.

**Behavior:**
- Loads all `bonus_daily_report_config` rows where `enabled = true`.
- If zero enabled configs, sleep 5 minutes then re-check.
- Otherwise compute next fire instant per site (`nextFireInstantAt(now, hour, minute)` — DST-safe via `Intl.DateTimeFormat` with `timeZone: 'America/Los_Angeles'`).
- Sleep until soonest fire across all sites.
- Fire every config whose fire instant is within 60s of wake-time (handles two sites at same time).
- Per site, in `fireSite()`:
  1. Determine Pacific calendar day.
  2. If `skip_weekends && isWeekend` → skip.
  3. If `skip_holidays` → check `site_holidays` table; skip if present.
  4. Check `bonus_daily_report_log` for `(site_id, report_date)`; skip if already logged.
  5. `buildDailyReport(site_id, dayKey)`.
  6. If `skip_if_zero && totalToday === 0` → skip.
  7. If `recipients.length === 0` → skip.
  8. `sendDailyReport(...)` with the config's recipients + subject_template + include flags.
  9. `bonusDailyReportLog.create(...)` with results.
- All per-iteration errors caught and logged; the loop keeps running.

**Module import path:** Check `scripts/bonus-period-close.mjs` and `scripts/bonus-escalation-check.mjs` for the canonical `.mjs` → `.ts` pattern used in this repo. Mirror that exactly. If they use compiled dist, follow suit. Worst case: inline the aggregation logic into the `.mjs`.

Full JS source in §8 of the local file.

---

## §9 — Admin UI + routes

### §9.1 — `src/app/admin/production-report/page.tsx`

Server component. `dynamic = 'force-dynamic'`. Auth check: if no session, redirect to `/login?next=/admin/production-report`. If session exists but `!is_super_admin`, render an "Access denied" page with a link back to home (do NOT redirect; we want Kelsey to see the explicit denial, not get bounced silently).

If super-admin: render `<SiteConfigCard>` for each config from `listConfigs()`, then a `<RecentSends>` table from `listRecentSends(null, 30)`.

### §9.2 — `src/app/admin/production-report/SiteConfigCard.tsx`

Client component. Per-site card UI with enable toggle, send time picker, recipient chips (add/remove), subject template input, skip rule checkboxes, include flag checkboxes, Save/Send Test/View Recent buttons. No `<form>` tags (CLAUDE.md hard rule #7) — use `onClick`/`onChange`. Match `AmendmentQueue.tsx` styling. Inline success/error toasts.

Wires: Save → `PATCH /api/admin/production-report/config/[siteId]`; Add → `POST .../recipients`; Remove → `DELETE .../recipients?id=…`; Test → `POST .../test-send`.

### §9.3 — `src/app/admin/production-report/RecentSends.tsx`

Table of `BonusDailyReportLog` rows: site code, report_date, sent_at, `delivered_count`/`recipient_count` with ✓ or ⚠, total_today, formatted total_bonus_cents, last_status. Newest first, max 30.

### §9.4 — `GET /api/admin/production-report/config`

Returns `{ configs }` from `listConfigs()`. Super-admin gate.

### §9.5 — `PATCH /api/admin/production-report/config/[siteId]`

Body: optional `enabled | sendTimePt | subjectTemplate | skipIfZero | skipWeekends | skipHolidays | includeBonusDollars | includeComparisons` (Zod). Resolves config by siteId, calls `patchConfig`. Returns 422 on invalid body, 404 on missing site, 422 on invalid_time, 200 on success.

### §9.6 — `POST/DELETE /api/admin/production-report/config/[siteId]/recipients`

POST: body `{ email }`. Resolves config, calls `addRecipient`. 201 on success, 409 on duplicate, 422 on invalid email.

DELETE: `?id=…` query. Calls `removeRecipient`. 200 on success, 404 on missing.

### §9.7 — `POST /api/admin/production-report/config/[siteId]/test-send`

Builds report for `appToday()`, sends ONLY to `session.user.email` with subject prefixed `[TEST] `. Does NOT write a `bonus_daily_report_log` row — test sends must not block the scheduled production send.

### §9.8 — `docker-compose.yml`

Add a `bonus-daily-report` service alongside the existing bonus daemons. Image: `dr3-vision-app:local`. Container: `dr3-vision-bonus-daily-report`. Command: `['node', '--import', 'tsx', 'scripts/bonus-daily-report.mjs']` (or whatever pattern the existing `.mjs` daemons use). Same env_files, network, labels, logging as other bonus daemons. `restart: unless-stopped`. `depends_on` app `service_healthy`.

### §9.9 — Dashboard tile

Add an entry in `src/lib/dashboard-tiles.ts` (or wherever tiles are registered). Title: "Production Report". Subtitle: "Daily email automation config". Href: `/admin/production-report`. Visibility: only when `session.user.is_super_admin === true`.

Full TSX/TS source for each route in §9 of the local file.

---

## §10 — Tests

### §10.1 — `daily-report.test.ts` (≥ 12 cases)

- `sameDayPriorYear` — Feb 29 leap clamp; ordinary case
- `firstOfMonth`, `firstOfPriorMonth` (year boundary), `sameDomPriorMonth` (short-month + leap clamp)
- `buildDailyReport` happy path — 3 employees, sorted desc, ties broken by `entered_at`
- `buildDailyReport` per-line bonus matches `calculateDailyBonusCents` for the resolved rule
- `buildDailyReport` total_bonus_cents = sum of line bonuses
- `buildDailyReport` Eugene-style empty history — sameDayLastYear.total === null, paceDeltaPct === null
- `buildDailyReport` MTD when today is the only day with data → mtd.total === totalToday
- `buildDailyReport` paceDeltaPct rounded to one decimal (positive + negative cases)

### §10.2 — `daily-report-config.test.ts` (≥ 10 cases)

- `patchConfig` happy path — enabled toggle, send_time, audit row written with before/after
- `patchConfig` invalid time → 422
- `patchConfig` not found → 404
- `addRecipient` happy path — audit row written, email lowercased
- `addRecipient` invalid email → 422
- `addRecipient` duplicate → 409
- `removeRecipient` happy path — audit row written with `before` snapshot
- `removeRecipient` not found → 404
- `listRecentSends` ordering desc by sent_at
- `listRecentSends` siteId filter narrows correctly

### §10.3 — `daily-report-notifications.test.ts` (≥ 7 cases)

- `renderSubject` substitutes {site} and {date}
- `renderHtmlBody` includes "DR3 - Woodland Automated Production Report" header
- `renderHtmlBody` shows bonus column when `includeBonusDollars: true`, hides it when false
- `renderHtmlBody` shows comparison block when `includeComparisons: true`, omits when false
- `renderHtmlBody` renders "no previous data available" when a comparison total is null
- `sendDailyReport` per-recipient; partial failure → delivered_count < attempted, no throw
- `sendDailyReport` M365 disabled → delivered_count = 0, no throw

### §10.4 — `routes.test.ts` (≥ 8 cases)

- `PATCH /config/[siteId]` as Bill (is_super_admin=true) → 200
- `PATCH /config/[siteId]` as Kelsey (admin but is_super_admin=false) → 403
- `PATCH /config/[siteId]` as non-admin manager → 403
- `PATCH /config/[siteId]` unauthenticated → 401 (or whatever auth.ts returns for null session)
- `POST /config/[siteId]/recipients` happy path → 201 + audit row
- `POST /config/[siteId]/recipients` duplicate email → 409
- `DELETE /config/[siteId]/recipients?id=…` happy path → 200 + audit row
- `POST /config/[siteId]/test-send` happy path — sends to caller's email only, no `bonus_daily_report_log` row created

---

## §11 — PR description

```markdown
# Sprint 5: daily production report (ADR-0030)

Replaces Morena Gomez's manual 6 PM Pacific daily processing email and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile.

## Configuration

- Per-site config table (`bonus_daily_report_config`) with enable toggle, send time, subject template, skip rules, include flags.
- Per-site recipient child table (`bonus_daily_report_recipients`) with full audit trail on add/remove.
- Per-day idempotency log (`bonus_daily_report_log`) preventing double-send under daemon restart.

## Seed

- Woodland enabled at 18:00 PT — recipients: bill, bethany.
- Eugene enabled at 18:00 PT — recipients: shannon, bill, bethany, rick.

## Admin gate

- New `users.is_super_admin` boolean. Bill = true; Kelsey (currently admin via role) = false.
- New `/admin/production-report/` route + API routes — all gated on `session.user.is_super_admin`.
- New `is_super_admin` plumbed through next-auth `jwt` + `session` callbacks.

## Daemon

- `scripts/bonus-daily-report.mjs` — long-running, iterates every enabled config, sleeps until the soonest next-fire across all sites, fires per site.
- Skip-if-zero default ON (avoids overlap with the 17:00 EOD zero-entry page).
- Skip weekends / skip holidays default OFF (Bill: "any day with data").

## Email

- Header: `DR3 - {Site} Automated Production Report`.
- Per-employee Units + Bonus dollars (via `calculateDailyBonusCents`); total processed today + total bonus paid today.
- Comparison block: same day last year, MTD, prior month same period, percentage delta.
- Eugene comparisons render `no previous data available` until history fills in; auto-populate when data exists.

## Acceptance gates

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npx eslint . --max-warnings 0` clean
- [ ] `npx vitest run` green; suite grew by ≥ 32 cases
- [ ] `npx next build` succeeds
- [ ] Migration applies cleanly against a throwaway Postgres 16
- [ ] Manual smoke (local): seed runs, both configs present with seeded recipients, daemon logs `daemon starting` and sleeps until 18:00 PT
- [ ] As Bill: navigate to `/admin/production-report`, see both site cards, edit Woodland's send time → save → audit row appears
- [ ] As Kelsey: `/admin/production-report` → forbidden
```

---

## §12 — Operator runbook

**File:** `docs/operator/daily-production-report.md`

Covers: what changed; deploy steps; six verification queries (migration applied, configs seeded, recipients seeded, Bill flagged super-admin, daemon alive, admin tile accessible); test-fire path via admin tile (no log row written); force re-send via `DELETE FROM bonus_daily_report_log` + container restart; recipient management; rollback (additive migration — tables can stay, or DROP cleanly); known limitations (Patrick shows in Eugene email like any other processor; Eugene comparisons start empty; daemon does not retry M365 failures; pace comparison clamps prior-month end date on short-month transitions).

Full runbook in §12 of the local file.

---

## §13 — CHANGELOG.md entry

Insert at the very top of `## Unreleased`:

```markdown
### 2026-06-17 — Sprint 5: daily production report (ADR-0030)

**Headline.** Replaces Morena Gomez's manual 6 PM Pacific daily processing email for Woodland and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile (`/admin/production-report`). Recipients, send time, subject template, and skip rules are all editable through the UI; every config change is audit-tracked. Email body includes per-employee mattress count + bonus dollars + total processed + total bonus paid + four comparison lines (same day last year, MTD, prior month same period, percentage delta).

**Migration `20260617_daily_production_report`:** three new tables — `bonus_daily_report_config` (per-site, unique on site_id), `bonus_daily_report_recipients` (child table, unique on (config_id, email)), `bonus_daily_report_log` (per-day idempotency, unique on (site_id, report_date)). Plus a new `is_super_admin` boolean column on `users`, defaulting false, with the seed flipping Bill to true.

**Seed:** Both sites enabled at 18:00 Pacific. Woodland recipients: bill, bethany. Eugene recipients: shannon, bill, bethany, rick.

**Service layer:** `src/lib/bonus/daily-report.ts` (pure aggregation), `daily-report-config.ts` (CRUD with in-transaction audit), `daily-report-notifications.ts` (rendering + per-recipient sendSystemEmail).

**Daemon:** `scripts/bonus-daily-report.mjs` — long-running, iterates enabled configs, sleeps until soonest next-fire across sites, fires per site within a 60s wake window, idempotent via log uniqueness.

**Admin UI:** `/admin/production-report` route gated on `session.user.is_super_admin`. Per-site card with all configurable fields. "Recent sends" table for diagnostics.

**Auth plumbing:** `is_super_admin` propagated through next-auth `jwt` + `session` callbacks; `next-auth.d.ts` extended.

**docker-compose:** new `bonus-daily-report` service.

**Tests:** ≥ 32 new vitest cases — aggregation, date math, comparison nulls, config CRUD with audit assertions, notification rendering with conditional sections, route-level super-admin gating (Bill 200, Kelsey 403).
```

---

## §14 — Closing instructions for Claude Code

1. **Work strictly from this document.** Mirror existing repo conventions (`bonus-eod-check.mjs` daemon shape, `aggregates.ts` rule-resolver pattern, `m365-mail.ts` send semantics, `amendment-requests.ts` audit-in-transaction pattern, `access.ts` session-shape conventions).
2. **Both sites, no hard-codes.** Daemon iterates `bonus_daily_report_config WHERE enabled = true`. Notifications module reads recipients from the row, not from a constant.
3. **Bill-only on the admin tile.** The check is `session.user.is_super_admin === true`. Kelsey passes the existing `requireBonusAccess` admin gate but must fail this one (test §10.4 case 2).
4. **Idempotency is non-negotiable.** Pre-send `findUnique` on `bonus_daily_report_log` is the gate. Test sends do NOT write a log row.
5. **Audit-in-transaction.** Every config and recipient mutation writes its `audit_log` row in the same `prisma.$transaction` as the table mutation.
6. **Comparison nulls render gracefully.** Eugene's first many fires will have multiple null comparison lines; the rendered email must read clean ("no previous data available"), not crash or show NaN.
7. **`.mjs` ↔ `.ts` import pattern.** Check `scripts/bonus-period-close.mjs` and `scripts/bonus-escalation-check.mjs` for the canonical pattern. If they don't use `--import tsx`, mirror what they do (might be compiled dist, might be inlined). Worst case: inline the aggregation logic into the `.mjs`.
8. **Auth session shape.** Extending `session.user` with `is_super_admin` requires updates to `next-auth.d.ts` (or wherever the existing `role` / `primary_site_id` / `all_sites` augmentations live). Mirror the existing pattern exactly.
9. **Seed runner shape.** If the project uses JS/TS seed (`prisma/seed.ts` or similar) rather than the SQL block in §5.5, translate the SQL to the equivalent Prisma client calls. The semantic is what matters: both configs present, both enabled, both with seeded recipients, idempotent on re-run, Bill flagged super-admin.

When the PR is open with all gates green, post a short summary comment with: (a) migration file path, (b) ADR file path, (c) operator runbook path, (d) suite size delta. That's Bill's signal to merge.

End of handoff.

---

**NOTE TO CLAUDE CODE:** This is the abbreviated handoff (per ClaudeSync payload limit). The full handoff with all complete code blocks for §3, §4, §6, §6.5, §7, §8, §9, and §12 is at `/mnt/user-data/outputs/sprint-5-revised-handoff.md` in Bill's working copy. Bill will paste it into the repo working tree before queueing you. If for any reason you receive only this abbreviated version, the §-references above are sufficient to implement correctly given the existing repo conventions; if you have any doubt on a specific code block, ask Bill for the full source rather than guessing.
