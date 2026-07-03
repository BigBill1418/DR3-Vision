// ADR-0038 — MyMRC sync orchestration. One run per site per feed:
//   list → upsert (first/last_seen + disappeared detection) → detail pass
//   (bounded ≤3, stamp detail_fetched_at, failures retry next run) → ALWAYS a
//   run-ledger row (including on throw). Hauls additionally feed `expected_loads`
//   via the existing scrape upsert (source=manual protection intact).
//
// The silent-empty class is dead by construction (D4): every failure maps to a
// typed status + a ledger row + (when it matters) a page; a green run with no
// data is impossible. Zero-anomaly: 0 listed where the previous successful run
// listed >0 is `error`, never `ok`.

import type { Prisma, PrismaClient } from '@prisma/client';
import { AuthFailedError, PortalContractDriftError, type PortalClient } from './portal-client';
import { mapHaulRecord, mapOutboundRecord, mapProcessedRecord } from './mappers';
import { fingerprint, ntfyPager, type Pager } from './ntfy';
import { upsertScrapedHauls } from './upsert';
import type {
  FeedName,
  HaulMirrorRow,
  OutboundMirrorRow,
  ProcessedMirrorRow,
  ScrapedHaul,
  SiteCode,
  SyncRunStatus,
} from './types';

const DETAIL_CONCURRENCY = 3;
const REPAGE_MS = 6 * 60 * 60 * 1000; // re-page a persisting failure at most every 6h
const DEADMAN_MS = 26 * 60 * 60 * 1000; // no successful run in >26h → page

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── Pure decision helpers (unit-tested directly) ─────────────────────────────

/** 0 listed where the previous successful run listed >0 ⇒ anomaly (status=error). */
export function isZeroAnomaly(listedCount: number, prevSuccessfulListed: number | null): boolean {
  return listedCount === 0 && prevSuccessfulListed !== null && prevSuccessfulListed > 0;
}

/**
 * Cross-tick paging dedup (the worker is spawned per tick). Page on the LEADING
 * EDGE of a failure (prior run had a different status) or if the same failure
 * has persisted past the re-page interval.
 */
export function decidePage(
  prior: { status: SyncRunStatus; started_at: Date } | null,
  failingStatus: SyncRunStatus,
  now: Date,
  repageMs: number = REPAGE_MS,
): boolean {
  if (!prior) return true;
  if (prior.status !== failingStatus) return true;
  return now.getTime() - prior.started_at.getTime() >= repageMs;
}

/** Active mirror ids no longer present in the latest full list. */
export function computeDisappearedIds(activeIds: readonly string[], listedIds: readonly string[]): string[] {
  const listed = new Set(listedIds);
  return activeIds.filter((id) => !listed.has(id));
}

/** Split ids into bounded-concurrency chunks. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

// ── Per-feed adapter (concrete Prisma types stay inside the closures) ────────

interface FeedAdapter {
  feed: FeedName;
  /** Upsert every listed id: create new (first/last_seen=seenAt), touch last_seen + un-disappear existing. */
  upsertListed(ids: readonly string[], seenAt: Date): Promise<number>;
  /** Set disappeared_at=at for active rows whose id is not in keepIds. */
  markDisappeared(keepIds: readonly string[], at: Date): Promise<number>;
  /** Among listed ids, which mirror rows still lack a detail fetch. */
  idsNeedingDetail(listedIds: readonly string[]): Promise<string[]>;
  /** Fetch + map + persist one record's detail; throws on transport failure. */
  applyDetail(recordId: string, at: Date): Promise<void>;
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
}

function haulsAdapter(prisma: PrismaClient, client: PortalClient, siteId: string): FeedAdapter {
  const model = prisma.mymrcHaulsMirror;
  return {
    feed: 'hauls',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, site_id: siteId, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { site_id: siteId, disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { site_id: siteId, id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async applyDetail(recordId, at) {
      const row: HaulMirrorRow = mapHaulRecord(await client.fetchRecordDetail('hauls', recordId));
      await model.update({
        where: { id: recordId },
        data: {
          external_haul_id: row.external_id,
          status: row.status,
          rate_id: row.rate_id,
          docking_appointment_at: row.docking_appointment_at,
          door: row.door,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function processedAdapter(prisma: PrismaClient, client: PortalClient, siteId: string): FeedAdapter {
  const model = prisma.mymrcProcessedMirror;
  return {
    feed: 'processed',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, site_id: siteId, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { site_id: siteId, disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { site_id: siteId, id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async applyDetail(recordId, at) {
      const row: ProcessedMirrorRow = mapProcessedRecord(await client.fetchRecordDetail('processed', recordId));
      await model.update({
        where: { id: recordId },
        data: {
          external_materials_id: row.external_id,
          bol_id: row.bol_id,
          entry_date: row.entry_date,
          processed_date: row.processed_date,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function outboundAdapter(prisma: PrismaClient, client: PortalClient, siteId: string): FeedAdapter {
  const model = prisma.mymrcOutboundMirror;
  return {
    feed: 'outbound',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, site_id: siteId, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { site_id: siteId, disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { site_id: siteId, id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },
    async applyDetail(recordId, at) {
      const row: OutboundMirrorRow = mapOutboundRecord(await client.fetchRecordDetail('outbound', recordId));
      await model.update({
        where: { id: recordId },
        data: {
          external_materials_id: row.external_id,
          bol_id: row.bol_id,
          entry_date: row.entry_date,
          shipment_date: row.shipment_date,
          vendor: row.vendor,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
        },
      });
    },
  };
}

function adapterFor(feed: FeedName, prisma: PrismaClient, client: PortalClient, siteId: string): FeedAdapter {
  if (feed === 'hauls') return haulsAdapter(prisma, client, siteId);
  if (feed === 'processed') return processedAdapter(prisma, client, siteId);
  return outboundAdapter(prisma, client, siteId);
}

// ── One site+feed run ────────────────────────────────────────────────────────

export interface SyncFeedContext {
  prisma: PrismaClient;
  client: PortalClient;
  site: SiteCode;
  feed: FeedName;
  pager?: Pager;
  log?: Logger;
  now?: () => Date;
  detailConcurrency?: number;
}

export interface SyncFeedResult {
  site: SiteCode;
  feed: FeedName;
  status: SyncRunStatus;
  rowsListed: number;
  rowsUpserted: number;
  detailsFetched: number;
  error: string | null;
}

/**
 * Run a single site+feed sync. Never throws — every terminal condition is
 * captured as a status + a ledger row, and paging (auth/drift/zero) is deduped
 * against the prior run.
 */
export async function syncFeed(ctx: SyncFeedContext): Promise<SyncFeedResult> {
  const pager = ctx.pager ?? ntfyPager;
  const log = ctx.log ?? noopLog;
  const nowFn = ctx.now ?? ((): Date => new Date());
  const started = nowFn();
  const concurrency = ctx.detailConcurrency ?? DETAIL_CONCURRENCY;

  const siteRow = await ctx.prisma.site.findUnique({ where: { code: ctx.site }, select: { id: true } });
  if (!siteRow) throw new Error(`mymrc-sync: site code "${ctx.site}" not found`);
  const siteId = siteRow.id;

  const prior = await ctx.prisma.mymrcSyncRun.findFirst({
    where: { site_id: siteId, feed: ctx.feed },
    orderBy: { started_at: 'desc' },
    select: { status: true, started_at: true },
  });
  const lastOk = await ctx.prisma.mymrcSyncRun.findFirst({
    where: { site_id: siteId, feed: ctx.feed, status: 'ok' },
    orderBy: { started_at: 'desc' },
    select: { rows_listed: true },
  });

  let status: SyncRunStatus = 'ok';
  let rowsListed = 0;
  let rowsUpserted = 0;
  let detailsFetched = 0;
  let error: string | null = null;

  async function pageOnce(kind: Parameters<Pager['page']>[0]['kind'], fp: string, message: string): Promise<void> {
    if (!decidePage(prior, status, nowFn())) return;
    await pager.page({ kind, site: ctx.site, feed: ctx.feed, message, fingerprint: fp }).catch(() => undefined);
  }

  try {
    const adapter = adapterFor(ctx.feed, ctx.prisma, ctx.client, siteId);
    const ids = await ctx.client.fetchListRecordIds(ctx.feed);
    rowsListed = ids.length;

    if (isZeroAnomaly(ids.length, lastOk?.rows_listed ?? null)) {
      status = 'error';
      error = `zero-anomaly: 0 listed where previous successful run listed ${lastOk?.rows_listed}`;
      log('error', `mymrc-sync: ${ctx.site}/${ctx.feed} ${error}`);
      await pageOnce('zero_anomaly', fingerprint.zeroAnomaly(ctx.site, ctx.feed), error);
      return finalize();
    }

    rowsUpserted = await adapter.upsertListed(ids, started);
    await adapter.markDisappeared(ids, started);

    const needDetail = await adapter.idsNeedingDetail(ids);
    for (const group of chunk(needDetail, concurrency)) {
      const settled = await Promise.allSettled(group.map((id) => adapter.applyDetail(id, started)));
      for (const [i, res] of settled.entries()) {
        if (res.status === 'fulfilled') detailsFetched += 1;
        else {
          const id = group[i];
          if (res.reason instanceof AuthFailedError) throw res.reason; // auth is fatal for the run
          log('warn', `mymrc-sync: ${ctx.feed} detail ${id ?? '?'} failed (retry next run): ${describe(res.reason)}`);
        }
      }
    }

    if (ctx.feed === 'hauls') {
      await feedExpectedLoads(ctx.prisma, siteId, ctx.site, started);
    }

    log('info', `mymrc-sync: ${ctx.site}/${ctx.feed} ok — listed=${rowsListed} details=${detailsFetched}`);
    return finalize();
  } catch (err) {
    if (err instanceof AuthFailedError) {
      status = 'auth_failed';
      error = err.message;
      await pageOnce('auth_failed', fingerprint.authFailed(ctx.site), err.message);
    } else if (err instanceof PortalContractDriftError) {
      status = 'contract_drift';
      error = err.message;
      await pageOnce('contract_drift', fingerprint.contractDrift(ctx.site, ctx.feed), err.message);
    } else {
      status = 'error';
      error = describe(err);
      await pageOnce('error', fingerprint.error(ctx.site, ctx.feed), error);
    }
    log('error', `mymrc-sync: ${ctx.site}/${ctx.feed} FAILED (${status}) — ${error}`);
    return finalize();
  }

  async function finalize(): Promise<SyncFeedResult> {
    // Run-ledger row ALWAYS (D4). A ledger-write failure must not mask the run.
    await ctx.prisma.mymrcSyncRun
      .create({
        data: {
          site_id: siteId,
          feed: ctx.feed,
          started_at: started,
          finished_at: nowFn(),
          status,
          rows_listed: rowsListed,
          rows_upserted: rowsUpserted,
          details_fetched: detailsFetched,
          error,
        },
      })
      .catch((e: unknown) => log('error', `mymrc-sync: ledger write failed: ${describe(e)}`));
    return { site: ctx.site, feed: ctx.feed, status, rowsListed, rowsUpserted, detailsFetched, error };
  }
}

// ── Hauls → expected_loads (operational queue) ───────────────────────────────

async function feedExpectedLoads(
  prisma: PrismaClient,
  siteId: string,
  site: SiteCode,
  scrapedAt: Date,
): Promise<void> {
  const rows = await prisma.mymrcHaulsMirror.findMany({
    where: {
      site_id: siteId,
      disappeared_at: null,
      external_haul_id: { not: null },
      docking_appointment_at: { not: null },
    },
    select: {
      external_haul_id: true,
      docking_appointment_at: true,
      rate_id: true,
      units: true,
    },
  });
  const hauls: ScrapedHaul[] = [];
  for (const r of rows) {
    if (!r.external_haul_id || !r.docking_appointment_at) continue;
    hauls.push({
      external_mymrc_haul_id: r.external_haul_id,
      expected_arrival_at: r.docking_appointment_at,
      // The Haul record has no discrete collection-site field; Rate_ID__c is the
      // best available descriptor (landfill - transporter - recycler). Unmatched
      // names persist as source_name_at_sync with a null FK (existing behavior).
      source_name: r.rate_id ?? '(unknown MyMRC rate)',
      transporter_name: null,
      expected_unit_count: r.units,
      bol_number: null,
      scheduled_at_mymrc: r.docking_appointment_at,
    });
  }
  await upsertScrapedHauls({ prisma, site, hauls, scrapedAt });
}

// ── Whole-site run + deadman ─────────────────────────────────────────────────

export interface SyncSiteContext {
  prisma: PrismaClient;
  client: PortalClient;
  site: SiteCode;
  pager?: Pager;
  log?: Logger;
  now?: () => Date;
}

/** Run all three feeds for one site, sequentially (shared session). */
export async function syncSite(ctx: SyncSiteContext): Promise<SyncFeedResult[]> {
  const out: SyncFeedResult[] = [];
  for (const feed of ['hauls', 'processed', 'outbound'] as const) {
    out.push(
      await syncFeed({
        prisma: ctx.prisma,
        client: ctx.client,
        site: ctx.site,
        feed,
        ...(ctx.pager ? { pager: ctx.pager } : {}),
        ...(ctx.log ? { log: ctx.log } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
      }),
    );
  }
  return out;
}

/**
 * Deadman: for each site+feed, page once (deduped) when no successful run has
 * completed in >26h — catches a wedged/stopped container. Called each cron tick.
 */
export async function checkDeadman(args: {
  prisma: PrismaClient;
  sites: readonly SiteCode[];
  pager?: Pager;
  now?: () => Date;
  log?: Logger;
}): Promise<void> {
  const pager = args.pager ?? ntfyPager;
  const now = (args.now ?? ((): Date => new Date()))();
  const log = args.log ?? noopLog;
  for (const site of args.sites) {
    const siteRow = await args.prisma.site.findUnique({ where: { code: site }, select: { id: true } });
    if (!siteRow) continue;
    for (const feed of ['hauls', 'processed', 'outbound'] as const) {
      const lastOk = await args.prisma.mymrcSyncRun.findFirst({
        where: { site_id: siteRow.id, feed, status: 'ok' },
        orderBy: { started_at: 'desc' },
        select: { started_at: true },
      });
      // Only page once a baseline exists (a feed that has never succeeded yet is
      // not a deadman — that is a first-run / config state, surfaced elsewhere).
      if (!lastOk) continue;
      if (now.getTime() - lastOk.started_at.getTime() < DEADMAN_MS) continue;
      const hrs = Math.round((now.getTime() - lastOk.started_at.getTime()) / 3.6e6);
      log('error', `mymrc-sync: DEADMAN ${site}/${feed} — last success ${hrs}h ago`);
      await pager
        .page({
          kind: 'deadman',
          site,
          feed,
          message: `No successful MyMRC ${feed} sync for ${site} in ${hrs}h (threshold 26h).`,
          fingerprint: fingerprint.deadman(site, feed),
          cooldownMs: 6 * 60 * 60 * 1000,
        })
        .catch(() => undefined);
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err);
}
