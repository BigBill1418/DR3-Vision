// ADR-0071 — the weekly processor-quota report.
//
// This is the DETAIL behind the alert. The email names who flagged; this screen
// shows the underlying daily numbers for the whole floor, so a manager can see
// whether a flagged week is an outlier or the shape of the whole week.
//
// ── Admin/management only, deliberately ─────────────────────────────────────
// Per-named-employee performance data. It is not on any operator or iPad
// surface and must never be — the floor sees its own production, not a ranked
// list of colleagues. The gate here is admin POWERS (`role === 'admin'`), which
// is the site-independent check; site REACH is irrelevant because the report is
// explicitly scoped by `site_id` in the query itself, never by the viewer.
//
// ADR-0071 Amendment 1: that scoping used to be Woodland by accident as much as
// by design — Woodland held the only config row, so `findFirst()` could not
// return anything else. Eugene now has one (seeded disabled), so the site is
// chosen explicitly and carried in the URL rather than left to row order.
//
// ── Deliberately NOT merged into the daily production report ────────────────
// Separate report, separate email (operator directive, 2026-07-30). The daily
// report is a production figure a wide audience reads; this names individuals.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
  addDaysISO,
  computeProcessorQuotaWeek,
  pacificWeekBounds,
  previousCompleteWeek,
  type ProcessorWeek,
} from '@/lib/bonus/processor-quota';

export const dynamic = 'force-dynamic';

function dayLabel(dayISO: string): string {
  return new Date(`${dayISO}T12:00:00.000Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function units(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Next 15: searchParams is a Promise. `tsc --noEmit` does NOT check this against
// Next's generated PageProps — only `next build` does — so getting it wrong here
// passes every local check and breaks the deploy.
export default async function ProcessorQuotaReportPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; site?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'admin') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
        <h1 className="text-2xl font-semibold">Access denied</h1>
        <p className="mt-2 opacity-80">
          Processor performance data is restricted to administrators.
        </p>
        <Link href="/admin" className="mt-6 text-sm underline">
          Back to admin
        </Link>
      </main>
    );
  }

  const sp = await searchParams;
  const now = new Date();
  const requested = sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : null;
  const weekStartISO = requested ?? previousCompleteWeek(now).weekStartISO;

  // ADR-0071 Amendment 1 — this was `findFirst()` with no ordering, which was
  // safe only because exactly one config existed. Eugene now has one too (seeded
  // disabled), and an unordered `findFirst` across two rows shows whichever site
  // Postgres happened to return — a screen that silently changes which floor it
  // is describing. Ordered, selectable, and the chosen site is in the URL.
  const configs = await prisma.processorQuotaConfig.findMany({
    include: { site: true, recipients: true },
    orderBy: { site: { code: 'asc' } },
  });
  const config = configs.find((c) => c.site.code === sp.site) ?? configs[0];

  // The heartbeat, on the one screen where somebody tuning the threshold will
  // see it. "Last checked" is the answer to "is this thing even running" —
  // the question that went unanswerable for twelve days.
  const lastRun = await prisma.processorQuotaRun.findFirst({
    orderBy: { ran_at: 'desc' },
    select: { ran_at: true, configs_enabled: true },
  });

  if (!config) {
    return (
      <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
        <div className="mx-auto max-w-5xl">
          <Link href="/admin" className="text-sm text-dr3-mist-dim underline">
            ← Admin
          </Link>
          <h1 className="mt-2 text-3xl font-bold">Processor production quota</h1>
          <p className="mt-4 text-sm text-dr3-mist-dim">
            No quota configuration exists yet. The ADR-0071 migration seeds one for Woodland.
          </p>
        </div>
      </main>
    );
  }

  const week = await computeProcessorQuotaWeek(prisma, {
    siteId: config.site_id,
    weekStartISO,
    quota: Number(config.quota_units),
    minMisses: config.min_misses,
  });

  const currentWeek = pacificWeekBounds(now).weekStartISO;
  const inProgress = weekStartISO === currentWeek;
  const prevWeek = addDaysISO(weekStartISO, -7);
  const nextWeek = addDaysISO(weekStartISO, 7);
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i));

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto max-w-6xl">
        <Link href="/admin" className="text-sm text-dr3-mist-dim underline hover:text-dr3-mist">
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Processor production quota</h1>
        <p className="mt-1 max-w-3xl text-sm text-dr3-mist-dim">
          {config.site.name} · quota <strong>{units(Number(config.quota_units))}</strong> units/day
          · flagged at <strong>{config.min_misses}</strong> or more days under, in one Monday–Sunday
          week. Only days with recorded production count — a day with no entry is skipped entirely
          and is never a miss.
        </p>

        {/* ── Site switcher (ADR-0071 Amendment 1) ──────────────────── */}
        {configs.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-2 text-sm" data-testid="quota-site-switcher">
            {configs.map((c) => (
              <Link
                key={c.id}
                href={`/admin/processor-quota?site=${c.site.code}&week=${weekStartISO}`}
                className={
                  c.id === config.id
                    ? 'rounded-md bg-dr3-mist/15 px-3 py-1.5 font-medium ring-1 ring-dr3-mist/30'
                    : 'rounded-md bg-dr3-steel/30 px-3 py-1.5 ring-1 ring-dr3-steel-light/20 hover:bg-dr3-steel/50'
                }
              >
                {c.site.name}
                <span className="ml-2 text-xs opacity-70">{c.enabled ? 'on' : 'off'}</span>
              </Link>
            ))}
          </div>
        )}

        {!config.enabled && (
          <p
            className="mt-4 rounded-md bg-amber-500/15 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-500/30"
            data-testid="quota-disabled-banner"
          >
            The weekly digest is <strong>turned off</strong> for {config.site.name}. This report is
            live and accurate; no email is being sent to anyone.
          </p>
        )}

        {/* ── Monitor heartbeat (ADR-0071 Amendment 1) ──────────────────
            Silence is this alert's normal weekly outcome, so "no email" is only
            trustworthy while the monitor is known to be running. Until this
            line existed there was no way to tell a quiet week from a dead cron,
            and for twelve days there was nothing to tell it with. */}
        <p
          className="mt-3 text-xs text-dr3-mist-dim"
          data-testid="quota-monitor-heartbeat"
          suppressHydrationWarning
        >
          {lastRun
            ? `Monitor last checked ${lastRun.ran_at.toLocaleString('en-US', {
                timeZone: 'America/Los_Angeles',
                dateStyle: 'medium',
                timeStyle: 'short',
              })} PT · digest enabled for ${lastRun.configs_enabled} site${
                lastRun.configs_enabled === 1 ? '' : 's'
              }. It runs daily at 06:00 PT and reports the last complete Mon–Sun week.`
            : 'Monitor has never recorded a run — no email is NOT evidence that quota was met.'}
        </p>

        {/* ── Week nav ──────────────────────────────────────────────── */}
        <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
          <Link
            href={`/admin/processor-quota?site=${config.site.code}&week=${prevWeek}`}
            className="rounded-md bg-dr3-steel/30 px-3 py-1.5 ring-1 ring-dr3-steel-light/20 hover:bg-dr3-steel/50"
          >
            ← {prevWeek}
          </Link>
          <span className="font-medium tabular-nums">
            {week.weekStartISO} → {week.weekEndISO}
          </span>
          <Link
            href={`/admin/processor-quota?site=${config.site.code}&week=${nextWeek}`}
            className="rounded-md bg-dr3-steel/30 px-3 py-1.5 ring-1 ring-dr3-steel-light/20 hover:bg-dr3-steel/50"
          >
            {nextWeek} →
          </Link>
          {inProgress && (
            <span className="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs text-sky-300 ring-1 ring-sky-500/30">
              week still in progress — the digest only reports completed weeks
            </span>
          )}
        </div>

        {/* ── Scorecard ─────────────────────────────────────────────── */}
        <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat
            label="Processors with production"
            value={String(week.rows.length)}
            tone="neutral"
          />
          <Stat
            label="Flagged this week"
            value={String(week.flagged.length)}
            tone={week.flagged.length > 0 ? 'alert' : 'ok'}
          />
          <Stat
            label="Would the digest send?"
            value={week.flagged.length > 0 ? 'Yes' : 'No — silent'}
            tone={week.flagged.length > 0 ? 'warn' : 'ok'}
          />
        </div>

        {/* ── The grid ──────────────────────────────────────────────── */}
        <div className="mt-6 overflow-x-auto rounded-lg ring-1 ring-dr3-steel-light/20">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-dr3-steel/30 text-xs uppercase tracking-wide text-dr3-mist-dim">
              <tr>
                <th className="px-3 py-2">Processor</th>
                {days.map((d) => (
                  <th key={d} className="px-3 py-2 text-center">
                    {dayLabel(d)}
                  </th>
                ))}
                <th className="px-3 py-2 text-center">Under</th>
              </tr>
            </thead>
            <tbody>
              {week.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-8 text-center text-dr3-mist-dim">
                    No recorded production for this week.
                  </td>
                </tr>
              )}
              {week.rows.map((p: ProcessorWeek) => (
                <tr
                  key={p.employeeId}
                  className="border-t border-dr3-steel-light/15"
                  data-testid="quota-row"
                >
                  <td className="px-3 py-2 font-medium">
                    {p.name}
                    {p.flagged && (
                      <span className="ml-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-xs text-rose-300 ring-1 ring-rose-500/30">
                        flagged
                      </span>
                    )}
                    {!p.onRoster && (
                      <span
                        className="ml-2 rounded-full bg-dr3-steel/40 px-2 py-0.5 text-xs text-dr3-mist-dim"
                        title="No longer on the roster — shown here because the production was real, but never named in the email."
                      >
                        off roster
                      </span>
                    )}
                  </td>
                  {days.map((d) => {
                    const day = p.days.find((x) => x.dayISO === d);
                    if (!day) {
                      // Not a zero. No entry means no recorded production, which is
                      // never a miss — the dash says "nothing recorded", and a 0
                      // here would say "worked and produced nothing".
                      return (
                        <td key={d} className="px-3 py-2 text-center text-dr3-mist-dim/40">
                          —
                        </td>
                      );
                    }
                    const missed = day.units < Number(config.quota_units);
                    return (
                      <td
                        key={d}
                        className={`px-3 py-2 text-center tabular-nums ${
                          missed ? 'font-semibold text-rose-300' : 'text-dr3-mist'
                        }`}
                      >
                        {units(day.units)}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center tabular-nums">
                    {p.misses.length} / {p.days.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-xs text-dr3-mist-dim">
          A dash means no entry was recorded that day — a day off, PTO, or simply a day not worked.
          It is never counted as a miss. A processor who worked one day under quota therefore shows
          1 / 1 and is not flagged: two strikes needs two worked days.
        </p>
        {config.recipients.length > 0 && (
          <p className="mt-2 text-xs text-dr3-mist-dim">
            Weekly digest recipients: {config.recipients.map((r) => r.email).join(', ')}
          </p>
        )}
      </div>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'ok' | 'warn' | 'alert' | 'neutral';
}) {
  const toneCls =
    tone === 'alert'
      ? 'text-rose-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'ok'
          ? 'text-emerald-300'
          : 'text-dr3-mist';
  return (
    <div className="rounded-lg bg-dr3-steel/20 p-4 ring-1 ring-dr3-steel-light/20">
      <div className="text-xs uppercase tracking-wide text-dr3-mist-dim">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${toneCls}`}>{value}</div>
    </div>
  );
}
