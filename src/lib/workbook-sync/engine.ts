// ADR-0049 D1/D2/D3/D5/D11 — the workbook sync engine.
//
// One poll tick, per active source:
//   discover the current month's file (D5 rollover) → delta-detect by cTag (D2: no
//   re-download when unchanged) → download → parse via the SHARED ADR-0048/0039
//   `parseWorkbook` + the daily adapter → upsert into `processed_units_daily` under
//   the workbook-wins rule with an audit row per Vision-overwrite (D3) → mid-edit
//   rows skipped + counted, retried next poll, NO alert (D11) → a `workbook_sync_runs`
//   ledger row ALWAYS (incl. throw / fail-soft paths). Post-cutover (surface flipped
//   `live`, D7) the sync is a NO-OP.
//
// Business-hours enforcement lives at the ROUTE (D2) so the engine stays test-time
// agnostic. A missing `Files.Read.All` grant surfaces as FilesForbiddenError →
// status `forbidden`, fail-soft: log + ntfy Bill + ledger, never a crash
// (test-plan line 8).

import { randomUUID } from 'node:crypto';
import type { PrismaClient, WorkbookSource } from '@prisma/client';
import { prisma as defaultPrisma } from '@/lib/prisma';
import { publishNtfy } from '@/lib/ntfy';
import { getRolloutState } from '@/lib/notify/rollout';
import { UnregisteredSurfaceError } from '@/lib/notify/errors';
import { WORKBOOK_SYNC_SURFACE } from './surface';
import { parseWorkbook } from '@/lib/audit/workbook/parser';
import {
  FilesForbiddenError,
  selectFilesTransport,
  type FilesTransport,
  type FilesTransportLogger,
} from '@/lib/msgraph-files';
import { parseDailyRows } from './daily-adapter';
import { resolveMonthlyFileName } from './naming';
import { upsertDailyProduction } from './upsert';

export type SyncStatus = 'ok' | 'forbidden' | 'not_found' | 'error';
export type SyncLogger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: SyncLogger = () => undefined;

export interface SyncOneResult {
  sourceId: string;
  siteId: string;
  status: SyncStatus;
  transportMode: 'mock' | 'graph';
  fileName: string | null;
  changesDetected: boolean;
  cutoverNoop: boolean;
  rowsUpserted: number;
  rowsSkippedMidedit: number;
  rowsOverwritten: number;
  error: string | null;
  runId: string;
}

export interface RunPollResult {
  transportMode: 'mock' | 'graph';
  sourcesPolled: number;
  results: SyncOneResult[];
}

export interface SyncContext {
  prisma?: PrismaClient;
  transport?: FilesTransport;
  now?: () => Date;
  log?: SyncLogger;
  /** Limit to one site (tests / a targeted re-poll). */
  siteId?: string;
}

/** Poll every ACTIVE (`is_syncing`) source. Disabled sources are skipped entirely. */
export async function runWorkbookSyncPoll(ctx: SyncContext = {}): Promise<RunPollResult> {
  const prisma = ctx.prisma ?? defaultPrisma;
  const log = ctx.log ?? noopLog;
  const transport = ctx.transport ?? (await selectFilesTransport(log as FilesTransportLogger));

  const sources = await prisma.workbookSource.findMany({
    where: { is_syncing: true, ...(ctx.siteId ? { site_id: ctx.siteId } : {}) },
    orderBy: { created_at: 'asc' },
  });

  const results: SyncOneResult[] = [];
  for (const source of sources) {
    results.push(await syncOneSource({ ...ctx, prisma, transport, log }, source));
  }
  return { transportMode: transport.mode, sourcesPolled: sources.length, results };
}

interface ResolvedCtx extends SyncContext {
  prisma: PrismaClient;
  transport: FilesTransport;
  log: SyncLogger;
}

export async function syncOneSource(
  ctx: ResolvedCtx,
  source: WorkbookSource,
): Promise<SyncOneResult> {
  const { prisma, transport, log } = ctx;
  const nowFn = ctx.now ?? ((): Date => new Date());
  const runId = randomUUID();
  const started = nowFn();
  const mode = transport.mode;

  let status: SyncStatus = 'ok';
  let error: string | null = null;
  let fileName: string | null = null;
  let changesDetected = false;
  let cutoverNoop = false;
  let rowsUpserted = 0;
  let rowsSkippedMidedit = 0;
  let rowsOverwritten = 0;

  try {
    // Post-cutover (surface live) ⇒ sync is a no-op (D7). The ERROR direction
    // matters (2026-07-10 audit): if the rollout read FAILS we cannot know
    // whether the site is cut over, and resuming the workbook-wins upsert on a
    // cut-over site would overwrite live Vision-captured rows — the one
    // irreversible outcome. So an unreadable state SKIPS this poll (no-op, run
    // ledger says so); a transient DB blip costs one 10-minute cycle,
    // pre-cutover or post. Only an explicit 'pilot'/unregistered read keeps
    // syncing.
    let cutoverLive = false;
    try {
      cutoverLive =
        (await getRolloutState({
          db: prisma,
          kind: 'workbook_sync',
          surfaceCode: WORKBOOK_SYNC_SURFACE,
          siteId: source.site_id,
        })) === 'live';
    } catch (e) {
      if (e instanceof UnregisteredSurfaceError) {
        // Deterministic answer, not a failure: an unregistered surface IS
        // pilot (pre-cutover) — keep syncing.
        cutoverLive = false;
      } else {
        cutoverLive = true; // fail SAFE: unknown cutover state ⇒ do not upsert
        log(
          'warn',
          `[workbook-sync] run=${runId} site=${source.site_id} rollout-state read failed — skipping poll (fail-safe): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (cutoverLive) {
      cutoverNoop = true;
      log(
        'info',
        `[workbook-sync] run=${runId} site=${source.site_id} CUT OVER (surface live) — no-op`,
      );
    } else {
      fileName = resolveMonthlyFileName(source.naming_pattern, started);
      const file = await transport.getFile(source.drive_upn, source.folder_path, fileName);

      if (!file) {
        status = 'not_found';
        log(
          'info',
          `[workbook-sync] run=${runId} site=${source.site_id} file "${fileName}" not found (possibly-empty new month)`,
        );
      } else if (file.id === source.last_file_id && file.ctag === source.last_file_ctag) {
        // Delta no-op (D2): unchanged cTag ⇒ NO re-download / re-parse.
        changesDetected = false;
        log(
          'info',
          `[workbook-sync] run=${runId} site=${source.site_id} "${fileName}" unchanged (ctag) — no re-download`,
        );
      } else {
        changesDetected = true;
        const bytes = await transport.downloadFile(source.drive_upn, file.id);
        // Shared ADR-0048/0039 parser runs for staging/provenance + template-drift
        // detection (its output is not re-persisted per poll — see ADR-0049 notes);
        // the daily adapter derives the operational rows.
        const parsed = await parseWorkbook(bytes);
        const daily = await parseDailyRows(bytes);
        rowsSkippedMidedit = daily.midEditCount;

        const counts = await prisma.$transaction((tx) =>
          upsertDailyProduction({
            db: tx,
            siteId: source.site_id,
            syncRunId: runId,
            rows: daily.rows,
          }),
        );
        rowsUpserted = counts.upserted;
        rowsOverwritten = counts.overwritten;
        log(
          'info',
          `[workbook-sync] run=${runId} site=${source.site_id} "${fileName}" gen=${parsed.templateGeneration} upserted=${rowsUpserted} overwritten=${rowsOverwritten} midEdit=${rowsSkippedMidedit}`,
        );
      }

      await prisma.workbookSource.update({
        where: { id: source.id },
        data: {
          last_polled_at: nowFn(),
          ...(file
            ? { last_file_id: file.id, last_file_name: file.name, last_file_ctag: file.ctag }
            : {}),
        },
      });
    }
  } catch (err) {
    if (err instanceof FilesForbiddenError) {
      status = 'forbidden';
      error = err.message;
      log(
        'error',
        `[workbook-sync] run=${runId} site=${source.site_id} FORBIDDEN (Files.Read.All missing) — ${error}`,
      );
      await pageForbidden(source.site_id, error).catch(() => undefined);
    } else {
      status = 'error';
      error = describe(err);
      log('error', `[workbook-sync] run=${runId} site=${source.site_id} FAILED — ${error}`);
      await pageError(source.site_id, error).catch(() => undefined);
    }
  }

  // Ledger row ALWAYS (mymrc_sync_runs discipline), including throw / fail-soft.
  try {
    await prisma.workbookSyncRun.create({
      data: {
        source_id: source.id,
        site_id: source.site_id,
        started_at: started,
        finished_at: nowFn(),
        status,
        transport_mode: mode,
        file_name: fileName,
        changes_detected: changesDetected,
        rows_upserted: rowsUpserted,
        rows_skipped_midedit: rowsSkippedMidedit,
        rows_overwritten: rowsOverwritten,
        cutover_noop: cutoverNoop,
        error_text: error,
        run_id: runId,
      },
    });
  } catch (e) {
    log(
      'error',
      `[workbook-sync] run=${runId} site=${source.site_id} LEDGER WRITE FAILED — ${describe(e)}`,
    );
  }

  return {
    sourceId: source.id,
    siteId: source.site_id,
    status,
    transportMode: mode,
    fileName,
    changesDetected,
    cutoverNoop,
    rowsUpserted,
    rowsSkippedMidedit,
    rowsOverwritten,
    error,
    runId,
  };
}

async function pageForbidden(siteId: string, message: string): Promise<void> {
  await publishNtfy({
    topic: 'dr3-vision-system',
    title: 'Workbook sync forbidden (Files.Read.All)',
    body: `${message}\n\nThe workbook sync for site ${siteId} got a Graph 403 — the Files.Read.All grant may be missing/unconsented. Sync failed soft; check the workbook-sync page + ledger.`,
    priority: 'high',
    tags: ['warning', 'workbook-sync', 'forbidden', 'dr3-vision'],
    clickUrl: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    fingerprint: `workbook-sync-forbidden-${siteId}`,
    cooldownMs: 30 * 60 * 1000,
  });
}

async function pageError(siteId: string, message: string): Promise<void> {
  await publishNtfy({
    topic: 'dr3-vision-system',
    title: 'Workbook sync error',
    body: `${message}\n\nThe workbook sync for site ${siteId} failed. Check the workbook-sync container + the sync ledger.`,
    priority: 'high',
    tags: ['error', 'workbook-sync', 'dr3-vision'],
    clickUrl: 'https://noc-mastercontrol.barnardhq.com/status/dr3-vision',
    fingerprint: `workbook-sync-error-${siteId}`,
    cooldownMs: 30 * 60 * 1000,
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}
