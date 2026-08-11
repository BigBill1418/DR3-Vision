// Operations Dashboard aggregation (ADR-0020 tile re-enable, 2026-07-22).
//
// A single server-side composition that pulls the live operational picture for
// one site (or, for the combined admin view, per-site summaries). It is a THIN
// orchestrator over the existing source-of-truth modules — it never re-derives a
// billing/compliance number, it only reads and arranges them. Every source is
// wrapped so one slow/failed read degrades to `null` on that panel instead of
// throwing the whole dashboard (a site with no loads today must render cleanly).
//
// Site isolation (CLAUDE.md hard rule #2): every read here is scoped to the
// resolved `siteId`. The MyMRC mirrors' `site_id` is a nullable string; scoping
// `where: { site_id: siteId }` correctly excludes both the other site AND the
// not-yet-resolved (NULL) rows. The dock-availability mirror has no site_id — it
// is MyMRC's shared scheduling object, surfaced as an explicitly-labeled shared
// card, not site-specific operational data.
//
// Pacific time: freshness/close timestamps are true instants rendered in Bill's
// Pacific wall clock via `formatPacificDateTime`; @db.Date business days use the
// UTC-components rule (`dayISO`). See `@/lib/time`.

import { prisma } from '@/lib/prisma';
import { notVoidedLoadWhere } from '@/lib/loads/not-voided';
import {
  appTodayISO,
  dayISO,
  pacificDayStartInstant,
  formatPacificDateTime,
  appCurrentMonthStart,
} from '@/lib/time';
import { computeFloorInventoryTile } from '@/lib/dashboard/floor-inventory-tile';
import type { FloorInventoryTileData } from '@/lib/dashboard/floor-inventory-tile';
import { computeSiteRateTiles } from '@/lib/dashboard/rate-tiles';
import type { SiteRateTiles } from '@/lib/dashboard/rate-tiles';
import { computeEquipmentTile } from '@/lib/equipment/tile';
import { siteMachineLabel } from '@/lib/equipment/terex-ledger';
import { computeEquipmentThroughput } from '@/lib/equipment/throughput';
import { listProcessedUnits } from '@/lib/loads/processed-units';
import { listCommodityPayments } from '@/lib/commodity-payments/payments';
import { collectMetrics } from '@/lib/compliance';
import type { ComplianceBucket } from '@/lib/compliance';
import { currentPeriodStandings } from '@/lib/bonus/current-period';

// ── Pure helpers (unit-tested; no I/O) ───────────────────────────────────

export type FreshnessTone = 'ok' | 'warn' | 'alert' | 'neutral';

export interface Freshness {
  tone: FreshnessTone;
  /** e.g. "12 min ago", "3 h ago", "2 days ago", or "never synced". */
  relative: string;
  /** Absolute Pacific wall-clock label, or null when never synced. */
  absolutePacific: string | null;
}

/**
 * Grade a "last synced" instant into a tone + human relative/absolute label.
 * Thresholds tuned for the hourly MyMRC scrape: fresh <2h, aging <8h, stale
 * beyond. `null` (never synced) is an alert. Pure — pass `now` for tests.
 */
export function describeFreshness(lastSeenAt: Date | null, now: Date = new Date()): Freshness {
  if (!lastSeenAt) return { tone: 'alert', relative: 'never synced', absolutePacific: null };
  const ms = now.getTime() - lastSeenAt.getTime();
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const hours = ms / 3_600_000;
  const relative =
    mins < 60
      ? `${mins} min ago`
      : hours < 48
        ? `${Math.floor(hours)} h ago`
        : `${Math.floor(hours / 24)} days ago`;
  const tone: FreshnessTone = hours < 2 ? 'ok' : hours < 8 ? 'warn' : 'alert';
  return { tone, relative, absolutePacific: formatPacificDateTime(lastSeenAt) };
}

export interface CommodityAging {
  total: number;
  awaitingInvoice: number;
  invoiced: number;
  paid: number;
  disputed: number;
  /** Awaiting-invoice loads shipped > 30 days ago (overdue to invoice). */
  overdueToInvoice: number;
  /** Invoiced loads unpaid > 45 days since invoicing. */
  overduePaid: number;
  /** Sum of expected amounts on unpaid (awaiting/invoiced/disputed) loads, USD. */
  outstandingUsd: number;
}

interface CommodityRowLike {
  status: 'awaiting_invoice' | 'invoiced' | 'paid' | 'disputed';
  daysSinceShip: number;
  daysSinceInvoiced: number | null;
  expectedAmount: string | null;
}

/** Bucket commodity-payment rows into status counts + aging flags. Pure. */
export function bucketCommodityAging(rows: readonly CommodityRowLike[]): CommodityAging {
  const out: CommodityAging = {
    total: rows.length,
    awaitingInvoice: 0,
    invoiced: 0,
    paid: 0,
    disputed: 0,
    overdueToInvoice: 0,
    overduePaid: 0,
    outstandingUsd: 0,
  };
  for (const r of rows) {
    if (r.status === 'awaiting_invoice') {
      out.awaitingInvoice += 1;
      if (r.daysSinceShip > 30) out.overdueToInvoice += 1;
    } else if (r.status === 'invoiced') {
      out.invoiced += 1;
      if ((r.daysSinceInvoiced ?? 0) > 45) out.overduePaid += 1;
    } else if (r.status === 'paid') {
      out.paid += 1;
    } else {
      out.disputed += 1;
    }
    if (r.status !== 'paid' && r.expectedAmount) {
      const n = Number(r.expectedAmount);
      if (Number.isFinite(n)) out.outstandingUsd += n;
    }
  }
  return out;
}

// ── Panel shapes ─────────────────────────────────────────────────────────

export interface MirrorFreshnessPanel {
  feed: 'hauls' | 'processed' | 'outbound' | 'dock';
  label: string;
  /** Site-scoped row count (dock is shared → fleet-wide). */
  count: number;
  freshness: Freshness;
  /** Latest sync-run status for this feed, when a ledger row exists. */
  lastRunStatus: string | null;
  /** True for the shared, non-site-scoped dock schedule. */
  shared?: boolean;
}

export interface ProcessedClosePanel {
  /** Whether a row exists for today's Pacific production date. */
  foundToday: boolean;
  todayISO: string;
  todayClosed: boolean;
  todayStrippedProgram: number | null;
  todayTotalStripped: number | null;
  /** Most recent CLOSED day, for context when today is still open. */
  lastClosedISO: string | null;
}

export interface EquipmentPanel {
  /** ADR-0077 Am.1 — the machine's name where it exists, else "Equipment". */
  machineLabel: string;
  last7UnitsPerDay: number | null;
  last30UnitsPerDay: number | null;
  /** ADR-0077 D4 — NULL means never recorded, not "no downtime". */
  downtimeHours: number | null;
  /**
   * ADR-0077 Amendment 2 — NULL means NOT RECORDED (no event in the window carried
   * a cost); 0 means a real recorded zero. Never render an absent cost as $0.00.
   */
  costUsd: number | null;
  lastEvent: { dateISO: string; kind: string; hoursDown: number | null } | null;
}

export interface CompliancePanel {
  green: number;
  yellow: number;
  red: number;
  pending: number;
  metrics: { label: string; bucket: ComplianceBucket; value: number; unit: string }[];
}

export interface BonusPanel {
  periodLabel: string | null;
  state: string | null;
  qualifiedCount: number;
  employeeCount: number;
  totalUsd: number;
}

export interface OpsOverview {
  siteCode: string;
  siteName: string;
  jurisdiction: string;
  /** Pacific wall-clock label of render time. */
  generatedPacific: string;
  todayISO: string;

  loadsActive: number;
  loadsArrivedToday: number;

  floor: FloorInventoryTileData | null;
  rates: SiteRateTiles | null;
  processed: ProcessedClosePanel | null;
  equipment: EquipmentPanel | null;
  mirrors: MirrorFreshnessPanel[];
  commodity: CommodityAging | null;
  compliance: CompliancePanel | null;
  bonus: BonusPanel | null;
}

const OPERATOR_ACTIVE_STATUSES = [
  'arrived',
  'weight_captured',
  'unload_started',
  'in_progress',
  'finished',
] as const;

const COMPLIANCE_LABELS: Record<string, string> = {
  mymrcSubmission: 'MyMRC submission',
  processedUnits: 'Processed-units timeliness',
  dockSla: 'Dock SLA',
  recyclingRate: 'Recycling rate',
  reconciliation: 'Reconciliation',
  storageInventory: 'Storage inventory',
  recordsRetention: 'Records retention',
};

async function siteScopedMirror(
  model: {
    aggregate: (args: unknown) => Promise<{ _count: number; _max: { last_seen_at: Date | null } }>;
  },
  where: Record<string, unknown>,
): Promise<{ count: number; lastSeen: Date | null }> {
  const r = await model.aggregate({ where, _count: true, _max: { last_seen_at: true } });
  return { count: r._count, lastSeen: r._max.last_seen_at };
}

async function computeMirrors(siteId: string, now: Date): Promise<MirrorFreshnessPanel[]> {
  const feeds: {
    feed: MirrorFreshnessPanel['feed'];
    label: string;
    load: () => Promise<{ count: number; lastSeen: Date | null }>;
    shared?: boolean;
  }[] = [
    {
      feed: 'hauls',
      label: 'Hauls',
      load: () =>
        siteScopedMirror(prisma.mymrcHaulsMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
    },
    {
      feed: 'processed',
      label: 'Processed',
      load: () =>
        siteScopedMirror(prisma.mymrcProcessedMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
    },
    {
      feed: 'outbound',
      label: 'Outbound',
      load: () =>
        siteScopedMirror(prisma.mymrcOutboundMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
    },
    {
      feed: 'dock',
      label: 'Dock schedule (shared)',
      shared: true,
      load: () =>
        siteScopedMirror(prisma.mymrcDockAvailabilityMirror as never, { disappeared_at: null }),
    },
  ];

  return Promise.all(
    feeds.map(async (f) => {
      const [agg, lastRun] = await Promise.all([
        f.load().catch(() => ({ count: 0, lastSeen: null as Date | null })),
        f.feed === 'dock'
          ? Promise.resolve(null)
          : prisma.mymrcSyncRun
              .findFirst({
                where: { site_id: siteId, feed: f.feed },
                orderBy: { started_at: 'desc' },
                select: { status: true },
              })
              .catch(() => null),
      ]);
      return {
        feed: f.feed,
        label: f.label,
        count: agg.count,
        freshness: describeFreshness(agg.lastSeen, now),
        lastRunStatus: lastRun?.status ?? null,
        ...(f.shared ? { shared: true } : {}),
      } satisfies MirrorFreshnessPanel;
    }),
  );
}

async function computeProcessed(siteId: string, todayISO: string): Promise<ProcessedClosePanel> {
  const rows = await listProcessedUnits(siteId, 60);
  const today = rows.find((r) => dayISO(r.productionDate) === todayISO) ?? null;
  const lastClosed = rows.find((r) => r.closedAt != null) ?? null;
  return {
    foundToday: today != null,
    todayISO,
    todayClosed: today?.closedAt != null,
    todayStrippedProgram: today ? Number(today.strippedProgram) : null,
    todayTotalStripped: today ? Number(today.totalStripped) : null,
    lastClosedISO: lastClosed ? dayISO(lastClosed.productionDate) : null,
  };
}

async function computeEquipmentPanel(siteId: string): Promise<EquipmentPanel> {
  const [tile, throughput, machineLabel] = await Promise.all([
    computeEquipmentTile(siteId),
    computeEquipmentThroughput(siteId, { windowDays: 30 }),
    siteMachineLabel(siteId),
  ]);
  return {
    last7UnitsPerDay: throughput.summary.last7UnitsPerDay,
    last30UnitsPerDay: throughput.summary.last30UnitsPerDay,
    machineLabel,
    downtimeHours: throughput.summary.totalDowntimeHours,
    costUsd:
      throughput.summary.totalCostCents === null ? null : throughput.summary.totalCostCents / 100,
    lastEvent: tile.lastEvent
      ? {
          dateISO: tile.lastEvent.dateISO,
          kind: tile.lastEvent.kind,
          hoursDown: tile.lastEvent.hoursDown != null ? Number(tile.lastEvent.hoursDown) : null,
        }
      : null,
  };
}

async function computeCompliancePanel(siteId: string): Promise<CompliancePanel | null> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: {
      id: true,
      code: true,
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
  if (!site) return null;

  const periodStart = appCurrentMonthStart();
  const periodEnd = new Date(
    Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1),
  );
  const holidayRows = await prisma.siteHoliday.findMany({
    where: { site_id: siteId },
    select: { holiday_date: true },
  });
  const slate = await collectMetrics({
    siteId: site.id,
    siteCode: site.code,
    site,
    periodStart,
    periodEnd,
    holidays: holidayRows.map((h) => h.holiday_date),
  });

  const entries = Object.entries(slate) as [string, (typeof slate)[keyof typeof slate]][];
  const metrics = entries.map(([key, m]) => ({
    label: COMPLIANCE_LABELS[key] ?? key,
    bucket: m.bucket,
    value: m.value,
    unit: m.unit,
  }));
  const counts: Record<ComplianceBucket, number> = { green: 0, yellow: 0, red: 0, pending: 0 };
  for (const m of metrics) counts[m.bucket] += 1;
  return { ...counts, metrics };
}

async function computeBonusPanel(siteId: string): Promise<BonusPanel | null> {
  const standings = await currentPeriodStandings(siteId);
  if (!standings.period) {
    return { periodLabel: null, state: null, qualifiedCount: 0, employeeCount: 0, totalUsd: 0 };
  }
  const qualified = standings.rows.filter((r) => r.daysShort === 0 && r.units > 0).length;
  const totalCents = standings.rows.reduce((s, r) => s + r.bonusCents, 0);
  return {
    periodLabel: standings.period.label,
    state: standings.period.state,
    qualifiedCount: qualified,
    employeeCount: standings.rows.length,
    totalUsd: totalCents / 100,
  };
}

// ── Combined both-sites summary (admin / all-sites picker) ───────────────

export interface SiteSummary {
  siteCode: string;
  siteName: string;
  jurisdiction: string;
  loadsActive: number;
  loadsArrivedToday: number;
  floorTotal: number | null;
  processedFoundToday: boolean;
  processedTodayClosed: boolean;
  commodityOutstandingUsd: number | null;
  /** Oldest MyMRC sync across the feeds — the staleness the site should worry about. */
  mirrorWorst: Freshness;
}

/**
 * A lightweight per-site summary for the combined admin/all-sites picker. Cheaper
 * than `computeOpsOverview` (no compliance slate, equipment series, or bonus) so
 * rendering both sites on the un-polled picker stays fast. Site-scoped per hard
 * rule #2.
 */
export async function computeSiteSummary(args: {
  siteId: string;
  siteCode: string;
  siteName: string;
  jurisdiction: string;
  now?: Date;
}): Promise<SiteSummary> {
  const { siteId, siteCode, siteName, jurisdiction } = args;
  const now = args.now ?? new Date();
  const todayISO = appTodayISO(now);
  const dayStart = pacificDayStartInstant(now);

  const [loadsActive, loadsArrivedToday, floor, processed, commodity, mirrorMax] =
    await Promise.all([
      prisma.inboundLoad
        .count({ where: { site_id: siteId, status: { in: [...OPERATOR_ACTIVE_STATUSES] } } })
        .catch(() => 0),
      prisma.inboundLoad
        // ADR-0090 C — a mis-tapped load is not a truck that arrived today.
        .count({ where: notVoidedLoadWhere({ site_id: siteId, arrived_at: { gte: dayStart } }) })
        .catch(() => 0),
      computeFloorInventoryTile(siteId, { now }).catch(() => null),
      computeProcessed(siteId, todayISO).catch(() => null),
      listCommodityPayments({ siteId })
        .then((rows) => bucketCommodityAging(rows).outstandingUsd)
        .catch(() => null),
      Promise.all([
        siteScopedMirror(prisma.mymrcHaulsMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
        siteScopedMirror(prisma.mymrcProcessedMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
        siteScopedMirror(prisma.mymrcOutboundMirror as never, {
          site_id: siteId,
          disappeared_at: null,
        }),
      ])
        .then((rows) => {
          const seens = rows.map((r) => r.lastSeen).filter((d): d is Date => d != null);
          // Oldest sync = the worst staleness to surface.
          return seens.length ? new Date(Math.min(...seens.map((d) => d.getTime()))) : null;
        })
        .catch(() => null),
    ]);

  return {
    siteCode,
    siteName,
    jurisdiction,
    loadsActive,
    loadsArrivedToday,
    floorTotal: floor?.totalOnFloor ?? null,
    processedFoundToday: processed?.foundToday ?? false,
    processedTodayClosed: processed?.todayClosed ?? false,
    commodityOutstandingUsd: commodity,
    mirrorWorst: describeFreshness(mirrorMax, now),
  };
}

/**
 * Compute the full per-site operations overview. `siteId` is the resolved
 * string UUID; `siteCode`/`siteName`/`jurisdiction` come from the caller's
 * already-authorized site lookup so this never re-authorizes.
 */
export async function computeOpsOverview(args: {
  siteId: string;
  siteCode: string;
  siteName: string;
  jurisdiction: string;
  now?: Date;
}): Promise<OpsOverview> {
  const { siteId, siteCode, siteName, jurisdiction } = args;
  const now = args.now ?? new Date();
  const todayISO = appTodayISO(now);
  const dayStart = pacificDayStartInstant(now);

  const [
    loadsActive,
    loadsArrivedToday,
    floor,
    rates,
    processed,
    equipment,
    mirrors,
    commodity,
    compliance,
    bonus,
  ] = await Promise.all([
    prisma.inboundLoad
      .count({ where: { site_id: siteId, status: { in: [...OPERATOR_ACTIVE_STATUSES] } } })
      .catch(() => 0),
    prisma.inboundLoad
      // ADR-0090 C — a mis-tapped load is not a truck that arrived today.
      .count({ where: notVoidedLoadWhere({ site_id: siteId, arrived_at: { gte: dayStart } }) })
      .catch(() => 0),
    computeFloorInventoryTile(siteId, { now }).catch(() => null),
    computeSiteRateTiles(siteId, jurisdiction).catch(() => null),
    computeProcessed(siteId, todayISO).catch(() => null),
    computeEquipmentPanel(siteId).catch(() => null),
    computeMirrors(siteId, now).catch(() => [] as MirrorFreshnessPanel[]),
    listCommodityPayments({ siteId })
      .then((rows) => bucketCommodityAging(rows))
      .catch(() => null),
    computeCompliancePanel(siteId).catch(() => null),
    computeBonusPanel(siteId).catch(() => null),
  ]);

  return {
    siteCode,
    siteName,
    jurisdiction,
    generatedPacific: formatPacificDateTime(now),
    todayISO,
    loadsActive,
    loadsArrivedToday,
    floor,
    rates,
    processed,
    equipment,
    mirrors,
    commodity,
    compliance,
    bonus,
  };
}
