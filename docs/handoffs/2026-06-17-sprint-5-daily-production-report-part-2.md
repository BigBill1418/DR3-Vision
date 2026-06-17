> **THIS IS PART 2 OF 2.** Continuation of `docs/handoffs/2026-06-17-sprint-5-daily-production-report-part-1.md` — read part 1 first.
>
> - **Part 1:** §0 instructions, §1 context, §2 file manifest, §3 ADR-0030, §4 migration SQL, §5 Prisma schema, §6 `daily-report.ts`, §6.5 `daily-report-config.ts`, §7 `daily-report-notifications.ts`.
> - **Part 2 (this file):** §8 daemon, §9 admin UI + API routes, §10 tests, §11 PR description, §12 operator runbook, §13 CHANGELOG entry, §14 closing instructions.

---

## §8 — `scripts/bonus-daily-report.mjs`

```js
#!/usr/bin/env node
// ADR-0030 — Daily production report daemon.
//
// Long-running daemon, same shape as bonus-eod-check.mjs. Iterates every
// bonus_daily_report_config row with enabled = true. Per-site fire instants
// can differ; the daemon sleeps until the soonest next-fire across all
// enabled sites, fires that site, recomputes.

import { PrismaClient } from '@prisma/client';

const PACIFIC_TZ = 'America/Los_Angeles';

function logTs(message) {
  console.log(`[bonus-daily-report ${new Date().toISOString()}] ${message}`);
}

// Read TS modules at runtime — see bonus-period-close.mjs / bonus-escalation-check.mjs
// for the canonical pattern in this repo. If those use compiled dist output,
// adjust this import path to match. Otherwise the container runs node
// with `--import tsx` (already configured in the compose service spec).
async function loadModules() {
  const dr = await import('../src/lib/bonus/daily-report.ts');
  const drn = await import('../src/lib/bonus/daily-report-notifications.ts');
  return { buildDailyReport: dr.buildDailyReport, sendDailyReport: drn.sendDailyReport };
}

// ── Pacific date helpers ────────────────────────────────────────────

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

/** Next instant at PT hour:minute after `from`. Safe across DST. */
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

/** Read HH:MM from a Date (TIME column round-trips through a Date in UTC). */
function hmFromTime(d) {
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

// ── Per-site fire ───────────────────────────────────────────────────

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
    logTs(`${cfg.site.code}: zero entries — skipping (EOD daemon paged earlier)`);
    return;
  }

  const recipients = cfg.recipients.map((r) => r.email);
  if (recipients.length === 0) {
    logTs(`${cfg.site.code}: no recipients configured — skipping`);
    return;
  }

  logTs(
    `${cfg.site.code}: sending — ${report.lines.length} processors, ${report.totalToday} units, $${(report.totalBonusCents / 100).toFixed(2)} bonus`,
  );

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

// ── Schedule ────────────────────────────────────────────────────────

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

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const configs = await loadEnabledConfigs(prisma);
    if (configs.length === 0) {
      // No enabled sites — re-check every 5 minutes.
      logTs('no enabled configs — checking again in 5 min');
      await new Promise((r) => setTimeout(r, 5 * 60 * 1000));
      continue;
    }

    const now = new Date();
    const fires = configs.map((cfg) => {
      const { hour, minute } = hmFromTime(cfg.send_time_pt);
      return { cfg, fire: nextFireInstantAt(now, hour, minute) };
    });
    // Sleep until the soonest fire.
    fires.sort((a, b) => a.fire.getTime() - b.fire.getTime());
    const next = fires[0];
    const sleepMs = next.fire.getTime() - now.getTime();
    logTs(`sleeping until ${next.fire.toISOString()} for ${next.cfg.site.code} (~${Math.round(sleepMs / 1000)}s)`);
    await new Promise((r) => setTimeout(r, sleepMs));

    // Fire every config whose fire instant is within 60s of now (handles
    // two sites configured for the same time).
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

---

## §9 — Admin UI + routes

### §9.1 — `src/app/admin/production-report/page.tsx`

```tsx
// ADR-0030 — Daily production report admin page (Bill-only via is_super_admin).

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

If the `--import tsx` runtime isn't already configured for the other `.mjs` daemons, mirror whatever they use. Worst case, inline the aggregation logic into the `.mjs` (duplicating the TS module) — but the TS-import path is preferred for single-source-of-truth.

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

1. Migration applied:
   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT migration_name FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1;"
   ```
   Expect: `20260617_daily_production_report`.

2. Configs seeded:
   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT s.code, c.enabled, c.send_time_pt FROM bonus_daily_report_config c JOIN sites s ON s.id = c.site_id ORDER BY s.code;"
   ```
   Expect two rows: eugene (enabled, 18:00) and woodland (enabled, 18:00).

3. Recipients seeded:
   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT s.code, r.email FROM bonus_daily_report_recipients r JOIN bonus_daily_report_config c ON c.id = r.config_id JOIN sites s ON s.id = c.site_id ORDER BY s.code, r.email;"
   ```
   Expect 2 Woodland rows + 4 Eugene rows.

4. Bill flagged super-admin:
   ```
   docker exec dr3-vision-postgres psql -U dr3 -d dr3_vision -c "SELECT email, role, is_super_admin FROM users WHERE is_super_admin = true;"
   ```
   Expect exactly one row: `bill.barnard@svdp.us | admin | t`.

5. Daemon alive:
   ```
   docker logs dr3-vision-bonus-daily-report --tail 30
   ```
   Expect `daemon starting` followed by `sleeping until ...`.

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

**Service layer:**
- `src/lib/bonus/daily-report.ts` — pure aggregation. Per-employee bonus via `calculateDailyBonusCents` against the site's effective `processor_bonus_rules`. Date math handles leap years, year boundaries, and short-month clamping. Comparison totals return `null` on empty windows so Eugene's sparse history renders gracefully.
- `src/lib/bonus/daily-report-config.ts` — config + recipient CRUD with in-transaction audit logging. Email validation app-side (lowercase normalization, regex). Time validation accepts `HH:MM` or `HH:MM:SS`.
- `src/lib/bonus/daily-report-notifications.ts` — subject + HTML body rendering, per-recipient `sendSystemEmail`. Header reads "DR3 - {Site} Automated Production Report" + dated subtitle. Color-codes the pace delta (green up, red down). Conditional sections honor `include_bonus_dollars` and `include_comparisons`.

**Daemon:**
- `scripts/bonus-daily-report.mjs` — long-running, same shape as `bonus-eod-check.mjs`. Iterates every enabled config, sleeps until the soonest next-fire across all sites, fires per site within a 60-second wake window (handles two sites configured for the same time). Idempotency via `bonus_daily_report_log` uniqueness; container restart cannot re-send a delivered report.

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
```

---

## §14 — Closing instructions for Claude Code

1. **Work strictly from this document (parts 1 and 2).** Mirror existing repo conventions (`bonus-eod-check.mjs` daemon shape, `aggregates.ts` rule-resolver pattern, `m365-mail.ts` send semantics, `amendment-requests.ts` audit-in-transaction pattern, `access.ts` session-shape conventions).
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
