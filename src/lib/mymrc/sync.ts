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

import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { AuthFailedError, PortalContractDriftError, type PortalClient } from './portal-client';
import { mapHaulRecord, mapOutboundRecord, mapProcessedRecord } from './mappers';
import { fingerprint, ntfyPager, type Pager } from './ntfy';
import { optionalFieldsForFeed, type RecordFieldsClient } from './record-fields-client';
import { upsertScrapedHauls } from './upsert';
import type {
  FeedName,
  HaulMirrorRow,
  OutboundMirrorRow,
  ProcessedMirrorRow,
  ScrapedHaul,
  SfRecord,
  SiteCode,
  SyncRunStatus,
} from './types';

// Detail is fetched in BATCHES via the getRecordWithFields transport (~100 ids
// per POST), replacing the racy per-record `/s/detail/<id>` navigation.
const DETAIL_BATCH_SIZE = 100;
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

/**
 * Map a MyMRC site-discriminator display name to a DR3-Vision site code. Real
 * values are `Recycling_Center_Lookup__r.Name` (hauls) / `Account__r.Name`
 * (materials) = "DR3 Eugene" / "DR3 Woodland". Site scoping now happens on the
 * DATA, not the login (ADR-0057 D1): the single admin session sees ALL records,
 * so each mirror row is attributed to a site from this field on the DETAIL pass
 * (recon B §6 — the old per-site loop mis-attributed every row to the first
 * site). Returns null for an unrecognized/blank name; the row's `site_id` then
 * stays NULL (unresolved-until-detail) rather than being force-attributed.
 */
export function siteCodeFromDiscriminator(name: string | null | undefined): SiteCode | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('eugene')) return 'eugene';
  if (n.includes('woodland')) return 'woodland';
  return null;
}

/** Resolve a site code to its `sites.id`, or null when unknown/unresolved. */
export type SiteIdResolver = (code: SiteCode | null) => string | null;

/** Build a code→id resolver from the preloaded site rows (one query per run). */
export function makeSiteIdResolver(sites: readonly { id: string; code: string }[]): SiteIdResolver {
  const byCode = new Map(sites.map((s) => [s.code, s.id]));
  return (code) => (code ? (byCode.get(code) ?? null) : null);
}

// ── Per-feed adapter (concrete Prisma types stay inside the closures) ────────

interface FeedAdapter {
  feed: FeedName;
  /** Upsert every listed id: create new (first/last_seen=seenAt), touch last_seen + un-disappear existing. */
  upsertListed(ids: readonly string[], seenAt: Date): Promise<number>;
  /** Set disappeared_at=at for active rows whose id is not in keepIds. */
  markDisappeared(keepIds: readonly string[], at: Date): Promise<number>;
  /**
   * Among listed ids, which mirror rows still lack a detail fetch — paired with
   * the row's business external id (may be null before the first detail fetch) so
   * a failure can be logged against BOTH the Salesforce record id and the human
   * MyMRC id (H-…/M-…) when it is already known.
   */
  idsNeedingDetail(listedIds: readonly string[]): Promise<DetailTarget[]>;
  /** Map + persist one already-fetched record's detail (stamps detail_fetched_at). */
  applyDetailRecord(record: SfRecord, at: Date): Promise<void>;
}

/** A record awaiting a detail fetch: Salesforce record id + (best-known) external id. */
interface DetailTarget {
  id: string;
  externalId: string | null;
}

function toJson(v: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;
}

// The list-pass mirror operations are GLOBAL (site-independent): the single
// admin session lists ALL records regardless of site, so `site_id` is UNKNOWN at
// list time and is set to NULL on create, then derived + stamped on the DETAIL
// pass from the record's discriminator (recon B §6). `markDisappeared` /
// `idsNeedingDetail` are therefore global too — a per-site filter would mis-scope
// against the global id set.

function haulsAdapter(prisma: PrismaClient, resolveSiteId: SiteIdResolver): FeedAdapter {
  const model = prisma.mymrcHaulsMirror;
  return {
    feed: 'hauls',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          // site_id intentionally omitted → NULL until derived on the detail pass.
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true, external_haul_id: true },
      });
      return rows.map((r) => ({ id: r.id, externalId: r.external_haul_id }));
    },
    async applyDetailRecord(record, at) {
      const row: HaulMirrorRow = mapHaulRecord(record);
      const siteId = resolveSiteId(siteCodeFromDiscriminator(row.recycler_name));
      await model.update({
        where: { id: record.id },
        data: {
          external_haul_id: row.external_id,
          status: row.status,
          type: row.type,
          rate_id: row.rate_id,
          recycler_name: row.recycler_name,
          recycler_account_id: row.recycler_account_id,
          transporter_name: row.transporter_name,
          collection_site: row.collection_site,
          collection_source: row.collection_source,
          commodity: row.commodity,
          container_type: row.container_type,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          unpaid_consumer_dropoff_units: row.unpaid_consumer_dropoff_units,
          docking_appointment_date: row.docking_appointment_date,
          docking_appointment_at: row.docking_appointment_at,
          door: row.door,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
          // Only stamp a RESOLVED site — never overwrite with NULL (keeps a prior
          // attribution if a later fetch can't classify the row).
          ...(siteId ? { site_id: siteId } : {}),
        },
      });
    },
  };
}

function processedAdapter(prisma: PrismaClient, resolveSiteId: SiteIdResolver): FeedAdapter {
  const model = prisma.mymrcProcessedMirror;
  return {
    feed: 'processed',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true, external_materials_id: true },
      });
      return rows.map((r) => ({ id: r.id, externalId: r.external_materials_id }));
    },
    async applyDetailRecord(record, at) {
      const row: ProcessedMirrorRow = mapProcessedRecord(record);
      const siteId = resolveSiteId(siteCodeFromDiscriminator(row.account_name));
      await model.update({
        where: { id: record.id },
        data: {
          external_materials_id: row.external_id,
          type: row.type,
          account_name: row.account_name,
          account_id: row.account_id,
          materials_status: row.materials_status,
          bol_id: row.bol_id,
          entry_date: row.entry_date,
          processed_date: row.processed_date,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          units: row.units,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
          ...(siteId ? { site_id: siteId } : {}),
        },
      });
    },
  };
}

function outboundAdapter(prisma: PrismaClient, resolveSiteId: SiteIdResolver): FeedAdapter {
  const model = prisma.mymrcOutboundMirror;
  return {
    feed: 'outbound',
    async upsertListed(ids, seenAt) {
      for (const id of ids) {
        await model.upsert({
          where: { id },
          create: { id, first_seen_at: seenAt, last_seen_at: seenAt },
          update: { last_seen_at: seenAt, disappeared_at: null },
        });
      }
      return ids.length;
    },
    async markDisappeared(keepIds, at) {
      const r = await model.updateMany({
        where: { disappeared_at: null, id: { notIn: [...keepIds] } },
        data: { disappeared_at: at },
      });
      return r.count;
    },
    async idsNeedingDetail(listedIds) {
      const rows = await model.findMany({
        where: { id: { in: [...listedIds] }, detail_fetched_at: null },
        select: { id: true, external_materials_id: true },
      });
      return rows.map((r) => ({ id: r.id, externalId: r.external_materials_id }));
    },
    async applyDetailRecord(record, at) {
      // `vendor` (Outbound_Vendor_Name__c) is a LIST-ONLY column absent from the
      // record detail — it stays null here until the list pass threads it in
      // (documented follow-up). Everything else comes from the detail record.
      const row: OutboundMirrorRow = mapOutboundRecord(record);
      const siteId = resolveSiteId(siteCodeFromDiscriminator(row.account_name));
      await model.update({
        where: { id: record.id },
        data: {
          external_materials_id: row.external_id,
          type: row.type,
          account_name: row.account_name,
          account_id: row.account_id,
          materials_status: row.materials_status,
          bol_id: row.bol_id,
          vendor: row.vendor,
          entry_date: row.entry_date,
          shipment_date: row.shipment_date,
          program_unit_count: row.program_unit_count,
          non_program_unit_count: row.non_program_unit_count,
          weight_lbs: row.weight_lbs,
          retrac_id: row.retrac_id,
          payload: toJson(row.payload),
          detail_fetched_at: at,
          ...(siteId ? { site_id: siteId } : {}),
        },
      });
    },
  };
}

function adapterFor(feed: FeedName, prisma: PrismaClient, resolveSiteId: SiteIdResolver): FeedAdapter {
  if (feed === 'hauls') return haulsAdapter(prisma, resolveSiteId);
  if (feed === 'processed') return processedAdapter(prisma, resolveSiteId);
  return outboundAdapter(prisma, resolveSiteId);
}

// ── One site+feed run ────────────────────────────────────────────────────────

export interface SyncFeedContext {
  prisma: PrismaClient;
  /** List transport (record ids per feed). */
  client: PortalClient;
  /** Batched getRecordWithFields transport for the detail pass (record-fields-client). */
  recordFields: RecordFieldsClient;
  site: SiteCode;
  feed: FeedName;
  pager?: Pager;
  log?: Logger;
  now?: () => Date;
  /** Record-ids per getRecordWithFields POST (default 100). */
  detailBatchSize?: number;
  /** Per-run correlation id. Defaults to a fresh crypto.randomUUID when omitted. */
  runId?: string;
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
  const batchSize = ctx.detailBatchSize ?? DETAIL_BATCH_SIZE;
  const runId = ctx.runId ?? randomUUID();
  // Prefix every line of this run with its correlation id so a run's logs and its
  // ledger row (which persists the same `run_id`) join without timestamp guessing.
  const tag = `run=${runId} ${ctx.site}/${ctx.feed}`;

  const siteRow = await ctx.prisma.site.findUnique({ where: { code: ctx.site }, select: { id: true } });
  if (!siteRow) throw new Error(`mymrc-sync: site code "${ctx.site}" not found`);
  const siteId = siteRow.id;
  // Preloaded code→id map for deriving each mirror row's site on the detail pass
  // (global pull, site-on-data — recon B §6). One query per run.
  const resolveSiteId = makeSiteIdResolver(
    await ctx.prisma.site.findMany({ select: { id: true, code: true } }),
  );

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
    const adapter = adapterFor(ctx.feed, ctx.prisma, resolveSiteId);
    const { ids, complete } = await ctx.client.fetchListRecordIds(ctx.feed);
    rowsListed = ids.length;

    if (isZeroAnomaly(ids.length, lastOk?.rows_listed ?? null)) {
      status = 'error';
      error = `zero-anomaly: 0 listed where previous successful run listed ${lastOk?.rows_listed}`;
      log('error', `mymrc-sync: ${tag} ${error}`);
      await pageOnce('zero_anomaly', fingerprint.zeroAnomaly(ctx.site, ctx.feed), error);
      return finalize();
    }

    rowsUpserted = await adapter.upsertListed(ids, started);
    // Disappeared-detection is a WHOLE-SET operation: `markDisappeared` stamps
    // every active mirror row NOT in `ids`. Running it against a WINDOWED page
    // (the transport only returns the first Aura window when the feed exceeds one
    // page — Haul_Request__c/Materials__c routinely do) would mass-mark the unseen
    // tail as disappeared and drop those (billing-relevant) hauls from
    // `expected_loads`. So it runs ONLY when the list is proven COMPLETE. On a
    // partial page we skip it (never over-mark; a truly-removed record simply
    // stays active until a complete list is seen — the money-safe direction). The
    // windowed history is drained into the mirror by the backfill worker.
    if (complete) {
      await adapter.markDisappeared(ids, started);
    } else {
      log(
        'warn',
        `mymrc-sync: ${tag} list WINDOWED (${ids.length} ids, hasMoreData) — disappeared-detection SKIPPED to avoid over-marking the unseen tail`,
      );
    }

    // Detail pass — BATCHED getRecordWithFields (record-fields-client): chunk the
    // still-null ids ≤batchSize, one direct POST per chunk, map+upsert each
    // returned record. A logged-out session throws AuthFailedError (fatal for the
    // run, existing behavior); per-id ERRORs (FLS/deleted) and transport gaps stay
    // NULL and retry next run — the same money-safe retry as before, no longer racy.
    const needDetail = await adapter.idsNeedingDetail(ids);
    const externalById = new Map(needDetail.map((t) => [t.id, t.externalId]));
    const optionalFields = optionalFieldsForFeed(ctx.feed);
    for (const group of chunk(needDetail.map((t) => t.id), batchSize)) {
      const { records, errors } = await ctx.recordFields.fetchRecordFields(group, optionalFields);
      for (const [, record] of records) {
        await adapter.applyDetailRecord(record, started);
        detailsFetched += 1;
      }
      for (const e of errors) {
        const extId = externalById.get(e.recordId) ?? '(unfetched)';
        log(
          'warn',
          `mymrc-sync: ${tag} detail record=${e.recordId} external=${extId} ${e.state} (retry next run): ${e.message}`,
        );
      }
    }

    if (ctx.feed === 'hauls') {
      await feedExpectedLoads(ctx.prisma, siteId, ctx.site, started, (lvl, msg) => log(lvl, `${tag} ${msg}`));
    }

    log('info', `mymrc-sync: ${tag} ok — listed=${rowsListed} details=${detailsFetched}`);
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
    log('error', `mymrc-sync: ${tag} FAILED (${status}) — ${error}`);
    return finalize();
  }

  async function finalize(): Promise<SyncFeedResult> {
    // Run-ledger row ALWAYS (D4). A ledger-write failure must NEVER be swallowed
    // silently: catch ANY throw, log it with its error class + full run context so
    // a wedged ledger is diagnosable, and still return the run result.
    try {
      await ctx.prisma.mymrcSyncRun.create({
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
          run_id: runId,
        },
      });
    } catch (e: unknown) {
      log(
        'error',
        `mymrc-sync: ${tag} LEDGER WRITE FAILED (${errorClass(e)}) status=${status} listed=${rowsListed} — ${describe(e)}`,
      );
    }
    return { site: ctx.site, feed: ctx.feed, status, rowsListed, rowsUpserted, detailsFetched, error };
  }
}

// ── Hauls → expected_loads (operational queue) ───────────────────────────────

async function feedExpectedLoads(
  prisma: PrismaClient,
  siteId: string,
  site: SiteCode,
  scrapedAt: Date,
  log: Logger,
): Promise<void> {
  // Only site-attributed, detail-fetched hauls feed a site's expected_loads: the
  // global list pass leaves `site_id` NULL until the detail pass derives it, so
  // filtering by `site_id` naturally excludes not-yet-classified rows.
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
      collection_site: true,
      transporter_name: true,
      program_unit_count: true,
    },
  });
  const hauls: ScrapedHaul[] = [];
  for (const r of rows) {
    if (!r.external_haul_id || !r.docking_appointment_at) continue;
    hauls.push({
      external_mymrc_haul_id: r.external_haul_id,
      expected_arrival_at: r.docking_appointment_at,
      // Real collection-site name (Collection_Site__c) is the join key against
      // `sources.name` (recon B §7 — the old code used Rate_ID__c and matched
      // nothing). Unmatched names persist as source_name_at_sync with a null FK.
      source_name: r.collection_site ?? '(unknown MyMRC collection site)',
      transporter_name: r.transporter_name,
      // Billing-authoritative program-unit count (Recycler_Program_Unit_Count__c).
      expected_unit_count: r.program_unit_count,
      bol_number: null,
      scheduled_at_mymrc: r.docking_appointment_at,
    });
  }
  await upsertScrapedHauls({ prisma, site, hauls, scrapedAt, log });
}

// ── Whole-site run + deadman ─────────────────────────────────────────────────

export interface SyncSiteContext {
  prisma: PrismaClient;
  client: PortalClient;
  recordFields: RecordFieldsClient;
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
        recordFields: ctx.recordFields,
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

/** Error class/constructor name for diagnostics (e.g. 'PrismaClientKnownRequestError'). */
function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name || err.constructor.name;
  return typeof err;
}
