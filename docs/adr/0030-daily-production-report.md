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
`bonus-period-close.mjs`: a single long-running Node process under
`restart: unless-stopped` in docker-compose. The daemon is a thin Pacific
scheduler that imports only `@prisma/client` — it reads each enabled site's
`send_time_pt`, computes the soonest next fire across all enabled sites,
sleeps until that instant, and then POSTs to the loopback+bearer-guarded
internal route `/api/internal/bonus/daily-report`, which runs the tested
TS runner (`src/lib/bonus/daily-report-runner.ts`) inside the Next app.
The daemon performs no aggregation, no email, and no TS import itself.

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
change. Recipient lists are _not_ gated to Bill alone — that's the
report's audience config, distinct from who can edit the config itself.

### Notifications

Per recipient, one Graph send via `sendSystemEmail`. A bounce or failure
on one recipient does NOT block delivery to the others. The log row
captures `delivered_count` so a partial failure is visible from the
operator UI without needing Exchange message trace.

## Implementation note (build-time divergence)

The following divergences from the original handoff were resolved at build
time and are authoritative:

1. **No-tsx thin-daemon → internal-route architecture.** The daemon does
   NOT use `tsx` and does NOT import any `.ts` module. `tsx` is a
   devDependency and the production image is built with `npm ci --omit=dev`,
   so a `node --import tsx` daemon would crash in prod. Every existing
   daemon (`bonus-period-close.mjs`, etc.) runs as plain `node scripts/X.mjs`.
   To match, `scripts/bonus-daily-report.mjs` is a thin Pacific scheduler
   importing only `@prisma/client`; it computes the soonest next fire from
   each enabled config's `send_time_pt`, sleeps, then POSTs to a new
   loopback+bearer-guarded internal route `/api/internal/bonus/daily-report`.
   That route invokes the tested TS runner
   (`src/lib/bonus/daily-report-runner.ts` → `runDailyReportFire(now)`),
   so all aggregation, rendering, sending, and log-writing run compiled
   inside the Next app. This mirrors the existing
   `bonus-period-close.mjs` → `/api/internal/bonus/close-months` pattern.

2. **Morena added to Woodland recipients (operator request 2026-06-17).**
   Woodland seeds with `bill.barnard@svdp.us`, `bethany.cartledge@svdp.us`,
   and `morena.gomez@svdp.us` (Morena, whose manual report this replaces,
   is kept on the distribution). Eugene is unchanged: Shannon, Bill,
   Bethany, Rick.

3. **Bill super-admin via idempotent `updateMany`.** `bill.barnard@svdp.us`
   is not a row in `prisma/seed/users.csv` (his login row is created by SSO
   on first sign-in). The seed therefore adds an `is_super_admin` column to
   `users.csv` (false everywhere) and `seedUsers()` runs an idempotent
   post-step `prisma.user.updateMany({ where: { email: 'bill.barnard@svdp.us' }, data: { is_super_admin: true } })`
   — a no-op on a fresh DB, flipping Bill once his SSO row exists. Live prod
   gets the same one-line UPDATE at deploy. No fake login row is invented.

4. **SVdP-branded email (operator request 2026-06-17).** The outgoing report
   uses the St. Vincent de Paul Society of Lane County parent-org palette
   sampled from `svdp.us` — red masthead `#a3151a`, gold accent `#ffcc69`,
   cream `#f7f3ea`, with the white SVdP wordmark
   (`svdp.us/.../svdp-logo-white-300x300.png`). This deliberately differs from
   the DR3 green/black in-app brand (CLAUDE.md rule #3 reserves the SVdP red
   palette for the parent org); Bill explicitly asked for svdp.us branding on
   this email. Layout is table-based, inline-styled, ≤600px for Outlook/M365
   fidelity. Default `subject_template` tightened to
   `DR3 Daily Production Report — {site} — {date}`.

5. **Internal test-send route.** `POST /api/internal/bonus/daily-report/test`
   (loopback + optional `INTERNAL_CRON_TOKEN`, same guard as `close-months`)
   renders the REAL email for a site and sends it to one address with a
   `[TEST]` subject prefix, writing **no** `bonus_daily_report_log` row — so an
   operator can preview production-identical output from the host without a
   browser session and without blocking the scheduled fire. Body:
   `{ "siteCode": "woodland"|"eugene", "to": "name@svdp.us" }`.

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
