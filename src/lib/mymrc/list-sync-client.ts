// Steady-state NEWEST-FIRST paginating list transport (2026-07-31).
//
// THE DEFECT THIS REPLACES. The steady-state list transport in portal-client.ts
// (`createPortalClient().fetchListRecordIds`) is PASSIVE: it navigates the list
// page and reads whichever `getItems` window the portal's own UI happened to
// fire. That window is the list view's DEFAULT sort — and the default sort is
// ASCENDING, so the window is pinned to the OLDEST records in the view, forever.
//
// MEASURED LIVE 2026-07-31 (read-only probe against mrc-us.my.site.com):
//   processed_active  default sort ≡ sortBy:'Id'  → M-000300@2024-03-01 …
//   outbound_active   default sort (ascending)    → M-000264@2024-03-01 …
// Both views carry `hasMoreData:true` (totalCount 985 / 4559), so the sync saw
// page 0 of an ascending list every hour: 50 ids it already held, 0 details to
// fetch, `ok`. The mirror's newest row stayed frozen at 2026-07-22 for 9 days
// while every run reported success.
//
// THE FIX. Stop reading whatever the UI fired; REPLAY `getItems` explicitly with
// `sortBy:'-Id'` and walk a bounded number of offset pages. `-Id` is descending
// Record ID — for a Salesforce custom object the id sequence increases with
// record CREATION, so descending id surfaces the most-recently-CREATED records
// first. VERIFIED LIVE on the same probe: `-Id` page 0 returned M-183347/M-183165/
// M-182964 (entry dates 2026-07-29/28/27) for processed and M-183448/M-183447/
// M-183446 (2026-07-30) for outbound — none of which existed in the mirror.
//
// NOTE ON ORDERING PRECISION: `-Id` orders by CREATION, not by the business date
// column. The same probe showed outbound id M-183449 carrying entry_date
// 2026-07-23 while lower ids carried 2026-07-30 — creation order and entry_date
// are correlated but NOT identical. That is fine for this transport's purpose
// (reach recently-created records so they enter the mirror); it is NOT a claim
// that page 0 holds the N greatest entry_dates, and nothing here depends on that.
//
// Bundle constraint: compiles standalone via tsconfig.mymrc.json — no `@/…`.

import type { BackfillSession } from './backfill-portal-client';
import {
  BACKFILL_LIST_VIEWS,
  buildGetItemsFormFields,
  correlateCapturedListViews,
  parseGetItemsResponse,
  resolveFilterName,
  type AuraFrameworkParams,
  type CapturedListView,
} from './list-page';
import {
  PortalContractDriftError,
  type ListRecordIdsResult,
  type PortalClient,
} from './portal-client';
import type { FeedName } from './types';

export type Logger = (level: 'info' | 'warn' | 'error', message: string) => void;
const noopLog: Logger = () => undefined;

/** Descending Record ID — most-recently-created first (see header). */
const SORT_NEWEST_FIRST = '-Id';

/**
 * The SOQL `OFFSET` ceiling the portal enforces (CONFIRMED live 2026-07-22,
 * list-page.ts): a request past this returns a degenerate SUCCESS with no
 * records. The walk refuses to issue such a request.
 */
export const OFFSET_CEILING = 2_000;

/** Records per page. Modest by default — the steady state only needs the recent head. */
export const DEFAULT_SYNC_PAGE_SIZE = 200;

/**
 * Pages walked per feed per run. 4 × 200 = the 800 most-recently-created records,
 * which is ~3 orders of magnitude more headroom than the observed daily record
 * rate. Raise (with `pageSize`) for a bounded catch-up — see docs.
 */
export const DEFAULT_SYNC_MAX_PAGES = 4;

/** Which list view each steady-state feed pages, and the page that yields its envelope. */
interface FeedBinding {
  objectApiName: string;
  slug: string;
  listPagePath: string;
}

const FEED_BINDINGS: Readonly<Record<FeedName, FeedBinding>> = {
  hauls: {
    objectApiName: 'Haul_Request__c',
    slug: 'docking_appointments_rc',
    listPagePath: '/s/hauls',
  },
  processed: {
    objectApiName: 'Materials__c',
    slug: 'processed_active',
    listPagePath: '/s/processed-materials',
  },
  outbound: {
    objectApiName: 'Materials__c',
    slug: 'outbound_active',
    listPagePath: '/s/outbound-materials',
  },
};

export interface PaginatedListOptions {
  /** Records per getItems page (default {@link DEFAULT_SYNC_PAGE_SIZE}). */
  pageSize?: number;
  /** Max pages per feed per run (default {@link DEFAULT_SYNC_MAX_PAGES}). */
  maxPages?: number;
  /** Operator override `{ slug → list-view id }`, same precedence as the backfill. */
  listViewOverrides?: Readonly<Record<string, string>>;
  log?: Logger;
}

/**
 * Read `pageSize` / `maxPages` from the environment, falling back to the
 * defaults. Invalid or non-positive values fall back rather than throwing — an
 * unparseable knob must not take the sync down — but they WARN, so a typo is
 * visible instead of silently reverting to the default.
 */
export function paginationFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  log: Logger = noopLog,
): { pageSize: number; maxPages: number } {
  const read = (key: string, fallback: number): number => {
    const raw = env[key]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      log('warn', `mymrc: ${key}="${raw}" is not a positive integer — using ${fallback}`);
      return fallback;
    }
    return n;
  };
  return {
    pageSize: read('MYMRC_LIST_PAGE_SIZE', DEFAULT_SYNC_PAGE_SIZE),
    maxPages: read('MYMRC_LIST_MAX_PAGES', DEFAULT_SYNC_MAX_PAGES),
  };
}

/**
 * The offsets a bounded newest-first walk will request, in order. Pure, so the
 * walk's termination is provable by inspection: the sequence is finite
 * (`maxPages` entries at most) and never exceeds {@link OFFSET_CEILING}.
 */
export function plannedOffsets(pageSize: number, maxPages: number): number[] {
  const size = Math.max(1, Math.trunc(pageSize));
  const pages = Math.max(1, Math.trunc(maxPages));
  const out: number[] = [];
  for (let i = 0; i < pages; i++) {
    const offset = i * size;
    if (offset > OFFSET_CEILING) break;
    out.push(offset);
  }
  return out;
}

/** A page of the newest-first walk, plus why the walk stopped. */
export interface PaginatedListResult extends ListRecordIdsResult {
  /** Pages actually requested. */
  pagesWalked: number;
  /** The view's absolute record count (`getCount:true`), or null if absent. */
  totalCount: number | null;
  /** Why the walk ended — surfaced on the run log so a capped walk is never silent. */
  stopReason: 'drained' | 'page_cap' | 'offset_ceiling' | 'empty_page' | 'short_of_total';
}

/**
 * Page one feed newest-first over an injectable {@link BackfillSession}.
 *
 * Termination is structural: the loop iterates {@link plannedOffsets}, a finite
 * precomputed list, and additionally breaks on a drained view or an empty page.
 * There is no condition under which it loops unbounded.
 *
 * `complete` is true ONLY when the portal reported the view drained
 * (`hasMoreData:false`) within the page budget. A capped walk returns
 * `complete:false`, which the sync engine already treats as "do not run
 * disappeared-detection" — so widening the window never risks over-marking.
 */
export async function fetchNewestFirstListPage(
  session: BackfillSession,
  feed: FeedName,
  ensureEnvelope: (path: string) => Promise<{ framework: AuraFrameworkParams; filterName: string }>,
  opts: PaginatedListOptions = {},
): Promise<PaginatedListResult> {
  const log = opts.log ?? noopLog;
  const pageSize = Math.max(1, Math.trunc(opts.pageSize ?? DEFAULT_SYNC_PAGE_SIZE));
  const maxPages = Math.max(1, Math.trunc(opts.maxPages ?? DEFAULT_SYNC_MAX_PAGES));
  const binding = FEED_BINDINGS[feed];

  const { framework, filterName } = await ensureEnvelope(binding.listPagePath);

  const seen = new Set<string>();
  const ids: string[] = [];
  let totalCount: number | null = null;
  let pagesWalked = 0;
  let stopReason: PaginatedListResult['stopReason'] = 'page_cap';

  const offsets = plannedOffsets(pageSize, maxPages);
  // A page budget that cannot reach the whole view is normal; a budget CLIPPED by
  // the portal's offset ceiling is worth saying out loud, because it caps how far
  // back a catch-up can ever reach with this page size.
  if (offsets.length < maxPages) {
    log(
      'warn',
      `mymrc: ${feed} page budget ${maxPages}×${pageSize} exceeds the getItems OFFSET ceiling ` +
        `(${OFFSET_CEILING}); walking ${offsets.length} page(s). Use a larger pageSize to reach further back.`,
    );
  }

  for (const offset of offsets) {
    const formFields = buildGetItemsFormFields(
      framework,
      {
        entityName: binding.objectApiName,
        filterName,
        offset,
        pageSize,
        sortBy: SORT_NEWEST_FIRST,
        getCount: true,
      },
      `sync-${feed}-${offset}`,
    );
    const page = parseGetItemsResponse(await session.postGetItems(formFields));
    pagesWalked += 1;
    if (page.totalCount !== null) totalCount = page.totalCount;

    for (const id of page.recordIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }

    if (page.recordIds.length === 0) {
      // A page with no records and more claimed is a contract we don't understand;
      // stop rather than spin, and let `complete:false` keep the money-safe path.
      stopReason = 'empty_page';
      break;
    }
    if (!page.hasMoreData) {
      stopReason = 'drained';
      break;
    }
    if (offset === offsets[offsets.length - 1] && offsets.length < maxPages) {
      stopReason = 'offset_ceiling';
    }
  }

  // `hasMoreData:false` IS NOT PROOF THE VIEW IS DRAINED. Observed live
  // 2026-07-31: `outbound_active` at pageSize 2000 returned 2000 ids with
  // `hasMoreData:false` while `totalCount` was 4559 — the portal clamps the page
  // to its 2000 cap and then reports no-more-data. Trusting that would hand the
  // sync engine `complete:true` for a 44%-complete list, and `markDisappeared`
  // would stamp the 2559 unseen records as gone. `totalCount` is the independent
  // check, so completeness requires BOTH signals to agree.
  const shortOfTotal = totalCount !== null && ids.length < totalCount;
  if (stopReason === 'drained' && shortOfTotal) {
    stopReason = 'short_of_total';
    log(
      'warn',
      `mymrc: ${feed} reported hasMoreData=false after ${ids.length} id(s) but the view holds ` +
        `${totalCount} — treating the list as INCOMPLETE (disappeared-detection stays off).`,
    );
  }

  log(
    'info',
    `mymrc: ${feed} newest-first list → ${ids.length} id(s) over ${pagesWalked} page(s) ` +
      `(pageSize=${pageSize}, totalCount=${totalCount ?? 'n/a'}, stop=${stopReason})`,
  );

  return { ids, complete: stopReason === 'drained', pagesWalked, totalCount, stopReason };
}

/**
 * Wrap an existing {@link PortalClient} so its list pass pages NEWEST-FIRST
 * instead of reading the UI's default (oldest-first) window. Auth, the
 * stale-session self-heal, and the detail transport are untouched — this
 * replaces ONLY `fetchListRecordIds`.
 *
 * The Aura envelope + list-view id are captured lazily per list page and cached
 * for the run, exactly as the backfill client does.
 */
export function withNewestFirstList(
  client: PortalClient,
  session: BackfillSession,
  opts: PaginatedListOptions = {},
): PortalClient {
  const log = opts.log ?? noopLog;
  const overrides = opts.listViewOverrides ?? {};
  let framework: AuraFrameworkParams | null = null;
  const capturedViews: CapturedListView[] = [];
  const capturedPaths = new Set<string>();

  async function ensureEnvelope(
    path: string,
  ): Promise<{ framework: AuraFrameworkParams; filterName: string }> {
    if (!capturedPaths.has(path)) {
      const cap = await session.captureListPage(path);
      capturedPaths.add(path);
      if (cap.framework && !framework) framework = cap.framework;
      for (const v of correlateCapturedListViews(cap.requestMessages, cap.responseBodies)) {
        if (
          !capturedViews.some((c) => c.entityName === v.entityName && c.filterName === v.filterName)
        ) {
          capturedViews.push(v);
        }
      }
    }
    if (!framework) {
      throw new PortalContractDriftError(
        `mymrc: no Aura framework envelope captured from ${path} — cannot replay a sorted getItems`,
      );
    }
    return { framework, filterName: '' };
  }

  return {
    ...client,
    async fetchListRecordIds(feed: FeedName): Promise<ListRecordIdsResult> {
      const binding = FEED_BINDINGS[feed];
      const viewBinding = BACKFILL_LIST_VIEWS.find(
        (b) => b.objectApiName === binding.objectApiName && b.slug === binding.slug,
      );
      if (!viewBinding) {
        throw new PortalContractDriftError(
          `mymrc: no list-view binding for feed "${feed}" (${binding.objectApiName}/${binding.slug})`,
        );
      }

      const resolved = await ensureEnvelope(binding.listPagePath);
      const filterName = resolveFilterName(viewBinding, capturedViews, overrides);
      if (!filterName) {
        // Never guess a transport id, and never fall back to the passive
        // oldest-first window — that is the defect this module exists to kill.
        throw new PortalContractDriftError(
          `mymrc: could not resolve the list-view id for feed "${feed}" ` +
            `(${binding.objectApiName}/${binding.slug}, "${viewBinding.filterTitle}") — ` +
            `not captured at runtime, no observed id, no override.`,
        );
      }

      const result = await fetchNewestFirstListPage(
        session,
        feed,
        async () => ({ framework: resolved.framework, filterName }),
        { ...opts, log },
      );
      return { ids: result.ids, complete: result.complete };
    },
  };
}
