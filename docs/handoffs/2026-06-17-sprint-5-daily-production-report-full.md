# Sprint 5 Handoff — Daily Production Report (REVISED, FULL)

**Status:** Ready for build
**Branch:** `sprint-5-daily-production-report`
**ADR:** ADR-0030 (to be created — content in §3)
**Author:** Bill Barnard, Director of Operations
**Date:** 2026-06-17
**Supersedes:** PR #30 (abbreviated version) and any prior "Sprint 5 — Woodland Daily Processing Email" draft. Do NOT reference earlier drafts; the scope, schema, and admin model are all different.

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

bonus_daily_report_config — id PK, site_id FK to sites (unique), enabled bool, send_time_pt TIME (default 18:00), subject_template TEXT, skip_if_zero bool, skip_weekends bool, skip_holidays bool, include_bonus_dollars bool, include_comparisons bool, created_at/updated_at.

bonus_daily_report_recipients — id PK, config_id FK, email TEXT (lowercase), added_by_user_id FK, added_at. Unique (config_id, email).

bonus_daily_report_log — id PK, site_id FK, report_date date, sent_at, recipient_count, total_today, total_bonus_cents, mtd_total, delivered_count, graph_message_id, last_status. Unique (site_id, report_date).

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

export async function buildDailyReport(siteId: string, reportDate: Date): Promise<DailyReport> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true, code: true, name: true },
  });
  if (!site) throw new Error(`site ${siteId} not found`);

  const rule = await resolveActiveRule(siteId, reportDate);

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

  const sdlyDate = sameDayPriorYear(reportDate);
  const sameDayLastYear = await comparisonOrNull(siteId, sdlyDate, sdlyDate);

  const mtdStart = firstOfMonth(reportDate);
  const mtdSum = await sumRangeOrNull(siteId, mtdStart, reportDate);
  const mtd: ComparisonTotal = {
    startDate: mtdStart,
    endDate: reportDate,
    total: mtdSum,
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
  sendTimePt?: string;
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
  let send_time_pt: Date | undefined;
  if (patch.sendTimePt !== undefined) {
    if (!TIME_RE.test(patch.sendTimePt)) {
      throw new DailyReportConfigError('invalid_time', 422);
    }
    const padded = patch.sendTimePt.length === 5 ? `${patch.sendTimePt}:00` : patch.sendTimePt;
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

import { sendSystemEmail } from '@/lib/m365-mail';
import { log } from '@/lib/observability/logger';
import { formatCents } from '@/lib/bonus/calculator';
import type { DailyReport, ComparisonTotal } from '@/lib/bonus/daily-report';

const FULL_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const SHORT_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});
const MONTH_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});

function fmtFull(d: Date): string { return FULL_DATE.format(d); }
function fmtShort(d: Date): string { return SHORT_DATE.format(d); }
function fmtRange(start: Date, end: Date): string {
  return `${MONTH_DAY.format(start)} – ${MONTH_DAY.format(end)}, ${end.getUTCFullYear()}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function comparisonLineHtml(label: string, c: ComparisonTotal): string {
  if (c.total === null) {
    return `${escapeHtml(label)}: <em>no previous data available</em>`;
  }
  return `${escapeHtml(label)}: <strong>${c.total.toLocaleString('en-US')}</strong> units`;
}

export function renderSubject(report: DailyReport, template: string): string {
  return template.replace('{site}', report.siteName).replace('{date}', fmtShort(report.reportDate));
}

export interface RenderOptions {
  includeBonusDollars: boolean;
  includeComparisons: boolean;
}

export function renderHtmlBody(report: DailyReport, opts: RenderOptions): string {
  const headerLine = `DR3 - ${report.siteName} Automated Production Report`;
  const showBonus = opts.includeBonusDollars;

  const rows = report.lines.map((l) => {
    const name = escapeHtml(l.fullName);
    if (showBonus) {
      return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 12px 4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(l.bonusCents)}</td></tr>`;
    }
    return `<tr><td style="padding:4px 0">${name}</td><td style="padding:4px 0;text-align:right;font-variant-numeric:tabular-nums"><strong>${l.mattresses}</strong></td></tr>`;
  }).join('\n');

  const headerRow = showBonus
    ? `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 12px 6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Bonus</th></tr>`
    : `<tr style="border-bottom:0.5px solid #ccc"><th style="text-align:left;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Processor</th><th style="text-align:right;padding:6px 0;font-weight:500;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.04em">Units</th></tr>`;

  const footerRow = showBonus
    ? `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 12px 8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${formatCents(report.totalBonusCents)}</td></tr>`
    : `<tr style="border-top:0.5px solid #999;font-weight:500"><td style="padding:8px 0">Total Processed Today</td><td style="padding:8px 0;text-align:right;font-variant-numeric:tabular-nums">${report.totalToday.toLocaleString('en-US')}</td></tr>`;

  let comparisonBlock = '';
  if (opts.includeComparisons) {
    const paceLine = (() => {
      if (report.paceDeltaPct === null) return `Pace vs. last month: <em>no comparable history</em>`;
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

  return { attempted: args.recipients.length, delivered_count, graph_message_id, last_status };
}
```

---

## §8 — `scripts/bonus-daily-report.mjs`

```js
#!/usr/bin/env node
// ADR-0030 — Daily production report daemon.

import { PrismaClient } from '@prisma/client';

const PACIFIC_TZ = 'America/Los_Angeles';

function logTs(message) {
  console.log(`[bonus-daily-report ${new Date().toISOString()}] ${message}`);
}

async function loadModules() {
  const dr = await import('../src/lib/bonus/daily-report.ts');
  const drn = await import('../src/lib/bonus/daily-report-notifications.ts');
  return { buildDailyReport: dr.buildDailyReport, sendDailyReport: drn.sendDailyReport };
}

const ISO_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: PACIFIC_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ, weekday: 'short',
});

function pacificDateParts(now) {
  const iso = ISO_FMT.format(now);
  const weekday = WEEKDAY_FMT.format(now);
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const [y, m, d] = iso.split('-').map((p) => Number.parseInt(p, 10));
  const dayKeyUTC = new Date(Date.UTC(y, m - 1, d));
  return { iso, dayKeyUTC, isWeekend };
}

function nextFireInstantAt(from, hour, minute) {
  const FMT = new Intl.DateTimeFormat('en-CA', {
    timeZone: PACIFIC_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(FMT.formatToParts(from).map((p) => [p.type, p.value]));
  const ptNow = {
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
  const currentSecondsOfDay = ptNow.hour * 3600 + ptNow.minute * 60 + ptNow.second;
  const fireSecondsOfDay = hour * 3600 + minute * 60;
  let deltaSec;
  if (currentSecondsOfDay < fireSecondsOfDay) {
    deltaSec = fireSecondsOfDay - currentSecondsOfDay;
  } else {
    deltaSec = 86400 - currentSecondsOfDay + fireSecondsOfDay;
  }
  return new Date(from.getTime() + deltaSec * 1000);
}

function hmFromTime(d) {
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

async function fireSite(prisma, modules, cfg) {
  const now = new Date();
  const parts = pacificDateParts(now);
  logTs(`evaluating ${cfg.site.code} for Pacific day ${parts.iso}`);

  if (cfg.skip_weekends && parts.isWeekend) {
    logTs(`${cfg.site.code}: weekend skip enabled — skipping`);
    return;
  }
  if (cfg.skip_holidays) {
    const holiday = await prisma.siteHoliday.findUnique({
      where: { site_id_holiday_date: { site_id: cfg.site_id, holiday_date: parts.dayKeyUTC } },
      select: { id: true },
    });
    if (holiday) {
      logTs(`${cfg.site.code}: site holiday — skipping`);
      return;
    }
  }

  const existing = await prisma.bonusDailyReportLog.findUnique({
    where: { site_id_report_date: { site_id: cfg.site_id, report_date: parts.dayKeyUTC } },
    select: { id: true, sent_at: true },
  });
  if (existing) {
    logTs(`${cfg.site.code}: already logged at ${existing.sent_at.toISOString()} — skipping`);
    return;
  }

  const report = await modules.buildDailyReport(cfg.site_id, parts.dayKeyUTC);
  if (cfg.skip_if_zero && report.totalToday === 0) {
    logTs(`${cfg.site.code}: zero entries — skipping`);
    return;
  }

  const recipients = cfg.recipients.map((r) => r.email);
  if (recipients.length === 0) {
    logTs(`${cfg.site.code}: no recipients configured — skipping`);
    return;
  }

  logTs(`${cfg.site.code}: sending — ${report.lines.length} processors, ${report.totalToday} units, $${(report.totalBonusCents / 100).toFixed(2)} bonus`);

  const send = await modules.sendDailyReport({
    report,
    recipients,
    subjectTemplate: cfg.subject_template,
    includeBonusDollars: cfg.include_bonus_dollars,
    includeComparisons: cfg.include_comparisons,
  });

  await prisma.bonusDailyReportLog.create({
    data: {
      site_id: cfg.site_id,
      report_date: parts.dayKeyUTC,
      recipient_count: send.attempted,
      total_today: report.totalToday,
      total_bonus_cents: report.totalBonusCents,
      mtd_total: report.mtd.total ?? 0,
      delivered_count: send.delivered_count,
      graph_message_id: send.graph_message_id ?? null,
      last_status: send.last_status ?? null,
    },
  });

  logTs(`${cfg.site.code}: done (${send.delivered_count}/${send.attempted} delivered)`);
}

async function loadEnabledConfigs(prisma) {
  return prisma.bonusDailyReportConfig.findMany({
    where: { enabled: true },
    include: {
      site: { select: { id: true, code: true, name: true } },
      recipients: { select: { email: true } },
    },
  });
}

async function main() {
  if (!process.env['DATABASE_URL']) {
    console.error('bonus-daily-report: DATABASE_URL is required');
    process.exit(2);
  }

  const prisma = new PrismaClient();
  const modules = await loadModules();
  logTs('daemon starting');

  while (true) {
    const configs = await loadEnabledConfigs(prisma);
    if (configs.length === 0) {
      logTs('no enabled configs — checking again in 5 min');
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
      continue;
    }

    const now = new Date();
    const fires = configs.map((cfg) => {
      const { hour, minute } = hmFromTime(cfg.send_time_pt);
      return { cfg, fire: nextFireInstantAt(now, hour, minute) };
    });
    fires.sort((a, b) => a.fire.getTime() - b.fire.getTime());
    const next = fires[0];
    const sleepMs = next.fire.getTime() - now.getTime();
    logTs(`sleeping until ${next.fire.toISOString()} for ${next.cfg.site.code} (~${Math.round(sleepMs / 1000)}s)`);
    await new Promise((r) => setTimeout(r, sleepMs));

    const wake = new Date();
    const dueSet = new Set(
      fires.filter((f) => Math.abs(f.fire.getTime() - wake.getTime()) < 60_000).map((f) => f.cfg.id),
    );
    for (const cfg of configs) {
      if (!dueSet.has(cfg.id)) continue;
      try {
        await fireSite(prisma, modules, cfg);
      } catch (err) {
        logTs(`${cfg.site.code}: fire FAILED — ${err?.message ?? err}`);
      }
    }
  }
}

main().catch((err) => {
  console.error('bonus-daily-report: fatal', err);
  process.exit(1);
});
```

**NOTE on `.mjs` ↔ `.ts` import:** Check `scripts/bonus-period-close.mjs` and `scripts/bonus-escalation-check.mjs` for the canonical pattern. If they don't use `--import tsx`, mirror what they do (might be compiled dist, might be inlined). Worst case: inline the aggregation logic into the `.mjs`.

---

## §9 — Admin UI + routes

### §9.1 — `src/app/admin/production-report/page.tsx`

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { listConfigs, listRecentSends } from '@/lib/bonus/daily-report-config';
import { SiteConfigCard } from './SiteConfigCard';
import { RecentSends } from './RecentSends';
import { HOME_ROUTE } from '@/lib/routes';

export const dynamic = 'force-dynamic';

export default async function ProductionReportAdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/login?next=/admin/production-report');
  if (!session.user.is_super_admin) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 text-dr3-mist-dim">This area is restricted.</p>
        <Link href={HOME_ROUTE} className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  const configs = await listConfigs();
  const recent = await listRecentSends(null, 30);

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-12 text-dr3-mist">
      <div className="mx-auto max-w-4xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline-offset-4 hover:underline">
          ← Back to admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Daily production report</h1>
        <p className="mt-1 text-sm text-dr3-mist-dim">
          Per-site configuration for the automated daily processing email. One site, one config, one daemon fire per
          Pacific calendar day with data.
        </p>

        <div className="mt-8 flex flex-col gap-4">
          {configs.map((c) => (
            <SiteConfigCard key={c.id} config={c} />
          ))}
        </div>

        <h2 className="mt-12 text-xl font-semibold">Recent sends</h2>
        <RecentSends rows={recent} />
      </div>
    </main>
  );
}
```

### §9.2 — `src/app/admin/production-report/SiteConfigCard.tsx`

Client component. Renders the config card for one site (enable toggle, send time, recipient chips with add/remove, subject template, skip toggles, include toggles, save/test/view-recent buttons). Wires Save → `PATCH /api/admin/production-report/config/[siteId]`; Add recipient → `POST .../[siteId]/recipients`; Remove recipient → `DELETE .../[siteId]/recipients?id=…`; Test send → `POST .../[siteId]/test-send`.

Follow the existing repo's client-component conventions — no `<form>` tags (CLAUDE.md hard rule #7), all handlers `onClick`/`onChange`. Match the styling of `src/app/bonus/amendments/AmendmentQueue.tsx`. Show success/error toasts inline beneath the buttons.

### §9.3 — `src/app/admin/production-report/RecentSends.tsx`

Client (or server) component. Table of `BonusDailyReportLog` rows showing: site code, report_date, sent_at, recipient_count vs delivered_count (e.g. "4/4 ✓" or "3/4 ⚠"), total_today, total_bonus_cents (formatted), last_status. Newest first, max 30.

### §9.4 — `src/app/api/admin/production-report/config/route.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { listConfigs } from '@/lib/bonus/daily-report-config';

export async function GET() {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });
  const configs = await listConfigs();
  return NextResponse.json({ configs });
}
```

### §9.5 — `src/app/api/admin/production-report/config/[siteId]/route.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { patchConfig, DailyReportConfigError } from '@/lib/bonus/daily-report-config';

const Body = z.object({
  enabled: z.boolean().optional(),
  sendTimePt: z.string().optional(),
  subjectTemplate: z.string().optional(),
  skipIfZero: z.boolean().optional(),
  skipWeekends: z.boolean().optional(),
  skipHolidays: z.boolean().optional(),
  includeBonusDollars: z.boolean().optional(),
  includeComparisons: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const { siteId } = await ctx.params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  try {
    const updated = await patchConfig(cfg.id, parsed.data, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ config: updated });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

### §9.6 — `src/app/api/admin/production-report/config/[siteId]/recipients/route.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { addRecipient, removeRecipient, DailyReportConfigError } from '@/lib/bonus/daily-report-config';

const PostBody = z.object({ email: z.string().email() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const { siteId } = await ctx.params;
  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  const parsed = PostBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 });
  }

  try {
    const created = await addRecipient(cfg.id, parsed.data.email, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ recipient: created }, { status: 201 });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 422 });

  try {
    await removeRecipient(id, {
      userId: session.user.id,
      ip: req.headers.get('x-forwarded-for'),
      userAgent: req.headers.get('user-agent'),
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof DailyReportConfigError) {
      return NextResponse.json({ error: e.reason }, { status: e.status });
    }
    throw e;
  }
}
```

### §9.7 — `src/app/api/admin/production-report/config/[siteId]/test-send/route.ts`

```ts
// Test send: builds the report for today's Pacific day and sends it to
// the requesting admin's email ONLY (not the configured recipient list).
// Does NOT create a bonus_daily_report_log row — test sends are not
// production sends and must not block tonight's scheduled send.

import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { appToday } from '@/lib/time';
import { buildDailyReport } from '@/lib/bonus/daily-report';
import { sendDailyReport } from '@/lib/bonus/daily-report-notifications';

export async function POST(req: NextRequest, ctx: { params: Promise<{ siteId: string }> }) {
  const session = await auth();
  if (!session?.user?.is_super_admin) return new NextResponse('forbidden', { status: 403 });
  if (!session.user.email) return NextResponse.json({ error: 'no_email_on_account' }, { status: 422 });

  const { siteId } = await ctx.params;
  const cfg = await prisma.bonusDailyReportConfig.findUnique({ where: { site_id: siteId } });
  if (!cfg) return new NextResponse('not_found', { status: 404 });

  const report = await buildDailyReport(siteId, appToday());
  const result = await sendDailyReport({
    report,
    recipients: [session.user.email],
    subjectTemplate: `[TEST] ${cfg.subject_template}`,
    includeBonusDollars: cfg.include_bonus_dollars,
    includeComparisons: cfg.include_comparisons,
  });

  return NextResponse.json({ result });
}
```

### §9.8 — `docker-compose.yml` addition

```yaml
  bonus-daily-report:
    # ADR-0030 — Daily production report daemon (both sites, configurable).
    image: dr3-vision-app:local
    container_name: dr3-vision-bonus-daily-report
    init: true
    restart: unless-stopped
    command: ['node', '--import', 'tsx', 'scripts/bonus-daily-report.mjs']
    healthcheck:
      disable: true
    env_file:
      - /home/bbarnard065/.dr3-vision-secrets/db.env
      - /home/bbarnard065/.dr3-vision-secrets/m365.env
    environment:
      NODE_ENV: production
    depends_on:
      app:
        condition: service_healthy
    networks:
      - dr3net
    labels:
      <<: *barnardhq-labels
      com.barnardhq.service: 'bonus-daily-report'
    logging: *logging
```

If the `--import tsx` runtime isn't already configured for the other `.mjs` daemons, mirror whatever they use.

### §9.9 — Dashboard tile

Add an entry to `src/lib/dashboard-tiles.ts` (or wherever tiles are registered) for the Production Report admin tile. The tile is rendered only when `session.user.is_super_admin === true`. Title: "Production Report". Subtitle: "Daily email automation config". href: `/admin/production-report`.

---

## §10 — Tests

### §10.1 — `src/lib/bonus/__tests__/daily-report.test.ts` (≥ 12 cases)

- `sameDayPriorYear` — Feb 29 leap clamp; ordinary case
- `firstOfMonth`, `firstOfPriorMonth` (year boundary), `sameDomPriorMonth` (short-month clamp + leap day clamp)
- `buildDailyReport` happy path — 3 employees, sorted desc, ties broken by `entered_at`
- `buildDailyReport` per-line bonus matches `calculateDailyBonusCents` for the resolved rule
- `buildDailyReport` total_bonus_cents = sum of line bonuses
- `buildDailyReport` Eugene-style empty history — sameDayLastYear.total === null, paceDeltaPct === null
- `buildDailyReport` MTD when today is the only day with data → mtd.total === totalToday
- `buildDailyReport` paceDeltaPct rounded to one decimal (positive + negative)

### §10.2 — `src/lib/bonus/__tests__/daily-report-config.test.ts` (≥ 10 cases)

- `patchConfig` happy path — enabled toggle, send_time, audit row written
- `patchConfig` invalid time → 422
- `patchConfig` not found → 404
- `addRecipient` happy path — audit row written, email lowercased
- `addRecipient` invalid email → 422
- `addRecipient` duplicate → 409
- `removeRecipient` happy path — audit row written with `before` snapshot
- `removeRecipient` not found → 404
- `listRecentSends` ordering desc by sent_at
- `listRecentSends` siteId filter narrows correctly

### §10.3 — `src/lib/bonus/__tests__/daily-report-notifications.test.ts` (≥ 7 cases)

- `renderSubject` substitutes {site} and {date}
- `renderHtmlBody` includes "DR3 - Woodland Automated Production Report" header
- `renderHtmlBody` shows bonus column when `includeBonusDollars: true`, hides it when false
- `renderHtmlBody` shows comparison block when `includeComparisons: true`, omits when false
- `renderHtmlBody` renders "no previous data available" when a comparison total is null
- `sendDailyReport` per-recipient; partial failure → delivered_count < attempted, no throw
- `sendDailyReport` M365 disabled → delivered_count = 0, no throw

### §10.4 — `src/app/api/admin/production-report/__tests__/routes.test.ts` (≥ 8 cases)

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

```markdown
# Operator Runbook — Daily Production Report

**ADR:** ADR-0030
**Sprint:** Sprint 5 (2026-06-17)

## What changed

A new automated email fires at the configured time (default 6 PM Pacific) for each site whose config row is enabled. Woodland and Eugene are both seeded enabled with the requested recipients. The email replaces Morena's manual daily report (Woodland) and provides equivalent visibility for Eugene.

## Deploy

```
git checkout main && git pull
docker compose up -d
```

This applies migration `20260617_daily_production_report` (additive — adds `is_super_admin` column on `users`, three new tables, no destructive changes), runs the seed, and starts `dr3-vision-bonus-daily-report`.

## Verify

1. Migration applied: `SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;` — expect `20260617_daily_production_report`.
2. Configs seeded: both sites enabled, send_time_pt = 18:00.
3. Recipients seeded: 2 Woodland rows + 4 Eugene rows.
4. Bill flagged super-admin: exactly one row with `is_super_admin = true`.
5. Daemon alive: `docker logs dr3-vision-bonus-daily-report --tail 30` shows `daemon starting` followed by `sleeping until ...`.
6. Admin tile accessible to Bill at `/admin/production-report`. Both site cards visible. Edits round-trip and write audit rows.

## Test fire (without waiting until 6 PM)

From the admin tile, click "Send test now" on either site card. The email lands in your own inbox (not the configured recipient list) with subject prefixed `[TEST]`. No `bonus_daily_report_log` row is created, so the scheduled 6 PM send still fires normally.

## Force a re-send of today's production email

If the scheduled send failed and the issue is fixed:

```
docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "DELETE FROM bonus_daily_report_log WHERE site_id = (SELECT id FROM sites WHERE code = 'woodland') AND report_date = CURRENT_DATE;"
docker restart dr3-vision-bonus-daily-report
```

The daemon sleeps until the next configured fire instant. **There is no in-band "fire now" for the production send** — by design. For a same-day recovery before 6 PM, this is fine. After 6 PM, edit the config to a near-future send time (e.g. 18:30 PT), save, and the daemon will pick it up at the next iteration.

## Changing recipients

`/admin/production-report` → Add/remove via chips → Save. Every change is audit-tracked. Effective on the next fire (no daemon restart needed).

## Rollback

```
docker compose down dr3-vision-bonus-daily-report
docker compose up -d --no-deps app
```

The migration is additive — tables can stay. Drop cleanly only if needed:

```sql
DROP TABLE bonus_daily_report_log;
DROP TABLE bonus_daily_report_recipients;
DROP TABLE bonus_daily_report_config;
ALTER TABLE users DROP COLUMN is_super_admin;
```

## Known limitations

- Patrick Dills shows in the Eugene email like any other processor (he's a Lead processor too — separation-of-duties carve-out only applies to the amendment workflow, not to production reporting).
- The Eugene comparison block will read "no previous data available" for same-day-last-year and prior-month same-period until enough Eugene history accrues (first full month: roughly mid-July 2026; first full year: June 2027).
- The daemon does not retry a failed M365 Graph send. Failed sends are logged and the next day's fire is independent. Use the manual re-send path above for critical missed days.
- The "Pace vs. last month" comparison clamps the prior month's end date to that month's last day (Mar 31 → Feb 28). On months with mismatched lengths the percentage is informational only; the absolute totals are the trustworthy numbers.
```

---

## §13 — CHANGELOG.md entry

Insert at the very top of `## Unreleased`:

```markdown
### 2026-06-17 — Sprint 5: daily production report (ADR-0030)

**Headline.** Replaces Morena Gomez's manual 6 PM Pacific daily processing email for Woodland and adds the same automation for Eugene. Both sites are independently configurable from a Bill-only admin tile (`/admin/production-report`). Recipients, send time, subject template, and skip rules are all editable through the UI; every config change is audit-tracked. Email body includes per-employee mattress count + bonus dollars + total processed + total bonus paid + four comparison lines (same day last year, MTD, prior month same period, percentage delta).

**Migration `20260617_daily_production_report`:** three new tables — `bonus_daily_report_config` (per-site, unique on site_id), `bonus_daily_report_recipients` (child table, unique on (config_id, email)), `bonus_daily_report_log` (per-day idempotency, unique on (site_id, report_date)). Plus a new `is_super_admin` boolean column on `users`, defaulting false, with the seed flipping Bill to true.

**Seed:** Both sites enabled at 18:00 Pacific. Woodland recipients: bill, bethany. Eugene recipients: shannon, bill, bethany, rick. Re-running the seed is idempotent (`ON CONFLICT DO NOTHING` on recipients; `ON CONFLICT DO UPDATE` on config).

**Service layer:** `src/lib/bonus/daily-report.ts` (pure aggregation), `daily-report-config.ts` (CRUD with in-transaction audit), `daily-report-notifications.ts` (rendering + per-recipient sendSystemEmail). Header reads "DR3 - {Site} Automated Production Report".

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
