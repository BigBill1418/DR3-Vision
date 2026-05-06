import { auth } from '@/lib/auth';
import { redirect, notFound } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { LoadStatus, type Prisma } from '@prisma/client';
import Link from 'next/link';
import { LoadsFilters, type LoadsFilterOption } from './loads-filters';
import { LoadsPoller } from './loads-poller';
import { LoadRow } from './load-row';
import { Pagination } from './pagination';
import { getLocale } from '@/i18n/get-locale';
import { getManagerDictionary, translate, translatePlural } from '@/i18n/dictionary';

// SPRINT-1-PLAN T-011 — per-site load list with filters.
//
// Server-renders the filtered, paginated load list for the manager
// portal. URL search params drive every filter so the view is
// shareable, bookmarkable, and back-button friendly. Auto-refresh is
// wired client-side in `LoadsPoller` (30s, per the ticket).
//
// Per CLAUDE.md hard rule #2 every Prisma query in this file scopes
// by `site_id` — including the lookup queries that populate the
// filter dropdowns. Cross-site is not a feature on this surface;
// admins navigate by switching sites in the URL.
//
// Per ADR-0014 the manager portal stays on the green palette (working
// surface, not auth surface).
//
// Pagination uses `take`/`skip` against the existing
// `(site_id, arrived_at)` index on `inbound_loads` so the count()
// stays cheap even at 1000+ rows.

export const dynamic = 'force-dynamic';

const ALL_STATUSES: LoadStatus[] = [
  LoadStatus.expected,
  LoadStatus.arrived,
  LoadStatus.weight_captured,
  LoadStatus.unload_started,
  LoadStatus.in_progress,
  LoadStatus.finished,
  LoadStatus.submitted,
  LoadStatus.verified,
  LoadStatus.rejected,
  LoadStatus.submitted_to_mymrc,
  LoadStatus.processed,
];

// Default view: post-operator statuses the manager actually triages.
// In-progress / pre-arrival statuses live on the T-010 dock view; the
// list view is for "what shipped today and what does it need next?".
// Rationale captured in T-011 brief and matches the SPRINT-1-PLAN
// status-filter list (submitted, verified treated as in-flight to
// MyMRC, rejected, submitted-to-mymrc, processed).
const DEFAULT_STATUSES: LoadStatus[] = [
  LoadStatus.submitted,
  LoadStatus.verified,
  LoadStatus.rejected,
  LoadStatus.submitted_to_mymrc,
  LoadStatus.processed,
];

const RANGES = ['today', 'week', 'month', 'custom'] as const;
type Range = (typeof RANGES)[number];

const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 200;

type SearchParams = {
  range?: string;
  from?: string;
  to?: string;
  status?: string;
  source_id?: string;
  operator_id?: string;
  transporter_id?: string;
  page?: string;
  per_page?: string;
};

type Props = {
  params: Promise<{ site: string }>;
  searchParams: Promise<SearchParams>;
};

function parseRange(raw: string | undefined): Range {
  return (RANGES as readonly string[]).includes(raw ?? '') ? (raw as Range) : 'today';
}

function parseStatuses(raw: string | undefined): LoadStatus[] {
  if (raw === undefined) return DEFAULT_STATUSES;
  const tokens = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return [];
  const valid = new Set<string>(ALL_STATUSES);
  const filtered = tokens.filter((t): t is LoadStatus => valid.has(t));
  return filtered;
}

function parsePositiveInt(raw: string | undefined, fallback: number, max?: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  if (max !== undefined && n > max) return max;
  return n;
}

function parseIsoDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  // Accept YYYY-MM-DD or full ISO; reject anything else.
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

type DateWindow = { from: Date | null; to: Date | null };

function rangeToWindow(range: Range, customFrom: Date | null, customTo: Date | null): DateWindow {
  const now = new Date();
  if (range === 'today') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to };
  }
  if (range === 'week') {
    // Last 7 days, including today.
    const to = new Date(now);
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + 1);
    const from = new Date(to);
    from.setDate(from.getDate() - 7);
    return { from, to };
  }
  if (range === 'month') {
    const to = new Date(now);
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + 1);
    const from = new Date(to);
    from.setDate(from.getDate() - 30);
    return { from, to };
  }
  // custom — respect whichever bounds were given; absent bounds = open-ended on that side.
  const from = customFrom ? new Date(customFrom) : null;
  if (from) from.setHours(0, 0, 0, 0);
  const to = customTo ? new Date(customTo) : null;
  if (to) {
    to.setHours(0, 0, 0, 0);
    to.setDate(to.getDate() + 1); // make `to` exclusive end-of-day
  }
  return { from, to };
}

export default async function LoadsListPage({ params, searchParams }: Props) {
  const { site: siteCode } = await params;
  const sp = await searchParams;

  const session = await auth();
  if (!session?.user) redirect('/login');

  // Manager OR admin only. Operators land on /operator/[site] from
  // their own auth flow.
  const role = session.user.role;
  if (role !== 'manager' && role !== 'admin') {
    redirect('/dashboard');
  }

  const site = await prisma.site.findUnique({
    where: { code: siteCode },
    select: { id: true, code: true, name: true, jurisdiction: true },
  });
  if (!site) notFound();

  const locale = await getLocale();
  const dict = getManagerDictionary(locale);
  const t = (key: string, vars?: Record<string, string | number>) => translate(dict, key, vars);

  const isAdmin = role === 'admin';
  const isAssigned = session.user.primary_site_id === site.id;
  if (!isAdmin && !isAssigned) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-dr3-green-deep px-6 text-center text-dr3-cream">
        <h1 className="text-2xl font-semibold">{t('dashboard.forbidden_heading')}</h1>
        <p className="mt-2 text-dr3-cream/70">
          {t('dashboard.forbidden_body', { name: site.name })}
        </p>
        <Link
          href="/dashboard"
          className="mt-6 text-sm text-dr3-cream/80 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          {t('dashboard.back_to_sites')}
        </Link>
      </main>
    );
  }

  const range = parseRange(sp.range);
  const customFrom = parseIsoDate(sp.from);
  const customTo = parseIsoDate(sp.to);
  const window = rangeToWindow(range, customFrom, customTo);

  const statuses = parseStatuses(sp.status);
  const sourceId = sp.source_id?.trim() || null;
  const operatorId = sp.operator_id?.trim() || null;
  const transporterId = sp.transporter_id?.trim() || null;

  const page = parsePositiveInt(sp.page, 1);
  const perPage = parsePositiveInt(sp.per_page, DEFAULT_PER_PAGE, MAX_PER_PAGE);

  // Build the where. site_id is unconditional. arrived_at is the
  // time axis — pre-arrival rows (status=expected) won't have one
  // and naturally drop out of the date window, which is correct for
  // this surface.
  const where: Prisma.InboundLoadWhereInput = {
    site_id: site.id,
    ...(statuses.length > 0 ? { status: { in: statuses } } : { status: { in: [] } }),
    ...(window.from || window.to
      ? {
          arrived_at: {
            ...(window.from ? { gte: window.from } : {}),
            ...(window.to ? { lt: window.to } : {}),
          },
        }
      : {}),
    ...(sourceId ? { source_id: sourceId } : {}),
    ...(operatorId ? { assigned_operator_id: operatorId } : {}),
    ...(transporterId ? { transporter_id: transporterId } : {}),
  };

  // The page rows + the count, in parallel. The count uses the same
  // (site_id, arrived_at) index as the find; on 1000+ rows this is
  // single-digit ms.
  const [rows, total] = await Promise.all([
    prisma.inboundLoad.findMany({
      where,
      select: {
        id: true,
        bol_number: true,
        status: true,
        arrived_at: true,
        total_units: true,
        source: { select: { name: true } },
        transporter: { select: { name: true } },
        assigned_operator: { select: { name: true } },
      },
      orderBy: { arrived_at: 'desc' },
      take: perPage,
      skip: (page - 1) * perPage,
    }),
    prisma.inboundLoad.count({ where }),
  ]);

  // Filter dropdown sources. All scoped to this site. Pulled in
  // parallel after the main query so the page TTFB is dominated by
  // the (also parallel) rows + count.
  const [sources, operators, transporters] = await Promise.all([
    prisma.source.findMany({
      where: { site_id: site.id, is_active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.user.findMany({
      where: {
        primary_site_id: site.id,
        role: 'operator',
        deleted_at: null,
      },
      select: { id: true, name: true, is_active: true },
      orderBy: { name: 'asc' },
    }),
    // Transporters are not site-scoped in the schema (they're a
    // shared lookup), but only those with at least one load at this
    // site are useful in the dropdown. This subquery stays fast
    // because the inbound_loads (site_id, status) index covers it.
    prisma.transporter.findMany({
      where: {
        is_active: true,
        inbound_loads: { some: { site_id: site.id } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const sourceOptions: LoadsFilterOption[] = sources.map((s) => ({ id: s.id, label: s.name }));
  const operatorOptions: LoadsFilterOption[] = operators.map((o) => ({
    id: o.id,
    label: o.is_active ? o.name : `${o.name} ${t('loads.filter_inactive_suffix')}`,
  }));
  const transporterOptions: LoadsFilterOption[] = transporters.map((tr) => ({
    id: tr.id,
    label: tr.name,
  }));

  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);

  return (
    <main className="min-h-screen bg-dr3-green-deep px-6 py-8 text-dr3-cream">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <Link
          href={`/dashboard/${site.code}`}
          className="text-sm text-dr3-cream/70 underline-offset-4 hover:text-dr3-cream hover:underline"
        >
          {t('dashboard.back_to_site', { name: site.name })}
        </Link>
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">{t('loads.heading')}</h1>
          <p className="text-sm capitalize text-dr3-cream/70">
            {t('loads.subtitle', { name: site.name, jurisdiction: site.jurisdiction })}
          </p>
        </header>

        <LoadsFilters
          siteCode={site.code}
          range={range}
          from={customFrom ? toDateInputValue(customFrom) : ''}
          to={customTo ? toDateInputValue(customTo) : ''}
          statuses={statuses}
          allStatuses={ALL_STATUSES}
          sourceId={sourceId}
          operatorId={operatorId}
          transporterId={transporterId}
          sourceOptions={sourceOptions}
          operatorOptions={operatorOptions}
          transporterOptions={transporterOptions}
        />

        <LoadsPoller />

        <section className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-wide text-dr3-cream/60">
            {total === 0
              ? t('loads.summary_none')
              : translatePlural(dict, 'loads.summary_count', total, {
                  count: total.toLocaleString(),
                  page: safePage,
                  total: totalPages,
                })}
          </p>
          {rows.length === 0 ? (
            <div className="rounded-lg bg-dr3-green-dark/40 p-8 text-center">
              <p className="text-base font-medium">{t('loads.empty_page_heading')}</p>
              <p className="mt-2 text-sm text-dr3-cream/70">{t('loads.empty_page_body')}</p>
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-dr3-green-dark/40 overflow-hidden rounded-lg bg-dr3-green-dark/30">
              {rows.map((row) => (
                <LoadRow
                  key={row.id}
                  siteCode={site.code}
                  load={{
                    id: row.id,
                    bol_number: row.bol_number,
                    status: row.status,
                    arrived_at: row.arrived_at,
                    total_units: row.total_units,
                    source_name: row.source?.name ?? null,
                    transporter_name: row.transporter?.name ?? null,
                    operator_name: row.assigned_operator?.name ?? null,
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        {totalPages > 1 && <Pagination page={safePage} totalPages={totalPages} />}
      </div>
    </main>
  );
}

function toDateInputValue(d: Date): string {
  // YYYY-MM-DD in the server's local time. The dashboard runs in
  // America/Los_Angeles for both sites in MVP; once T-008's locale
  // wiring lands the formatting helper hoists into src/lib/format.ts.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

