import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SYNC_MAX_PAGES,
  DEFAULT_SYNC_PAGE_SIZE,
  fetchNewestFirstListPage,
  OFFSET_CEILING,
  paginationFromEnv,
  plannedOffsets,
  type PaginatedListResult,
} from './list-sync-client';
import type { BackfillSession } from './backfill-portal-client';
import type { AuraFrameworkParams } from './list-page';
import { PortalContractDriftError } from './portal-client';

const FRAMEWORK: AuraFrameworkParams = {
  auraContext: '{"fwuid":"x"}',
  auraToken: 'tok',
  auraPageUri: '/s/processed-materials',
};

/** A synthetic `getItems` SUCCESS envelope (the live response shape). */
function getItemsBody(
  ids: readonly string[],
  hasMoreData: boolean,
  totalCount: number | null,
): string {
  return JSON.stringify({
    actions: [
      {
        id: 'a',
        state: 'SUCCESS',
        returnValue: {
          recordIdActionsList: ids.map((recordId) => ({ recordId })),
          hasMoreData,
          offset: ids.length,
          filterTitle: 'All Active Processed Materials',
          ...(totalCount === null ? {} : { totalCount }),
        },
      },
    ],
  });
}

/**
 * A fake session that serves a scripted sequence of pages and records the
 * `message` of every POST so the request params can be asserted.
 */
function fakeSession(
  pages: ReadonlyArray<{ ids: string[]; hasMoreData: boolean; total?: number | null }>,
): {
  session: BackfillSession;
  sent: Record<string, string>[];
} {
  const sent: Record<string, string>[] = [];
  let i = 0;
  const session: BackfillSession = {
    captureListPage: vi.fn(async () => ({
      framework: FRAMEWORK,
      requestMessages: [],
      responseBodies: [],
    })),
    postGetItems: vi.fn(async (formFields: Record<string, string>) => {
      sent.push(formFields);
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      if (!page) throw new Error('no scripted page');
      // `in` rather than `??` so a test can script an EXPLICIT null totalCount
      // (the portal omitting it) distinctly from "not specified".
      return getItemsBody(page.ids, page.hasMoreData, 'total' in page ? (page.total ?? null) : 985);
    }),
    isLoggedOut: vi.fn(async () => false),
    purgeState: vi.fn(async () => undefined),
  };
  return { session, sent };
}

const envelope = async (): Promise<{ framework: AuraFrameworkParams; filterName: string }> => ({
  framework: FRAMEWORK,
  filterName: '00B4p000005DAqlEAG',
});

function paramsOf(formFields: Record<string, string>): Record<string, unknown> {
  const message = JSON.parse(formFields['message'] ?? '{}') as {
    actions?: Array<{ params?: Record<string, unknown> }>;
  };
  return message.actions?.[0]?.params ?? {};
}

// ── plannedOffsets: the walk is finite and respects the portal ceiling ───────

describe('plannedOffsets — a provably finite walk', () => {
  it('tiles offsets by page size', () => {
    expect(plannedOffsets(200, 4)).toEqual([0, 200, 400, 600]);
  });

  it('never plans an offset past the getItems OFFSET ceiling', () => {
    const offsets = plannedOffsets(500, 20);
    expect(offsets[offsets.length - 1]).toBeLessThanOrEqual(OFFSET_CEILING);
    expect(offsets).toEqual([0, 500, 1000, 1500, 2000]);
  });

  it('clamps degenerate inputs instead of producing an empty or infinite plan', () => {
    expect(plannedOffsets(0, 0)).toEqual([0]);
    expect(plannedOffsets(-5, -5)).toEqual([0]);
  });
});

// ── paginationFromEnv: a typo must be visible, never silently ignored ────────

describe('paginationFromEnv — operator knobs', () => {
  it('falls back to the defaults when unset', () => {
    expect(paginationFromEnv({})).toEqual({
      pageSize: DEFAULT_SYNC_PAGE_SIZE,
      maxPages: DEFAULT_SYNC_MAX_PAGES,
    });
  });

  it('reads a valid catch-up budget', () => {
    expect(paginationFromEnv({ MYMRC_LIST_PAGE_SIZE: '2000', MYMRC_LIST_MAX_PAGES: '2' })).toEqual({
      pageSize: 2000,
      maxPages: 2,
    });
  });

  it('WARNS and falls back on a non-positive or unparseable value', () => {
    const log = vi.fn();
    expect(
      paginationFromEnv({ MYMRC_LIST_PAGE_SIZE: 'lots', MYMRC_LIST_MAX_PAGES: '0' }, log),
    ).toEqual({
      pageSize: DEFAULT_SYNC_PAGE_SIZE,
      maxPages: DEFAULT_SYNC_MAX_PAGES,
    });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.every((c) => c[0] === 'warn')).toBe(true);
  });
});

// ── the walk itself ──────────────────────────────────────────────────────────

describe('fetchNewestFirstListPage — sorts NEWEST-first', () => {
  it('requests sortBy:-Id with getCount on every page (the whole point)', async () => {
    const { session, sent } = fakeSession([{ ids: ['a', 'b'], hasMoreData: false }]);
    await fetchNewestFirstListPage(session, 'processed', envelope, { pageSize: 2, maxPages: 3 });
    expect(sent).toHaveLength(1);
    const p = paramsOf(sent[0] as Record<string, string>);
    expect(p['sortBy']).toBe('-Id');
    expect(p['getCount']).toBe(true);
    expect(p['offset']).toBe(0);
    expect(p['pageSize']).toBe(2);
    expect(p['entityName']).toBe('Materials__c');
  });

  it('walks successive offsets while hasMoreData is true', async () => {
    const { session, sent } = fakeSession([
      { ids: ['a', 'b'], hasMoreData: true },
      { ids: ['c', 'd'], hasMoreData: true },
      { ids: ['e', 'f'], hasMoreData: false },
    ]);
    const r = await fetchNewestFirstListPage(session, 'processed', envelope, {
      pageSize: 2,
      maxPages: 5,
    });
    expect(sent.map((f) => paramsOf(f)['offset'])).toEqual([0, 2, 4]);
    expect(r.ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(r.pagesWalked).toBe(3);
  });

  it('reports complete ONLY when the portal says the view is drained', async () => {
    const drained = fakeSession([{ ids: ['a'], hasMoreData: false, total: 1 }]);
    const walked = await fetchNewestFirstListPage(drained.session, 'processed', envelope, {
      pageSize: 1,
      maxPages: 1,
    });
    expect(walked).toMatchObject<Partial<PaginatedListResult>>({
      complete: true,
      stopReason: 'drained',
    });

    const capped = fakeSession([{ ids: ['a'], hasMoreData: true }]);
    const r = await fetchNewestFirstListPage(capped.session, 'processed', envelope, {
      pageSize: 1,
      maxPages: 1,
    });
    // complete:false is what makes the sync SKIP disappeared-detection, so a
    // capped walk must never claim completeness.
    expect(r).toMatchObject<Partial<PaginatedListResult>>({
      complete: false,
      stopReason: 'page_cap',
    });
  });

  it('stops at the page cap rather than paging forever on a portal that always says hasMoreData', async () => {
    const { session, sent } = fakeSession([{ ids: ['x'], hasMoreData: true }]);
    const r = await fetchNewestFirstListPage(session, 'outbound', envelope, {
      pageSize: 1,
      maxPages: 4,
    });
    expect(sent).toHaveLength(4);
    expect(r.pagesWalked).toBe(4);
    expect(r.complete).toBe(false);
  });

  it('deduplicates ids repeated across pages', async () => {
    const { session } = fakeSession([
      { ids: ['a', 'b'], hasMoreData: true },
      { ids: ['b', 'c'], hasMoreData: false },
    ]);
    const r = await fetchNewestFirstListPage(session, 'processed', envelope, {
      pageSize: 2,
      maxPages: 3,
    });
    expect(r.ids).toEqual(['a', 'b', 'c']);
  });

  it('stops on an empty page instead of spinning, and does not claim complete', async () => {
    const { session, sent } = fakeSession([{ ids: [], hasMoreData: true }]);
    const r = await fetchNewestFirstListPage(session, 'processed', envelope, {
      pageSize: 5,
      maxPages: 4,
    });
    expect(sent).toHaveLength(1);
    expect(r).toMatchObject<Partial<PaginatedListResult>>({
      complete: false,
      stopReason: 'empty_page',
    });
  });

  // Regression: the live 2026-07-31 observation that `hasMoreData:false` lies
  // when the page hits the portal's 2000 cap. Trusting it hands the sync engine
  // complete:true for a partial list, and disappeared-detection then stamps every
  // unseen record as gone.
  it('refuses to call a list complete when it holds fewer ids than totalCount', async () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `id-${i}`);
    const { session } = fakeSession([{ ids, hasMoreData: false, total: 4559 }]);
    const r = await fetchNewestFirstListPage(session, 'outbound', envelope, {
      pageSize: 2000,
      maxPages: 1,
    });
    expect(r.ids).toHaveLength(2000);
    expect(r.totalCount).toBe(4559);
    expect(r.stopReason).toBe('short_of_total');
    expect(r.complete).toBe(false);
  });

  it('accepts drained when the ids account for the whole view', async () => {
    const ids = Array.from({ length: 985 }, (_, i) => `id-${i}`);
    const { session } = fakeSession([{ ids, hasMoreData: false, total: 985 }]);
    const r = await fetchNewestFirstListPage(session, 'processed', envelope, {
      pageSize: 2000,
      maxPages: 1,
    });
    expect(r.stopReason).toBe('drained');
    expect(r.complete).toBe(true);
  });

  it('trusts hasMoreData when the portal supplies no totalCount', async () => {
    const { session } = fakeSession([{ ids: ['a'], hasMoreData: false, total: null }]);
    const r = await fetchNewestFirstListPage(session, 'processed', envelope, {
      pageSize: 5,
      maxPages: 1,
    });
    expect(r.complete).toBe(true);
  });

  it('surfaces the view totalCount', async () => {
    const { session } = fakeSession([{ ids: ['a'], hasMoreData: false, total: 4559 }]);
    const r = await fetchNewestFirstListPage(session, 'outbound', envelope, {
      pageSize: 1,
      maxPages: 1,
    });
    expect(r.totalCount).toBe(4559);
  });

  it('propagates a contract-drift parse failure rather than returning a silent empty', async () => {
    const session: BackfillSession = {
      captureListPage: vi.fn(async () => ({
        framework: FRAMEWORK,
        requestMessages: [],
        responseBodies: [],
      })),
      postGetItems: vi.fn(async () => '{"actions":[]}'),
      isLoggedOut: vi.fn(async () => false),
      purgeState: vi.fn(async () => undefined),
    };
    await expect(
      fetchNewestFirstListPage(session, 'processed', envelope, { pageSize: 1, maxPages: 1 }),
    ).rejects.toBeInstanceOf(PortalContractDriftError);
  });

  it('routes each feed to its own object', async () => {
    for (const [feed, entity] of [
      ['hauls', 'Haul_Request__c'],
      ['processed', 'Materials__c'],
      ['outbound', 'Materials__c'],
    ] as const) {
      const { session, sent } = fakeSession([{ ids: ['a'], hasMoreData: false }]);
      await fetchNewestFirstListPage(session, feed, envelope, { pageSize: 1, maxPages: 1 });
      expect(paramsOf(sent[0] as Record<string, string>)['entityName']).toBe(entity);
    }
  });
});
