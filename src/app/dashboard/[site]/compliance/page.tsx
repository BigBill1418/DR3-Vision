import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@/lib/prisma';
import { checkManagerForSite } from '@/lib/auth-helpers';
import { collectMetrics } from '@/lib/compliance';
import { MetricTile } from './metric-tile';
import { PeriodPicker } from './period-picker';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate } from '@/i18n/dictionary';

// SPRINT-1-PLAN T-012 — per-site Compliance dashboard.
//
// Renders the seven contract-tracked metrics from `docs/COMPLIANCE.md`
// as colored tiles, each click-throughing to the relevant load-list
// subset using T-011's URL vocabulary. Period defaults to current
// calendar month (compliance metrics are inherently period-scoped);
// `?range=`, `?from`, `?to` honour T-011's vocab so a manager bouncing
// between the two surfaces keeps a consistent window.
//
// Auth: per the T-012 brief and the cross-cutting follow-up flagged in
// the previous CHANGELOG, this page uses the shared `checkManagerForSite`
// helper (T-010 + T-011 still inline-implement; their re-point is a
// separate follow-up). The tagged-result variant lets us render a 403
// surface inline that matches the look of the other manager pages.
//
// In-app signals only — per CLAUDE.md hard rule #5 nothing on this
// surface (or in the `compliance.ts` module it calls into) emits ntfy
// or email. Rendering yellow/red tiles is the entire alerting contract.

export const dynamic = 'force-dynamic';

const RANGES = ['today', 'week', 'month', 'custom'] as const;
type Range = (typeof RANGES)[number];

type SearchParams = {
  range?: string;
  from?: string;
  to?: string;
};

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<SearchParams>;
};

function parseRange(raw: string | undefined): Range {
  return (RANGES as readonly string[]).includes(raw ?? '') ? (raw as Range) : 'month';
}

function parseIsoDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

interface PeriodWindow {
  from: Date;
  to: Date;
}

/**
 * Resolve the period window. Half-open: `[from, to)`. UTC-anchored to
 * stay aligned with T-011's date arithmetic and the underlying
 * `arrived_at` column (timestamptz).
 */
function rangeToWindow(range: Range, customFrom: Date | null, customTo: Date | null): PeriodWindow {
  const now = new Date();
  if (range === 'today') {
    const from = startOfUtcDay(now);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 1);
    return { from, to };
  }
  if (range === 'week') {
    const to = startOfUtcDay(now);
    to.setUTCDate(to.getUTCDate() + 1);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 7);
    return { from, to };
  }
  if (range === 'custom') {
    // Either bound absent → fall back to a reasonable window. We
    // default the missing side to today so the picker is forgiving.
    const from = customFrom ? startOfUtcDay(customFrom) : startOfMonth(now);
    const to = customTo ? endOfDayExclusive(customTo) : startOfUtcDay(addDays(now, 1));
    return { from, to };
  }
  // month — current calendar month, half-open at month-end+1.
  const from = startOfMonth(now);
  const to = startOfMonth(addMonths(now, 1));
  return { from, to };
}

function startOfUtcDay(d: Date): Date {
  const out = new Date(d.getTime());
  out.setUTCHours(0, 0, 0, 0);
  return out;
}

function endOfDayExclusive(d: Date): Date {
  const out = startOfUtcDay(d);
  out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

function toDateInput(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodLabel(range: Range, win: PeriodWindow): string {
  if (range === 'today') return 'Today';
  if (range === 'week') return 'Last 7 days';
  if (range === 'month') {
    const fmt = new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return fmt.format(win.from);
  }
  // custom — show the inclusive range.
  const fmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const inclusiveEnd = new Date(win.to.getTime());
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
  return `${fmt.format(win.from)} – ${fmt.format(inclusiveEnd)}`;
}

export default async function CompliancePage({ params, searchParams }: Props) {
  const { site: siteCode } = await params;
  const sp = await searchParams;

  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t = (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);

  // Auth + site lookup via the shared helper (per the cross-cutting
  // follow-up; T-010 + T-011 still inline their copy).
  const auth = await checkManagerForSite(siteCode);
  if (!auth.ok) {
    if (auth.status === 401) redirect('/login');
    if (auth.status === 404) notFound();
    // 403 — render an in-page surface matching T-010 / T-011's gate.
    return <ForbiddenSurface siteCode={siteCode} t={t} />;
  }
  const ctx = auth.ctx;

  // Re-fetch the site row with the threshold columns the metrics need.
  // `checkManagerForSite` only returns id/code/name; the Site row is
  // small and per-page, so the extra read costs effectively nothing.
  const site = await prisma.site.findUnique({
    where: { id: ctx.siteId },
    select: {
      id: true,
      code: true,
      name: true,
      jurisdiction: true,
      recycling_rate_target_pct: true,
      reconciliation_target_pct: true,
      records_retention_years: true,
      mymrc_inbound_submission_business_days: true,
      mymrc_processed_submission_business_days: true,
      dock_sla_minutes: true,
      inbound_processing_deadline_days: true,
      max_units_indoor: true,
      max_units_total_on_site: true,
    },
  });
  if (!site) notFound();

  const range = parseRange(sp.range);
  const customFrom = parseIsoDate(sp.from);
  const customTo = parseIsoDate(sp.to);
  const window = rangeToWindow(range, customFrom, customTo);

  // Per-site holidays for business-day math. Loaded once per render and
  // threaded into the metric input — keeps the metric module pure.
  const holidayRows = await prisma.siteHoliday.findMany({
    where: { site_id: site.id },
    select: { holiday_date: true },
  });
  const holidays = holidayRows.map((h) => h.holiday_date);

  const slate = await collectMetrics({
    siteId: site.id,
    siteCode: site.code,
    site,
    periodStart: window.from,
    periodEnd: window.to,
    holidays,
  });

  return (
    <main className="min-h-screen bg-dr3-space px-6 py-8 text-dr3-mist">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Link
          href={`/dashboard/${site.code}`}
          className="text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
        >
          {t('dashboard.back_to_site', { name: site.name })}
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">{t('compliance.heading')}</h1>
          <p className="text-sm capitalize text-dr3-mist-dim">
            {t('compliance.subtitle', {
              name: site.name,
              jurisdiction: site.jurisdiction,
              period: periodLabel(range, window),
            })}
          </p>
        </header>

        <PeriodPicker
          range={range}
          from={customFrom ? toDateInput(customFrom) : ''}
          to={customTo ? toDateInput(customTo) : ''}
        />

        <p className="text-xs text-dr3-mist-dim">{t('compliance.in_app_only_note')}</p>

        <section
          aria-label={t('compliance.metrics_aria')}
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          <MetricTile
            title={t('compliance.tile_mymrc_submission')}
            value={slate.mymrcSubmission.value}
            threshold={slate.mymrcSubmission.threshold}
            unit={slate.mymrcSubmission.unit}
            bucket={slate.mymrcSubmission.bucket}
            rowCount={slate.mymrcSubmission.rowCount}
            clickThroughHref={slate.mymrcSubmission.clickThroughHref}
            caption={slate.mymrcSubmission.caption}
          />
          <MetricTile
            title={t('compliance.tile_processed_units')}
            value={slate.processedUnits.value}
            threshold={slate.processedUnits.threshold}
            unit={slate.processedUnits.unit}
            bucket={slate.processedUnits.bucket}
            rowCount={slate.processedUnits.rowCount}
            clickThroughHref={slate.processedUnits.clickThroughHref}
            caption={slate.processedUnits.caption}
          />
          <MetricTile
            title={t('compliance.tile_dock_sla')}
            value={slate.dockSla.value}
            threshold={slate.dockSla.threshold}
            unit={slate.dockSla.unit}
            bucket={slate.dockSla.bucket}
            rowCount={slate.dockSla.rowCount}
            clickThroughHref={slate.dockSla.clickThroughHref}
            caption={slate.dockSla.caption}
          />
          <MetricTile
            title={t('compliance.tile_recycling_rate')}
            value={slate.recyclingRate.value}
            threshold={slate.recyclingRate.threshold}
            unit={slate.recyclingRate.unit}
            bucket={slate.recyclingRate.bucket}
            rowCount={slate.recyclingRate.rowCount}
            clickThroughHref={slate.recyclingRate.clickThroughHref}
            caption={slate.recyclingRate.caption}
          />
          <MetricTile
            title={t('compliance.tile_reconciliation')}
            value={slate.reconciliation.value}
            threshold={slate.reconciliation.threshold}
            unit={slate.reconciliation.unit}
            bucket={slate.reconciliation.bucket}
            rowCount={slate.reconciliation.rowCount}
            clickThroughHref={slate.reconciliation.clickThroughHref}
            caption={slate.reconciliation.caption}
          />
          <MetricTile
            title={t('compliance.tile_storage_inventory')}
            value={slate.storageInventory.value}
            threshold={slate.storageInventory.threshold}
            unit={slate.storageInventory.unit}
            bucket={slate.storageInventory.bucket}
            rowCount={slate.storageInventory.rowCount}
            clickThroughHref={slate.storageInventory.clickThroughHref}
            caption={slate.storageInventory.caption}
          />
          <MetricTile
            title={t('compliance.tile_records_retention')}
            value={slate.recordsRetention.value}
            threshold={slate.recordsRetention.threshold}
            unit={slate.recordsRetention.unit}
            bucket={slate.recordsRetention.bucket}
            rowCount={slate.recordsRetention.rowCount}
            clickThroughHref={slate.recordsRetention.clickThroughHref}
            caption={slate.recordsRetention.caption}
          />
        </section>
      </div>
    </main>
  );
}

function ForbiddenSurface({
  siteCode,
  t,
}: {
  siteCode: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-space px-6 text-center text-dr3-mist">
      <h1 className="text-2xl font-semibold">{t('dashboard.forbidden_heading')}</h1>
      <p className="mt-2 text-dr3-mist-dim">{t('dashboard.forbidden_body', { name: siteCode })}</p>
      <Link
        href="/dashboard"
        className="mt-6 text-sm text-dr3-mist-dim underline-offset-4 hover:text-dr3-cyan hover:underline"
      >
        {t('dashboard.back_to_sites')}
      </Link>
    </main>
  );
}
