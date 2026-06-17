> **THIS IS PART 1 OF 2.** The full handoff is split across two PRs to stay under GitHub's 65k PR-body cap.
>
> - **Part 1 (this file):** §0 instructions, §1 context, §2 file manifest, §3 ADR-0030 in full, §4 migration SQL in full, §5 Prisma schema additions in full, §6 `daily-report.ts` full source, §6.5 `daily-report-config.ts` full source, §7 `daily-report-notifications.ts` full source.
> - **Part 2:** `docs/handoffs/2026-06-17-sprint-5-daily-production-report-part-2.md` — §8 daemon, §9 admin UI + API routes, §10 tests, §11 PR description, §12 operator runbook, §13 CHANGELOG entry, §14 closing instructions for Claude Code.
>
> Claude Code: read this file first, then the part-2 file, then execute end-to-end per §0.

---

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

```markdown
# ADR-0030 — Daily production report automation

**Status:** Accepted (Sprint 5, 2026-06-17)
**Related:** ADR-0019 (Bonus Management System), ADR-0019.1 (bi-weekly cadence),
ADR-0019.2 (Eugene enablement), ADR-0021 (M365 Graph mail-send),
ADR-0023 (historical data import), ADR-0024 (all-sites manager).

## Context

Two manual reports flow out of Operations every day:
- Morena Gomez (Woodland Operations Manager) emails Bill + Bethany at ~6 PM
  Pacific with the day's Woodland processing numbers.
- Eugene has no equivalent today, but Bill wants the same automation for
  Eugene effective immediately upon launch.

The data Morena types by hand is the same data DR3-Vision already captures
in `bonus_daily_entries` — every active processor's mattress count for the
day, keyed by the site manager. Site managers enter this regardless of
whether any processor hit the bonus threshold (the bonus is a derived
view; the underlying data is production volume).

## Decision

A new long-running daemon (`scripts/bonus-daily-report.mjs`) sleeps until
the next configured fire instant per site, iterates every site whose
`bonus_daily_report_config.enabled = true`, and for each site:

1. Resolves the Pacific calendar day for the fire instant.
2. Optionally skips weekends if `skip_weekends = true` (default OFF).
3. Optionally skips site holidays if `skip_holidays = true` (default OFF).
4. Skips when zero entries exist for the day (default ON; the 17:00 EOD
   daemon already pages Bill in that case).
5. Skips when `bonus_daily_report_log` already has a row for
   `(site_id, report_date)` — idempotency under daemon restart.
6. Otherwise: aggregates today's per-employee mattress counts and bonus
   dollars (via `calculateDailyBonusCents` against the site's effective
   `processor_bonus_rules`), computes the four comparison totals, renders
   the HTML email, sends via `sendSystemEmail` per recipient in
   `bonus_daily_report_recipients`, and logs the send.

### Email content

The HTML email body contains, in order:

- A bold header: `DR3 - {Site Name} Automated Production Report`.
- A subtitle date line: e.g. `Tuesday, June 16, 2026`.
- A table with one row per processor who keyed an entry today, three
  columns: Name | Units | Bonus. Sorted by Units descending, ties broken
  by `entered_at` ascending. Bonus = `calculateDailyBonusCents(units, rule)`
  rendered as `$X.XX` via `formatCents`.
- A footer row showing Total Processed Today (sum of units) and Total
  Bonus Paid Today (sum of cents → formatted).
- A horizontal rule.
- A comparison block with four lines:
  - Same day last year (Mon DD, YYYY): N units
  - Month-to-date (Mon 1 – Mon DD, YYYY): N units
  - Same period last month (Mon 1 – Mon DD, YYYY): N units
  - Pace vs. last month: ±X.X% ▲/▼ (green for positive, red for negative)
- Each comparison line renders `no previous data available` when its
  source window contains zero entries (Eugene's primary case while
  history fills in).
- A signature line: `—DR3-Vision (sent automatically; replaces manual report)`.

### Trigger discipline

The daemon owns its schedule (no host-level cron). Same shape as
`bonus-eod-check.mjs`: a single long-running Node process under
`restart: unless-stopped` in docker-compose. The daemon recomputes the
next fire instant per-site at the top of each iteration; sites with
different `send_time_pt` values are handled by computing the minimum next
fire across all enabled sites and sleeping until that instant.

A container restart re-anchors next-fire computation; `bonus_daily_report_log`
guarantees a restart cannot re-send a report already delivered for the
same Pacific day.

### Per-site configurability

The new tables:

```
bonus_daily_report_config
  id                      uuid PK
  site_id                 uuid FK → sites (unique)
  enabled                 boolean
  send_time_pt            time      -- HH:MM Pacific, default '18:00'
  subject_template        text      -- '[DR3-Vision] {site} processing — {date}'
  skip_if_zero            boolean   -- default true
  skip_weekends           boolean   -- default false
  skip_holidays           boolean   -- default false
  include_bonus_dollars   boolean   -- default true
  include_comparisons     boolean   -- default true
  created_at              timestamp
  updated_at              timestamp

bonus_daily_report_recipients
  id                      uuid PK
  config_id               uuid FK → bonus_daily_report_config
  email                   text      -- enforced lowercase
  added_by_user_id        uuid FK → users
  added_at                timestamp
  -- unique(config_id, email)

bonus_daily_report_log
  id                      uuid PK
  site_id                 uuid FK → sites
  report_date             date
  sent_at                 timestamp
  recipient_count         int
  total_today             int
  total_bonus_cents       int
  mtd_total               int
  delivered_count         int       -- number of recipients Graph accepted
  graph_message_id        text      -- last messageId observed
  last_status             int       -- last HTTP status
  -- unique(site_id, report_date)
```

### Admin tile gating

The admin tile and its routes are gated on a NEW `users.is_super_admin`
boolean. Bill is `true`; everyone else (including admin-role Kelsey) is
`false`. The check is:

```ts
if (!session.user.is_super_admin) return new Response('forbidden', { status: 403 });
```

The flag is propagated onto the session via the existing auth callbacks
(`auth.ts` / `auth.config.ts`).

This is deliberately a database flag and not a hard-coded email check so
a future super-admin promotion is a one-line UPDATE rather than a code
change. Recipient lists are *not* gated to Bill alone — that's the
report's audience config, distinct from who can edit the config itself.

### Notifications

Per recipient, one Graph send via `sendSystemEmail`. A bounce or failure
on one recipient does NOT block delivery to the others. The log row
captures `delivered_count` so a partial failure is visible from the
operator UI without needing Exchange message trace.

## Consequences

### Positive
- Morena freed from a daily manual task. Eugene gets an equivalent report
  it did not previously have.
- Same data source as the signed payroll PDF — single source of truth.
- Pacing insight (MTD vs. prior month same period) is visible at the end
  of every production day rather than only at month-end.

### Negative
- Three new tables, one new daemon, one new admin route group, one new
  schema column on User. Modest surface growth.

### Out of scope
- Per-employee year-over-year deltas (e.g. "Jeremy: +12% vs. last year").
- A UI surface for ad-hoc on-demand sends. The daemon is the only path;
  for an ad-hoc fire, an operator deletes today's log row and restarts.
- A "preview the email body before send" view in the admin tile (could be
  a follow-up; the test-send button covers the same need at first).
```

---

## §4 — Migration SQL

**File:** `prisma/migrations/20260617_daily_production_report/migration.sql`

```sql
-- ADR-0030 — Daily production report: per-site config, recipients, send log,
-- and super-admin flag for the admin tile.

-- ─────────────────────────────────────────────────────────────────────
-- Super-admin flag on users
-- ─────────────────────────────────────────────────────────────────────

ALTER TABLE "users"
  ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────
-- Per-site config
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_config" (
  "id"                    UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id"               UUID NOT NULL,
  "enabled"               BOOLEAN NOT NULL DEFAULT false,
  -- Pacific wall-clock time, HH:MM. Stored as TIME for SQL ergonomics.
  "send_time_pt"          TIME NOT NULL DEFAULT '18:00:00',
  "subject_template"      TEXT NOT NULL DEFAULT '[DR3-Vision] {site} processing — {date}',
  "skip_if_zero"          BOOLEAN NOT NULL DEFAULT true,
  "skip_weekends"         BOOLEAN NOT NULL DEFAULT false,
  "skip_holidays"         BOOLEAN NOT NULL DEFAULT false,
  "include_bonus_dollars" BOOLEAN NOT NULL DEFAULT true,
  "include_comparisons"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL,

  CONSTRAINT "bonus_daily_report_config_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bonus_daily_report_config_site_uq" UNIQUE ("site_id"),
  CONSTRAINT "bonus_daily_report_config_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ─────────────────────────────────────────────────────────────────────
-- Per-config recipients (child table, one row per email address)
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_recipients" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "config_id"        UUID NOT NULL,
  "email"            TEXT NOT NULL,
  "added_by_user_id" UUID,
  "added_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bonus_daily_report_recipients_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_daily_report_recipients_config_fk"
    FOREIGN KEY ("config_id") REFERENCES "bonus_daily_report_config"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,

  CONSTRAINT "bonus_daily_report_recipients_user_fk"
    FOREIGN KEY ("added_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,

  -- One address per config; uniqueness enforced lowercase via the app layer.
  CONSTRAINT "bonus_daily_report_recipients_config_email_uq"
    UNIQUE ("config_id", "email")
);

CREATE INDEX "bonus_daily_report_recipients_config_idx"
  ON "bonus_daily_report_recipients"("config_id");

-- ─────────────────────────────────────────────────────────────────────
-- Idempotency + delivery log
-- ─────────────────────────────────────────────────────────────────────

CREATE TABLE "bonus_daily_report_log" (
  "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
  "site_id"          UUID NOT NULL,
  "report_date"      DATE NOT NULL,
  "sent_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recipient_count"  INTEGER NOT NULL,
  "total_today"      INTEGER NOT NULL,
  "total_bonus_cents" INTEGER NOT NULL,
  "mtd_total"        INTEGER NOT NULL,
  "delivered_count"  INTEGER NOT NULL,
  "graph_message_id" TEXT,
  "last_status"      INTEGER,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bonus_daily_report_log_pkey" PRIMARY KEY ("id"),

  CONSTRAINT "bonus_daily_report_log_site_fk"
    FOREIGN KEY ("site_id") REFERENCES "sites"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,

  CONSTRAINT "bonus_daily_report_log_site_date_uq"
    UNIQUE ("site_id", "report_date")
);

CREATE INDEX "bonus_daily_report_log_sent_at_idx"
  ON "bonus_daily_report_log"("sent_at" DESC);
```

---

## §5 — Prisma schema additions

### §5.1 — New models

Add at the end of the Bonus section:

```prisma
// ────────────────────────────────────────────────────────────────────────
// Daily production report (ADR-0030) — per-site config, recipients, log.
// ────────────────────────────────────────────────────────────────────────

model BonusDailyReportConfig {
  id                    String  @id @default(uuid())
  site_id               String  @unique
  site                  Site    @relation(fields: [site_id], references: [id])

  enabled               Boolean @default(false)
  /// Pacific wall-clock time as HH:MM:SS string. DST handled by daemon.
  send_time_pt          DateTime @db.Time
  subject_template      String  @default("[DR3-Vision] {site} processing — {date}")
  skip_if_zero          Boolean @default(true)
  skip_weekends         Boolean @default(false)
  skip_holidays         Boolean @default(false)
  include_bonus_dollars Boolean @default(true)
  include_comparisons   Boolean @default(true)

  created_at DateTime @default(now())
  updated_at DateTime @updatedAt

  recipients BonusDailyReportRecipient[]

  @@map("bonus_daily_report_config")
}

model BonusDailyReportRecipient {
  id              String                @id @default(uuid())
  config_id       String
  config          BonusDailyReportConfig @relation(fields: [config_id], references: [id], onDelete: Cascade)
  email           String
  added_by_user_id String?
  added_by        User?                 @relation("BonusDailyReportRecipientAdder", fields: [added_by_user_id], references: [id])
  added_at        DateTime              @default(now())

  @@unique([config_id, email])
  @@index([config_id])
  @@map("bonus_daily_report_recipients")
}

model BonusDailyReportLog {
  id                String   @id @default(uuid())
  site_id           String
  site              Site     @relation(fields: [site_id], references: [id])
  report_date       DateTime @db.Date
  sent_at           DateTime @default(now())
  recipient_count   Int
  total_today       Int
  total_bonus_cents Int
  mtd_total         Int
  delivered_count   Int
  graph_message_id  String?
  last_status       Int?
  created_at        DateTime @default(now())

  @@unique([site_id, report_date])
  @@index([sent_at(sort: Desc)])
  @@map("bonus_daily_report_log")
}
```

### §5.2 — `User` model additions

Add the new column and back-relation inside `model User`:

```prisma
  is_super_admin Boolean @default(false)

  // ADR-0030 back-relation:
  bonus_daily_report_recipients_added BonusDailyReportRecipient[] @relation("BonusDailyReportRecipientAdder")
```

### §5.3 — `Site` model additions

Add back-relations inside `model Site`:

```prisma
  bonus_daily_report_config BonusDailyReportConfig?
  bonus_daily_report_logs   BonusDailyReportLog[]
```

### §5.4 — Auth session propagation

`is_super_admin` must surface on the session for the route guard. Patch `src/lib/auth.ts` (or wherever the JWT/session callbacks live) to:

1. In the `jwt` callback, when a user is loaded, copy `user.is_super_admin` onto the token.
2. In the `session` callback, copy `token.is_super_admin` onto `session.user`.
3. Extend the `next-auth.d.ts` declaration module to add `is_super_admin: boolean` to `User` and `Session.user`.

This is the same pattern already used for `role`, `primary_site_id`, and `all_sites`. Mirror it exactly.

### §5.5 — Seed

Mark Bill super-admin in `prisma/seed/users.csv` — set `is_super_admin = true` only for the row whose email is `bill.barnard@svdp.us`. Every other row remains false. If the seed file uses CSV headers without that column, add the column at the end and backfill `false` everywhere except Bill's row.

Add a new seed file `prisma/seed/bonus_daily_report.sql` that runs after `sites` and `users` are seeded:

```sql
-- Daily production report seed (ADR-0030).
-- Both sites enabled at 18:00 PT; Woodland gets Bill+Bethany; Eugene gets
-- Shannon+Bill+Bethany+Rick. The seed is idempotent on re-run via ON CONFLICT.

WITH wld AS (SELECT id FROM sites WHERE code = 'woodland'),
     eug AS (SELECT id FROM sites WHERE code = 'eugene'),
     wld_cfg AS (
       INSERT INTO bonus_daily_report_config
         (site_id, enabled, send_time_pt, updated_at)
       SELECT id, true, '18:00:00'::time, CURRENT_TIMESTAMP FROM wld
       ON CONFLICT (site_id) DO UPDATE SET enabled = true
       RETURNING id
     ),
     eug_cfg AS (
       INSERT INTO bonus_daily_report_config
         (site_id, enabled, send_time_pt, updated_at)
       SELECT id, true, '18:00:00'::time, CURRENT_TIMESTAMP FROM eug
       ON CONFLICT (site_id) DO UPDATE SET enabled = true
       RETURNING id
     )
INSERT INTO bonus_daily_report_recipients (config_id, email)
SELECT id, addr FROM wld_cfg, (VALUES
  ('bill.barnard@svdp.us'),
  ('bethany.cartledge@svdp.us')
) AS r(addr)
ON CONFLICT (config_id, email) DO NOTHING;

INSERT INTO bonus_daily_report_recipients (config_id, email)
SELECT id, addr FROM eug_cfg, (VALUES
  ('shannon.rockwell@svdp.us'),
  ('bill.barnard@svdp.us'),
  ('bethany.cartledge@svdp.us'),
  ('rick.albritton@svdp.us')
) AS r(addr)
ON CONFLICT (config_id, email) DO NOTHING;
```

If the project's seed runner is JS/TS (not SQL), translate the SQL to the equivalent Prisma seed shape. The semantic is what matters: both configs exist, both are enabled, both have the listed recipients, re-running the seed is idempotent.

---

## §6 — `src/lib/bonus/daily-report.ts`

```ts
// ADR-0030 — Pure aggregation logic for the daily production report.
//
// Site-scoped: every query is keyed on the siteId the caller (daemon or
// admin route) hands in. CLAUDE.md hard rule #2.
//
// Pacific calendar-day discipline: date inputs are UTC-midnight @db.Date
// keys for the Pacific calendar day.
//
// Pure: no side effects, no notifications. Side effects live in
// daily-report-notifications.ts and the daemon shell.

import { prisma } from '@/lib/prisma';
import { calculateDailyBonusCents } from '@/lib/bonus/calculator';
import { resolveActiveRule } from '@/lib/bonus/daily-entry';

export interface ProcessorLine {
  employeeId: string;
  fullName: string;
  mattresses: number;
  bonusCents: number;
  enteredAt: Date;
}

export interface ComparisonTotal {
  /** Pacific day or window represented by this comparison. */
  startDate: Date;
  endDate: Date;
  /** null when zero entries exist in the window → render "no previous data available". */
  total: number | null;
}

export interface DailyReport {
  siteId: string;
  siteCode: string;
  siteName: string;
  /** UTC-midnight @db.Date key for the Pacific calendar day. */
  reportDate: Date;
  /** Per-employee, sorted by mattress count desc, ties broken by entered_at asc. */
  lines: ProcessorLine[];
  totalToday: number;
  totalBonusCents: number;
  sameDayLastYear: ComparisonTotal;
  mtd: ComparisonTotal;
  priorMonthSamePeriod: ComparisonTotal;
  /** Percentage delta MTD vs prior-month same period. null when prior is 0 or null. */
  paceDeltaPct: number | null;
}

// ─────────────────────────────────────────────────────────────────────
// Date helpers — pure, no IO
// ─────────────────────────────────────────────────────────────────────

function utcDate(y: number, m1: number, d: number): Date {
  return new Date(Date.UTC(y, m1 - 1, d));
}

function daysInMonth(y: number, m1: number): number {
  return new Date(Date.UTC(y, m1, 0)).getUTCDate();
}

export function sameDayPriorYear(d: Date): Date {
  const y = d.getUTCFullYear() - 1;
  const m1 = d.getUTCMonth() + 1;
  const dom = d.getUTCDate();
  return utcDate(y, m1, Math.min(dom, daysInMonth(y, m1)));
}

export function firstOfMonth(d: Date): Date {
  return utcDate(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function firstOfPriorMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  if (m0 === 0) return utcDate(y - 1, 12, 1);
  return utcDate(y, m0, 1);
}

export function sameDomPriorMonth(d: Date): Date {
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();
  const dom = d.getUTCDate();
  const priorY = m0 === 0 ? y - 1 : y;
  const priorM1 = m0 === 0 ? 12 : m0;
  return utcDate(priorY, priorM1, Math.min(dom, daysInMonth(priorY, priorM1)));
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

/**
 * Sum mattress_count across all site-scoped entries with entry_date in [start, end].
 * Returns null when zero rows match (lets the renderer show "no previous data available").
 */
async function sumRangeOrNull(siteId: string, start: Date, end: Date): Promise<number | null> {
  const rows = await prisma.bonusDailyEntry.findMany({
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: { gte: start, lte: end },
    },
    select: { mattress_count: true },
  });
  if (rows.length === 0) return null;
  let sum = 0;
  for (const r of rows) sum += r.mattress_count.toNumber();
  return Math.round(sum);
}

async function comparisonOrNull(siteId: string, start: Date, end: Date): Promise<ComparisonTotal> {
  return { startDate: start, endDate: end, total: await sumRangeOrNull(siteId, start, end) };
}

// ─────────────────────────────────────────────────────────────────────
// Build the report
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the daily report for `siteId` on the given Pacific calendar day.
 * Throws if the site does not exist. Never throws on missing comparison data —
 * those fields are `null` when their window contains no entries.
 */
export async function buildDailyReport(siteId: string, reportDate: Date): Promise<DailyReport> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, code: true, name: true },
  });
  if (!site) throw new Error(`site ${siteId} not found`);

  // The site's effective bonus rule for the report date governs per-line bonus.
  const rule = await resolveActiveRule(siteId, reportDate);

  // Today's entries (per-employee lines).
  const todayEntries = await prisma.bonusDailyEntry.findMany({
    where: {
      bonus_employee: { site_id: siteId },
      entry_date: reportDate,
    },
    select: {
      mattress_count: true,
      entered_at: true,
      bonus_employee: { select: { id: true, full_name: true } },
    },
  });

  const lines: ProcessorLine[] = todayEntries
    .map((e) => {
      const mattresses = Math.round(e.mattress_count.toNumber());
      return {
        employeeId: e.bonus_employee.id,
        fullName: e.bonus_employee.full_name,
        mattresses,
        bonusCents: calculateDailyBonusCents(mattresses, rule),
        enteredAt: e.entered_at,
      };
    })
    .sort((a, b) => {
      if (b.mattresses !== a.mattresses) return b.mattresses - a.mattresses;
      return a.enteredAt.getTime() - b.enteredAt.getTime();
    });

  const totalToday = lines.reduce((n, l) => n + l.mattresses, 0);
  const totalBonusCents = lines.reduce((n, l) => n + l.bonusCents, 0);

  // Comparisons. Each is null-on-empty so Eugene renders gracefully.
  const sdlyDate = sameDayPriorYear(reportDate);
  const sameDayLastYear = await comparisonOrNull(siteId, sdlyDate, sdlyDate);

  const mtdStart = firstOfMonth(reportDate);
  const mtd: ComparisonTotal = {
    startDate: mtdStart,
    endDate: reportDate,
    // MTD includes today; "no data" only when this month has zero entries.
    total: totalToday === 0 ? await sumRangeOrNull(siteId, mtdStart, reportDate) : (
      (await sumRangeOrNull(siteId, mtdStart, reportDate)) ?? totalToday
    ),
  };

  const priorStart = firstOfPriorMonth(reportDate);
  const priorEnd = sameDomPriorMonth(reportDate);
  const priorMonthSamePeriod = await comparisonOrNull(siteId, priorStart, priorEnd);

  const paceDeltaPct =
    priorMonthSamePeriod.total === null ||
    priorMonthSamePeriod.total === 0 ||
    mtd.total === null
      ? null
      : Math.round(((mtd.total / priorMonthSamePeriod.total) - 1) * 1000) / 10;

  return {
    siteId: site.id,
    siteCode: site.code,
    siteName: site.name,
    reportDate,
    lines,
    totalToday,
    totalBonusCents,
    sameDayLastYear,
    mtd,
    priorMonthSamePeriod,
    paceDeltaPct,
  };
}
```

---

## §6.5 — `src/lib/bonus/daily-report-config.ts`

```ts
// ADR-0030 — Config + recipients CRUD service.
//
// Every mutation writes its audit row in the SAME transaction
// (CLAUDE.md hard rule #6). All callers must already have passed the
// super-admin gate; this layer assumes auth and trusts the actorUserId.

import { prisma } from '@/lib/prisma';
import type { Prisma } from '@prisma/client';

export interface ConfigPatchInput {
  enabled?: boolean;
  sendTimePt?: string;        // 'HH:MM' or 'HH:MM:SS'
  subjectTemplate?: string;
  skipIfZero?: boolean;
  skipWeekends?: boolean;
  skipHolidays?: boolean;
  includeBonusDollars?: boolean;
  includeComparisons?: boolean;
}

export class DailyReportConfigError extends Error {
  readonly status: number;
  constructor(public readonly reason: 'not_found' | 'invalid_time' | 'invalid_email' | 'duplicate_email', statusCode = 422) {
    super(`daily-report-config: ${reason}`);
    this.name = 'DailyReportConfigError';
    this.status = statusCode;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function serialize(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
}

/** Returns the rendered config view for the admin UI, both sites. */
export async function listConfigs() {
  return prisma.bonusDailyReportConfig.findMany({
    orderBy: { site: { code: 'asc' } },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: {
        orderBy: { email: 'asc' },
        include: { added_by: { select: { name: true, email: true } } },
      },
    },
  });
}

export async function getConfigBySite(siteId: string) {
  return prisma.bonusDailyReportConfig.findUnique({
    where: { site_id: siteId },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: { orderBy: { email: 'asc' } },
    },
  });
}

export async function patchConfig(
  configId: string,
  patch: ConfigPatchInput,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  // Normalize the time. We accept HH:MM and store HH:MM:00.
  let send_time_pt: Date | undefined;
  if (patch.sendTimePt !== undefined) {
    if (!TIME_RE.test(patch.sendTimePt)) {
      throw new DailyReportConfigError('invalid_time', 422);
    }
    const padded = patch.sendTimePt.length === 5 ? `${patch.sendTimePt}:00` : patch.sendTimePt;
    // Prisma TIME column accepts a Date; we pass a 1970-01-01 anchor whose
    // time component is what we want stored.
    send_time_pt = new Date(`1970-01-01T${padded}.000Z`);
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.bonusDailyReportConfig.findUnique({ where: { id: configId } });
    if (!before) throw new DailyReportConfigError('not_found', 404);

    const updated = await tx.bonusDailyReportConfig.update({
      where: { id: configId },
      data: {
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(send_time_pt !== undefined ? { send_time_pt } : {}),
        ...(patch.subjectTemplate !== undefined ? { subject_template: patch.subjectTemplate } : {}),
        ...(patch.skipIfZero !== undefined ? { skip_if_zero: patch.skipIfZero } : {}),
        ...(patch.skipWeekends !== undefined ? { skip_weekends: patch.skipWeekends } : {}),
        ...(patch.skipHolidays !== undefined ? { skip_holidays: patch.skipHolidays } : {}),
        ...(patch.includeBonusDollars !== undefined ? { include_bonus_dollars: patch.includeBonusDollars } : {}),
        ...(patch.includeComparisons !== undefined ? { include_comparisons: patch.includeComparisons } : {}),
      },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'update',
        table_name: 'bonus_daily_report_config',
        row_id: configId,
        before: serialize({
          enabled: before.enabled,
          send_time_pt: before.send_time_pt,
          subject_template: before.subject_template,
          skip_if_zero: before.skip_if_zero,
          skip_weekends: before.skip_weekends,
          skip_holidays: before.skip_holidays,
          include_bonus_dollars: before.include_bonus_dollars,
          include_comparisons: before.include_comparisons,
        }),
        after: serialize({
          enabled: updated.enabled,
          send_time_pt: updated.send_time_pt,
          subject_template: updated.subject_template,
          skip_if_zero: updated.skip_if_zero,
          skip_weekends: updated.skip_weekends,
          skip_holidays: updated.skip_holidays,
          include_bonus_dollars: updated.include_bonus_dollars,
          include_comparisons: updated.include_comparisons,
        }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });

    return updated;
  });
}

export async function addRecipient(
  configId: string,
  emailRaw: string,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new DailyReportConfigError('invalid_email', 422);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.bonusDailyReportRecipient.findUnique({
      where: { config_id_email: { config_id: configId, email } },
    });
    if (existing) throw new DailyReportConfigError('duplicate_email', 409);

    const created = await tx.bonusDailyReportRecipient.create({
      data: { config_id: configId, email, added_by_user_id: actor.userId },
    });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'insert',
        table_name: 'bonus_daily_report_recipients',
        row_id: created.id,
        before: null,
        after: serialize({ config_id: configId, email }),
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });

    return created;
  });
}

export async function removeRecipient(
  recipientId: string,
  actor: { userId: string; ip: string | null; userAgent: string | null },
) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.bonusDailyReportRecipient.findUnique({ where: { id: recipientId } });
    if (!before) throw new DailyReportConfigError('not_found', 404);

    await tx.bonusDailyReportRecipient.delete({ where: { id: recipientId } });

    await tx.auditLog.create({
      data: {
        actor_user_id: actor.userId,
        action: 'delete',
        table_name: 'bonus_daily_report_recipients',
        row_id: recipientId,
        before: serialize({ config_id: before.config_id, email: before.email }),
        after: null,
        ip: actor.ip,
        user_agent: actor.userAgent,
      },
    });
  });
}

export async function listRecentSends(siteId: string | null, limit = 30) {
  return prisma.bonusDailyReportLog.findMany({
    where: siteId ? { site_id: siteId } : {},
    orderBy: { sent_at: 'desc' },
    take: limit,
    include: { site: { select: { code: true, name: true } } },
  });
}
```

---

## §7 — `src/lib/bonus/daily-report-notifications.ts`

```ts
// ADR-0030 — Render + send the daily production email.
//
// Subject from the config's subject_template ({site} and {date} substituted).
// HTML body uses the new "DR3 - {Site} Automated Production Report" header.
// Per-recipient send so one bad address never blocks the others. Never throws.

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';

// ─────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────

const FULL_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

function fmtFull(d: Date): string { return FULL_DATE.format(d); }
function fmtShort(d: Date): string { return SHORT_DATE.format(d); }
function fmtRange(start: Date, end: Date): string {
  return `${MONTH_DAY.format(start)} – ${MONTH_DAY.format(end)}, ${end.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function comparisonLineHtml(label: string, c: ComparisonTotal): string {
  if (c.total === null) {
    return `${escapeHtml(label)}: <em>no previous data available</em>`;
  }
  return `${escapeHtml(label)}: <strong>${c.total.toLocaleString('en-US')}</strong> units`;
}

// ─────────────────────────────────────────────────────────────────────
// Subject
// ─────────────────────────────────────────────────────────────────────

export function renderSubject(report: DailyReport, template: string): string {
  return template
    .replace('{site}', report.siteName)
    .replace('{date}', fmtShort(report.reportDate));
}

// ─────────────────────────────────────────────────────────────────────
// HTML body
// ─────────────────────────────────────────────────────────────────────

export interface RenderOptions {
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export function renderHtmlBody(report: DailyReport, opts: RenderOptions): string {
  const headerLine = `DR3 - ${report.siteName} Automated Production Report`;

  const showBonus = opts.includeBonusDollars;

  const rows = report.lines
    .map((l) => {
      const name = escapeHtml(l.fullName);
      if (showBonus) {
        return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 12px 4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(l.bonusCents)}</td></tr>`;
      }
      return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td></tr>`;
    })
    .join('\n');

  const headerRow = showBonus
    ? `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 12px 6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Bonus</th></tr>`
    : `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th></tr>`;

  const footerRow = showBonus
    ? `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 12px 8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(report.totalBonusCents)}</td></tr>`
    : `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td></tr>`;

  let comparisonBlock = '';
  if (opts.includeComparisons) {
    const paceLine = (() => {
      if (report.paceDeltaPct === null) {
        return `Pace vs. last month: <em>no comparable history</em>`;
      }
      const sign = report.paceDeltaPct >= 0 ? '+' : '';
      const arrow = report.paceDeltaPct >= 0 ? '▲' : '▼';
      const color = report.paceDeltaPct >= 0 ? '#3B6D11' : '#A32D2D';
      return `Pace vs. last month: <strong style="color:${color}">${sign}${report.paceDeltaPct.toFixed(1)}% ${arrow}</strong>`;
    })();
    comparisonBlock = `
  <hr style="border:none;border-top:0.5px solid #ccc;margin:16px 0" />
  <div style="font-size:14px;line-height:1.8">
    <div>${comparisonLineHtml(`Same day last year (${fmtShort(report.sameDayLastYear.startDate)})`, report.sameDayLastYear)}</div>
    <div>${comparisonLineHtml(`Month-to-date (${fmtRange(report.mtd.startDate, report.mtd.endDate)})`, report.mtd)}</div>
    <div>${comparisonLineHtml(`Same period last month (${fmtRange(report.priorMonthSamePeriod.startDate, report.priorMonthSamePeriod.endDate)})`, report.priorMonthSamePeriod)}</div>
    <div>${paceLine}</div>
  </div>`;
  }

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:640px">
  <h2 style="margin:0 0 4px;font-size:18px;font-weight:500">${escapeHtml(headerLine)}</h2>
  <p style="margin:0 0 16px;color:#666;font-size:13px">${escapeHtml(fmtFull(report.reportDate))}</p>
  <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px">
    <thead>${headerRow}</thead>
    <tbody>${rows}</tbody>
    <tfoot>${footerRow}</tfoot>
  </table>${comparisonBlock}
  <p style="color:#999;font-size:12px;margin:20px 0 0">—DR3-Vision (sent automatically; replaces manual report)</p>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────────────────────────────

export interface SendDailyReportArgs {
  report: DailyReport;
  recipients: readonly string[];
  subjectTemplate: string;
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export interface SendDailyReportResult {
  attempted: number;
  delivered_count: number;
  graph_message_id: string | undefined;
  last_status: number | undefined;
}

export async function sendDailyReport(args: SendDailyReportArgs): Promise<SendDailyReportResult> {
  const subject = renderSubject(args.report, args.subjectTemplate);
  const htmlBody = renderHtmlBody(args.report, {
    includeBonusDollars: args.includeBonusDollars,
    includeComparisons: args.includeComparisons,
  });

  let delivered_count = 0;
  let graph_message_id: string | undefined;
  let last_status: number | undefined;

  for (const to of args.recipients) {
    try {
      const r = await sendSystemEmail({ to, subject, htmlBody, importance: 'normal' });
      if (r.disabled) {
        log.warn({ to }, '[daily-report] M365 disabled — skip');
        continue;
      }
      if (r.delivered) delivered_count += 1;
      else log.warn({ to, lastStatus: r.lastStatus }, '[daily-report] send failed');
      graph_message_id = r.messageId;
      last_status = r.lastStatus ?? last_status;
    } catch (e) {
      log.warn({ err: e, to }, '[daily-report] send threw');
    }
  }

  return {
    attempted: args.recipients.length,
    delivered_count,
    graph_message_id,
    last_status,
  };
}
```

---