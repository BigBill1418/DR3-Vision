// ADR-0057 Phase 1 (D3) — WINDOWED HISTORICAL BACKFILL worker.
//
// Phase 0 discovery captured only the FIRST list-view window per object
// (Haul_Request__c ≥79, Materials__c ≥100, both `hasMoreData:true` — a floor,
// NOT a total). The hourly `syncFeed` engine also reads only the first window
// (its list pass takes whatever `getItems` returns on load). Neither reaches the
// tail of the history. THIS worker does: for each (object, list-view) it drives
// the Aura `getItems` pagination (`currentPage` / `hasMoreData`) to the LAST
// page, upserting every record id into its mirror, then fills the detail for
// every mirror row still lacking it. Once every cursor is drained the hourly
// sync maintains steady state and this worker is idle.
//
// Design invariants (money-adjacent — correctness/reliability over speed):
//   • RESUMABLE — a durable cursor per (object, list-view) records the last
//     COMPLETED page. A crash resumes at last_page_index+1; a page is never
//     silently skipped (a pre-page-0 wedge writes last_page_index=-1 so resume
//     recomputes page 0, not page 1).
//   • IDEMPOTENT — every write is an upsert keyed by the Salesforce record id;
//     re-running a drained cursor is a no-op; re-doing an interrupted page
//     re-upserts the same rows without double-storing. `records_completed`
//     counts listed rows across completed pages (a progress metric, not a
//     distinct-record count — the two list views of an object may overlap).
//   • BOUNDED — detail fetches run through a strict ≤N pool (default 3), the
//     same politeness budget the hourly sync honours.
//   • COMPLETE — pagination stops ONLY on `hasMoreData:false`; a safety cap
//     (`maxPages`) converts a portal that never terminates into a loud wedge
//     rather than an infinite loop.
//   • FAIL-LOUD — a pagination wedge or an auth failure persists the human
//     error text onto the cursor AND pages ntfy (ADR-0036/0037, Bill-only
//     `dr3-vision-system`). Transient per-record detail failures are NOT a
//     wedge: they leave `detail_fetched_at` NULL and are retried on the next
//     backfill run (identical philosophy to the hourly sync's detail retry).
//
// Bundle constraint: this file compiles standalone via tsconfig.mymrc.json
// (rootDir src/lib/mymrc) — it CANNOT import `@/…` or `@/lib/prisma`. The
// PrismaClient is injected (type-only `@prisma/client` import), exactly as
// sync.ts does. Mirror-column knowledge lives entirely in the injected
// BackfillTarget (see backfill-targets.ts), so this engine is portal- and
// schema-agnostic and is unit-tested against fakes with zero DB / Playwright.

import type { PrismaClient } from '@prisma/client';
import { AuthFailedError } from './portal-client';
import { ntfyPager, type Pager } from './ntfy';
import type { SfRecord } from './types';

const DETAIL_CONCURRENCY = 3;
// A misbehaving portal that always returns hasMoreData:true must wedge loudly,
// never spin forever. 10k pages ≫ any plausible history for these objects.
const MAX_PAGES = 10_000;

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

// ── Injected collaborators ───────────────────────────────────────────────────

/** One page of an Aura list view: the record ids on it + the windowed flag. */
export interface BackfillListPage {
  ids: string[];
  /** `true` ⇒ more pages exist beyond this one (Aura `getItems.hasMoreData`). */
  hasMoreData: boolean;
}

/**
 * The transport surface the backfill engine depends on. The production impl is
 * the Playwright portal client (driven page-by-page); tests substitute a fake.
 * Kept separate from `PortalClient` because backfill needs an explicit
 * `pageIndex` the steady-state sync never uses.
 */
export interface BackfillPortalClient {
  /** Fetch one 0-based page of a list view. Throws AuthFailedError when logged out. */
  fetchListPage(objectApiName: string, listViewApiName: string, pageIndex: number): Promise<BackfillListPage>;
  /** Fetch one record's detail representation. Throws AuthFailedError when logged out. */
  fetchRecordDetail(recordId: string): Promise<SfRecord>;
}

/**
 * A single (object, list-view) backfill unit. Carries ALL mirror-column
 * knowledge so the engine stays schema-agnostic. `objectApiName` +
 * `listViewApiName` are the cursor key (list_view_api_name is a DR3-internal
 * slug, `''` for single-view objects). Both hauls list views bind to the same
 * mirror; their detail sweeps dedup naturally because `idsNeedingDetail` reads
 * `detail_fetched_at IS NULL` and the engine runs targets sequentially.
 */
export interface BackfillTarget {
  objectApiName: string;
  listViewApiName: string;
  /** Idempotently create id-only mirror rows for these ids (never clears detail_fetched_at). */
  upsertListed(ids: readonly string[], seenAt: Date): Promise<number>;
  /** Mirror rows for this target still lacking a detail fetch (resumable detail cursor). */
  idsNeedingDetail(): Promise<string[]>;
  /** Idempotently persist one record's detail into its mirror + stamp detail_fetched_at. */
  writeDetail(record: SfRecord, at: Date): Promise<void>;
}

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * - `complete`   — pagination drained AND no mirror row is missing detail.
 * - `incomplete` — progress made but detail gaps remain (transient failures);
 *                   a later run drains them. NOT paged (matches sync retry).
 * - `auth_failed`— session logged out mid-run. Paged.
 * - `error`      — pagination wedged (persisted to cursor). Paged.
 */
export type BackfillStatus = 'complete' | 'incomplete' | 'auth_failed' | 'error';

export interface BackfillTargetResult {
  objectApiName: string;
  listViewApiName: string;
  status: BackfillStatus;
  /** Pages fetched in THIS run (not cumulative). */
  pagesThisRun: number;
  /** Record ids listed (upserted) in THIS run. */
  recordsListedThisRun: number;
  detailsFetched: number;
  detailFailures: number;
  /** `true` once the pagination cursor is drained (completed_at set), now or earlier. */
  paginationComplete: boolean;
  error: string | null;
}

export interface BackfillResult {
  targets: BackfillTargetResult[];
  /** Every target reached `complete`. */
  complete: boolean;
}

// ── Engine context ───────────────────────────────────────────────────────────

export interface BackfillContext {
  prisma: PrismaClient;
  client: BackfillPortalClient;
  targets: readonly BackfillTarget[];
  pager?: Pager;
  log?: Logger;
  now?: () => Date;
  detailConcurrency?: number;
  maxPages?: number;
}

// ── Cursor plumbing ──────────────────────────────────────────────────────────

interface CursorSnapshot {
  last_page_index: number;
  last_record_id: string | null;
  records_completed: number;
  completed_at: Date | null;
  started_at: Date;
}

function cursorWhere(objectApiName: string, listViewApiName: string) {
  return { object_api_name_list_view_api_name: { object_api_name: objectApiName, list_view_api_name: listViewApiName } };
}

async function readCursor(
  prisma: PrismaClient,
  objectApiName: string,
  listViewApiName: string,
): Promise<CursorSnapshot | null> {
  const row = await prisma.mymrcBackfillCursor.findUnique({
    where: cursorWhere(objectApiName, listViewApiName),
    select: {
      last_page_index: true,
      last_record_id: true,
      records_completed: true,
      completed_at: true,
      started_at: true,
    },
  });
  return row;
}

/** Persist a completed page (clears any prior error). Returns the fresh snapshot. */
async function persistProgress(
  prisma: PrismaClient,
  objectApiName: string,
  listViewApiName: string,
  data: {
    lastPageIndex: number;
    lastRecordId: string | null;
    recordsCompleted: number;
    completedAt: Date | null;
    startedAt: Date;
  },
): Promise<void> {
  await prisma.mymrcBackfillCursor.upsert({
    where: cursorWhere(objectApiName, listViewApiName),
    create: {
      object_api_name: objectApiName,
      list_view_api_name: listViewApiName,
      last_page_index: data.lastPageIndex,
      last_record_id: data.lastRecordId,
      records_completed: data.recordsCompleted,
      // While windowed this is the running floor; at drain it is exact.
      total_records_estimated: data.recordsCompleted,
      completed_at: data.completedAt,
      started_at: data.startedAt,
      error: null,
    },
    update: {
      last_page_index: data.lastPageIndex,
      last_record_id: data.lastRecordId,
      records_completed: data.recordsCompleted,
      total_records_estimated: data.recordsCompleted,
      completed_at: data.completedAt,
      error: null,
    },
  });
}

/**
 * Persist a wedge error WITHOUT disturbing pagination progress. On a pre-page-0
 * wedge (no cursor yet) create with last_page_index=-1 so resume recomputes
 * page 0 (default 0 would skip it).
 */
async function persistError(
  prisma: PrismaClient,
  objectApiName: string,
  listViewApiName: string,
  message: string,
  startedAt: Date,
): Promise<void> {
  await prisma.mymrcBackfillCursor
    .upsert({
      where: cursorWhere(objectApiName, listViewApiName),
      create: {
        object_api_name: objectApiName,
        list_view_api_name: listViewApiName,
        last_page_index: -1,
        started_at: startedAt,
        error: message,
      },
      update: { error: message },
    })
    .catch(() => undefined); // a cursor-write failure must never mask the original wedge
}

// ── Bounded detail pool (strict ≤ limit in flight) ───────────────────────────

/**
 * Run `worker` over `items` with at most `limit` in flight. `worker` owns its
 * own error handling EXCEPT it may throw to abort the whole pool (used for a
 * fatal AuthFailedError). Concurrency is capped by the runner count, so no more
 * than `limit` calls are ever outstanding.
 */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const size = Math.max(1, limit);
  let index = 0;
  let aborted = false;
  const runner = async (): Promise<void> => {
    while (!aborted && index < items.length) {
      const item = items[index];
      index += 1;
      if (item === undefined) continue;
      try {
        await worker(item);
      } catch (err) {
        aborted = true; // stop scheduling; propagate the fatal error
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, runner));
}

// ── One target ───────────────────────────────────────────────────────────────

async function pageTarget(
  ctx: BackfillContext,
  target: BackfillTarget,
  now: Date,
  log: Logger,
): Promise<{ ok: true; recordsListed: number; pages: number; drained: boolean } | { ok: false; auth: boolean; message: string }> {
  const { objectApiName, listViewApiName } = target;
  const maxPages = ctx.maxPages ?? MAX_PAGES;
  const cursor = await readCursor(ctx.prisma, objectApiName, listViewApiName);

  if (cursor?.completed_at) {
    return { ok: true, recordsListed: 0, pages: 0, drained: true };
  }

  const startedAt = cursor?.started_at ?? now;
  let pageIndex = cursor ? cursor.last_page_index + 1 : 0;
  let runningCompleted = cursor?.records_completed ?? 0;
  let lastRecordId = cursor?.last_record_id ?? null;
  let recordsListed = 0;
  let pages = 0;

  try {
    for (;;) {
      if (pageIndex >= maxPages) {
        throw new Error(
          `pagination exceeded maxPages=${maxPages} at page ${pageIndex} — portal never returned hasMoreData:false`,
        );
      }
      const page = await ctx.client.fetchListPage(objectApiName, listViewApiName, pageIndex);
      await target.upsertListed(page.ids, now);
      runningCompleted += page.ids.length;
      recordsListed += page.ids.length;
      if (page.ids.length > 0) {
        const tail = page.ids[page.ids.length - 1];
        if (tail !== undefined) lastRecordId = tail;
      }
      const drained = !page.hasMoreData;
      await persistProgress(ctx.prisma, objectApiName, listViewApiName, {
        lastPageIndex: pageIndex,
        lastRecordId,
        recordsCompleted: runningCompleted,
        completedAt: drained ? now : null,
        startedAt,
      });
      pages += 1;
      log('info', `mymrc-backfill: ${objectApiName}/${listViewApiName || '(default)'} page ${pageIndex} → ${page.ids.length} ids (drained=${drained})`);
      if (drained) return { ok: true, recordsListed, pages, drained: true };
      pageIndex += 1;
    }
  } catch (err) {
    if (err instanceof AuthFailedError) {
      // Auth is transient (session expiry); do NOT persist as a cursor error —
      // the cursor stays clean and a re-auth'd run resumes at the same page.
      return { ok: false, auth: true, message: err.message };
    }
    const message = describe(err);
    await persistError(ctx.prisma, objectApiName, listViewApiName, message, startedAt);
    return { ok: false, auth: false, message };
  }
}

async function sweepDetail(
  ctx: BackfillContext,
  target: BackfillTarget,
  now: Date,
  log: Logger,
): Promise<{ fetched: number; failures: number; auth: boolean; authMessage: string }> {
  const pending = await target.idsNeedingDetail();
  const concurrency = ctx.detailConcurrency ?? DETAIL_CONCURRENCY;
  let fetched = 0;
  let failures = 0;
  let auth = false;
  let authMessage = '';

  try {
    await runPool(pending, concurrency, async (id) => {
      try {
        const record = await ctx.client.fetchRecordDetail(id);
        await target.writeDetail(record, now);
        fetched += 1;
      } catch (err) {
        if (err instanceof AuthFailedError) {
          auth = true;
          authMessage = err.message;
          throw err; // abort the pool — the whole session is dead
        }
        failures += 1;
        log(
          'warn',
          `mymrc-backfill: ${target.objectApiName} detail ${id} failed (retry next run): ${describe(err)}`,
        );
      }
    });
  } catch {
    // Only an AuthFailedError re-thrown from the worker reaches here (the `auth`
    // flag is already set); any other worker error is swallowed above.
  }

  return { fetched, failures, auth, authMessage };
}

async function runTarget(ctx: BackfillContext, target: BackfillTarget, now: Date): Promise<BackfillTargetResult> {
  const log = ctx.log ?? noopLog;
  const pager = ctx.pager ?? ntfyPager;
  const base = {
    objectApiName: target.objectApiName,
    listViewApiName: target.listViewApiName,
    pagesThisRun: 0,
    recordsListedThisRun: 0,
    detailsFetched: 0,
    detailFailures: 0,
  };

  const paged = await pageTarget(ctx, target, now, log);
  if (!paged.ok) {
    if (paged.auth) {
      await pager
        .page({
          kind: 'auth_failed',
          site: target.objectApiName,
          message: `MyMRC backfill logged out paging ${target.objectApiName}/${target.listViewApiName || '(default)'}: ${paged.message}`,
          fingerprint: `mymrc-backfill-auth:${target.objectApiName}`,
        })
        .catch(() => undefined);
      log('error', `mymrc-backfill: ${target.objectApiName} AUTH FAILED — ${paged.message}`);
      return { ...base, status: 'auth_failed', paginationComplete: false, error: paged.message };
    }
    await pager
      .page({
        kind: 'error',
        site: target.objectApiName,
        message: `MyMRC backfill WEDGED on ${target.objectApiName}/${target.listViewApiName || '(default)'} — resumes next run: ${paged.message}`,
        fingerprint: `mymrc-backfill-error:${target.objectApiName}:${target.listViewApiName}`,
      })
      .catch(() => undefined);
    log('error', `mymrc-backfill: ${target.objectApiName} WEDGED — ${paged.message}`);
    return { ...base, status: 'error', paginationComplete: false, error: paged.message };
  }

  base.pagesThisRun = paged.pages;
  base.recordsListedThisRun = paged.recordsListed;

  // Pagination is drained here (pageTarget only returns ok with drained=true).
  const swept = await sweepDetail(ctx, target, now, log);
  base.detailsFetched = swept.fetched;
  base.detailFailures = swept.failures;

  if (swept.auth) {
    await pager
      .page({
        kind: 'auth_failed',
        site: target.objectApiName,
        message: `MyMRC backfill logged out fetching ${target.objectApiName} detail: ${swept.authMessage}`,
        fingerprint: `mymrc-backfill-auth:${target.objectApiName}`,
      })
      .catch(() => undefined);
    log('error', `mymrc-backfill: ${target.objectApiName} AUTH FAILED (detail) — ${swept.authMessage}`);
    return { ...base, status: 'auth_failed', paginationComplete: true, error: swept.authMessage };
  }

  const status: BackfillStatus = swept.failures === 0 ? 'complete' : 'incomplete';
  log(
    'info',
    `mymrc-backfill: ${target.objectApiName}/${target.listViewApiName || '(default)'} ${status} — pages=${base.pagesThisRun} listed=${base.recordsListedThisRun} details=${swept.fetched} failed=${swept.failures}`,
  );
  return { ...base, status, paginationComplete: true, error: null };
}

/**
 * Run the windowed backfill across all targets sequentially (they share one
 * authenticated portal session). A wedged/auth-failed target does NOT stop the
 * others — each is isolated and resumable independently. Never throws.
 */
export async function runBackfill(ctx: BackfillContext): Promise<BackfillResult> {
  const now = (ctx.now ?? ((): Date => new Date()))();
  const results: BackfillTargetResult[] = [];
  for (const target of ctx.targets) {
    results.push(await runTarget(ctx, target, now));
  }
  return { targets: results, complete: results.every((r) => r.status === 'complete') };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
