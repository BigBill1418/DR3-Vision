// ADR-0057 Phase 1 (D3) — the SORT-FLIP transport wired into the backfill engine,
// exercised end-to-end against a FAKE BackfillSession (no Playwright, no live
// portal). The fake is FAITHFUL: it holds each list view's full record set and
// serves a page by sorting (asc/desc by id) + slicing under the LIVE ceilings
// (pageSize == the SOQL OFFSET cap), returning `totalCount` on `getCount:true` —
// exactly what the real getItems does. Tests shrink the page size (2) so the
// 8000-row coverage ceiling becomes 8, making sort-flip observable in-memory.
//
// Proves the money-adjacent contract the whole feature turns on:
//   • sort-flip pages PAST the old offset-2000 (2050-row) truncation — a view
//     larger than one sort direction reaches is fully pulled via asc+desc,
//   • the run stops (completed_at) exactly at the last step totalCount requires,
//   • a view that EXCEEDS sort-flip coverage pages every reachable window then
//     WEDGES LOUD — never a silent cap, never a false "complete",
//   • total_records_estimated is the portal's true totalCount, not the inflated
//     running count (sort-flip windows overlap),
//   • multi-view objects merge deduped by salesforce_record_id,
//   • a mid-object cursor resumes at the next sort-flip step (no re-paged windows),
//   • a list-view id that resolves to NONE fails LOUD (wedge + ntfy),
//   • a logged-out replay maps to auth_failed (clean cursor, transient).

import { describe, expect, it, vi } from 'vitest';
import { createBackfillPortalClient, type BackfillSession } from './backfill-portal-client';
import { runBackfill, type BackfillContext, type BackfillTarget } from './backfill';
import type { RecordFieldsClient } from './record-fields-client';
import type { Pager } from './ntfy';
import type { AuraFrameworkParams } from './list-page';

// Detail is now BATCHED (record-fields-client): this fake serves one SfRecord per
// requested id in a single call and records the ids so the "detailed once" dedup
// (idsNeedingDetail IS NULL + sequential targets) is still asserted end-to-end.
function makeRecordFields(): { client: RecordFieldsClient; requestedIds: () => string[] } {
  const requested: string[] = [];
  return {
    client: {
      fetchRecordFields: vi.fn(async (ids: readonly string[]) => {
        requested.push(...ids);
        return {
          records: new Map(ids.map((id) => [id, { apiName: 'X__c', id, fields: {} }])),
          errors: [],
        };
      }),
    },
    requestedIds: () => requested,
  };
}
// Shared fake for the pagination-focused tests (they don't assert on detail ids).
const RF = makeRecordFields().client;
/** runBackfill with the shared record-fields fake injected (pagination tests). */
const runBF = (args: Omit<BackfillContext, 'recordFields'>): Promise<ReturnType<typeof runBackfill> extends Promise<infer R> ? R : never> =>
  runBackfill({ recordFields: RF, ...args });

const NOW = new Date('2026-08-04T12:00:00.000Z');
const nowFn = (): Date => NOW;
const TEST_PAGE_SIZE = 2; // shrinks the 8000-row live ceiling to 8 for in-memory tests

const FRAMEWORK: AuraFrameworkParams = {
  auraContext: '{"fwuid":"FAKE"}',
  auraToken: 'tok',
  auraPageUri: '/s/hauls',
};

interface Req { sortBy: string | null; offset: number }

/**
 * A FAITHFUL fake session: postGetItems parses (filterName, offset, pageSize,
 * sortBy, getCount) from the replay body and serves the page by sorting the
 * view's record set + slicing — mirroring the live getItems. `requestsByFilter`
 * records every (sortBy, offset) so the sort-flip plan is asserted directly.
 */
function makeSession(opts: {
  views: Record<string, string[]>; // filterName → full ordered record ids (natural order)
  totalOverride?: Record<string, number>; // filterName → totalCount when it differs from records.length
  framework?: AuraFrameworkParams | null;
  captured?: { requestMessages: string[]; responseBodies: string[] };
  loggedOut?: boolean;
}): { session: BackfillSession; requestsByFilter: Record<string, Req[]>; purged: () => number } {
  const requestsByFilter: Record<string, Req[]> = {};
  let purgeCount = 0;
  const session: BackfillSession = {
    captureListPage: vi.fn(async () => ({
      framework: opts.framework === undefined ? FRAMEWORK : opts.framework,
      requestMessages: opts.captured?.requestMessages ?? [],
      responseBodies: opts.captured?.responseBodies ?? [],
    })),
    postGetItems: vi.fn(async (fields: Record<string, string>) => {
      const msg = JSON.parse(fields['message']!) as {
        actions: Array<{ params: { filterName: string; offset: number; pageSize: number; sortBy: string | null; getCount: boolean } }>;
      };
      const { filterName, offset, pageSize, sortBy, getCount } = msg.actions[0]!.params;
      (requestsByFilter[filterName] ??= []).push({ sortBy, offset });
      if (opts.loggedOut) return '<html>login</html>'; // unparseable → auth path

      const records = opts.views[filterName] ?? [];
      const total = opts.totalOverride?.[filterName] ?? records.length;
      // LIVE ceiling: an offset above the SOQL OFFSET cap (== pageSize here) yields
      // the degenerate "isn't available in Lightning" response. The sort-flip plan
      // never asks for offset > pageSize, so this is a guard, not an expected path.
      if (offset > pageSize) {
        return JSON.stringify({ actions: [{ id: 'r', state: 'SUCCESS', returnValue: { hasMoreData: false, isErrorListView: false, message: "This list view isn't available in Lightning Experience." } }] });
      }
      const sorted = [...records].sort();
      if (sortBy === '-Id') sorted.reverse();
      const slice = sorted.slice(offset, offset + pageSize);
      return JSON.stringify({
        actions: [{
          id: 'r', state: 'SUCCESS',
          returnValue: {
            recordIdActionsList: slice.map((recordId) => ({ recordId })),
            offset: offset + slice.length,
            hasMoreData: offset + slice.length < total,
            filterTitle: 't',
            isErrorListView: false,
            ...(getCount ? { totalCount: total } : {}),
          },
        }],
      });
    }),
    isLoggedOut: vi.fn(async () => opts.loggedOut === true),
    purgeState: vi.fn(async () => { purgeCount += 1; }),
  };
  return { session, requestsByFilter, purged: () => purgeCount };
}

// ── In-memory prisma cursor double (persisted, so resume is proven by outcome) ─

function makeFakePrisma(seed: Record<string, unknown>[] = []) {
  const cursors = new Map<string, Record<string, unknown>>();
  const key = (o: string, l: string): string => `${o} ${l}`;
  for (const row of seed) cursors.set(key(row['object_api_name'] as string, row['list_view_api_name'] as string), { ...row });
  const compound = (where: {
    object_api_name_list_view_api_name: { object_api_name: string; list_view_api_name: string };
  }): { o: string; l: string } => ({
    o: where.object_api_name_list_view_api_name.object_api_name,
    l: where.object_api_name_list_view_api_name.list_view_api_name,
  });
  const mymrcBackfillCursor = {
    findUnique: vi.fn(async (args: { where: Parameters<typeof compound>[0] }) => {
      const { o, l } = compound(args.where);
      return cursors.get(key(o, l)) ?? null;
    }),
    upsert: vi.fn(
      async (args: {
        where: Parameters<typeof compound>[0];
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const { o, l } = compound(args.where);
        const k = key(o, l);
        const existing = cursors.get(k);
        const row = existing ? { ...existing, ...args.update } : { ...args.create };
        cursors.set(k, row);
        return row;
      },
    ),
  };
  return { prisma: { mymrcBackfillCursor }, cursors, key };
}

type P = BackfillContext['prisma'];

/** A mirror target backed by a shared in-memory Map (dedup by id is the Map itself). */
function mirrorTarget(objectApiName: string, slug: string, store: Map<string, { detail: boolean }>): BackfillTarget {
  return {
    objectApiName,
    listViewApiName: slug,
    optionalFields: [],
    async upsertListed(ids) {
      for (const id of ids) if (!store.has(id)) store.set(id, { detail: false });
      return ids.length;
    },
    async idsNeedingDetail() {
      return [...store.entries()].filter(([, v]) => !v.detail).map(([id]) => id);
    },
    async writeDetail(record) {
      store.set(record.id, { detail: true });
    },
  };
}

function spyPager(): { pager: { page: (a: unknown) => Promise<void> }; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  return { pager: { page: async (a): Promise<void> => void calls.push(a as Record<string, unknown>) }, calls };
}

const mkClient = (session: BackfillSession, overrides: Record<string, string>) =>
  createBackfillPortalClient(session, { listViewOverrides: overrides, pageSize: TEST_PAGE_SIZE });

// ── Sort-flip pages PAST the old offset-2000 (2050-row) truncation ───────────

describe('sort-flip transport — pages a view larger than one sort direction reaches', () => {
  it('asc reaches the first 4 rows, desc the rest — a 5-row view is FULLY pulled (the fix)', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    // 5 records; with pageSize 2 a single ascending direction (offsets 0,2) reaches
    // only d0..d3 — the OLD offset-only path would MISS d4. Sort-flip must get it.
    const { session, requestsByFilter } = makeSession({ views: { HAUL: ['d0', 'd1', 'd2', 'd3', 'd4'] } });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'completed_hauls', store);

    const res = await runBF({ prisma: prisma as unknown as P, client: mkClient(session, { completed_hauls: 'HAUL' }), targets: [target], now: nowFn });

    // Plan: asc@0, asc@2, desc@0 — then totalCount=5 says lastNeeded=2, so it stops.
    expect(requestsByFilter['HAUL']).toEqual([
      { sortBy: 'Id', offset: 0 },
      { sortBy: 'Id', offset: 2 },
      { sortBy: '-Id', offset: 0 },
    ]);
    expect([...store.keys()].sort()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']); // d4 recovered via descending
    const t = res.targets[0];
    expect(t?.status).toBe('complete');
    expect(t?.pagesThisRun).toBe(3);
    const cur = cursors.get(key('Haul_Request__c', 'completed_hauls'));
    expect(cur?.['completed_at']).toEqual(NOW);
    expect(cur?.['last_page_index']).toBe(2);
    // total_records_estimated is the portal's true count, not the overlap-inflated running count.
    expect(cur?.['total_records_estimated']).toBe(5);
    expect(cur?.['records_completed']).toBe(6); // 2+2+2 windows (desc@0 overlaps asc)
  });

  it('a view within one ascending direction stops without a descending flip', async () => {
    const { prisma } = makeFakePrisma();
    const { session, requestsByFilter } = makeSession({ views: { HAUL: ['a', 'b', 'c'] } }); // total 3 ≤ 2*pageSize
    const store = new Map<string, { detail: boolean }>();
    const res = await runBF({ prisma: prisma as unknown as P, client: mkClient(session, { completed_hauls: 'HAUL' }), targets: [mirrorTarget('Haul_Request__c', 'completed_hauls', store)], now: nowFn });
    expect(requestsByFilter['HAUL']).toEqual([{ sortBy: 'Id', offset: 0 }, { sortBy: 'Id', offset: 2 }]); // no desc
    expect([...store.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(res.targets[0]?.status).toBe('complete');
  });
});

// ── Coverage overflow → LOUD wedge, never a silent cap ───────────────────────

describe('sort-flip transport — a view beyond coverage pages the reachable windows then WEDGES LOUD', () => {
  it('pulls the 8 reachable rows, leaves the middle gap, wedges (not complete)', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    // 9 records, pageSize 2 → coverage ceiling is 8. b4 (the middle rank) is
    // unreachable by asc (b0..b3) or desc (b8..b5). This MUST NOT report complete.
    const { session, requestsByFilter } = makeSession({ views: { BIG: ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8'] } });
    const store = new Map<string, { detail: boolean }>();
    const { pager, calls } = spyPager();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client: mkClient(session, { completed_hauls: 'BIG' }),
      targets: [mirrorTarget('Haul_Request__c', 'completed_hauls', store)],
      pager: pager as unknown as Pager,
      now: nowFn,
    });

    expect(res.complete).toBe(false);
    expect(res.targets[0]?.status).toBe('error');
    expect(res.targets[0]?.error).toMatch(/past the .*sort-flip plan|coverage|unreachable|refusing to mark complete/i);
    // All four reachable windows were paged (b0..b3 asc, b8..b5 desc); the 5th step threw before POST.
    expect(requestsByFilter['BIG']).toEqual([
      { sortBy: 'Id', offset: 0 }, { sortBy: 'Id', offset: 2 },
      { sortBy: '-Id', offset: 0 }, { sortBy: '-Id', offset: 2 },
    ]);
    expect([...store.keys()].sort()).toEqual(['b0', 'b1', 'b2', 'b3', 'b5', 'b6', 'b7', 'b8']);
    expect(store.has('b4')).toBe(false); // the unreachable middle — recorded LOUD, not hidden
    expect(calls[0]?.['kind']).toBe('error');
    const cur = cursors.get(key('Haul_Request__c', 'completed_hauls'));
    expect(cur?.['completed_at']).toBeNull(); // NEVER marked complete
    expect(cur?.['total_records_estimated']).toBe(9); // reconciliation shows 8 of 9
  });
});

// ── Multi-view dedup ─────────────────────────────────────────────────────────

describe('sort-flip transport — multi-view object merges deduped by record id', () => {
  it('two Haul views into one mirror; overlapping id stored once', async () => {
    const { prisma } = makeFakePrisma();
    const { session } = makeSession({ views: { DOCK: ['h1', 'h2'], CONSUMER: ['h2', 'h3'] } }); // h2 overlaps
    const store = new Map<string, { detail: boolean }>();
    const targets = [
      mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store),
      mirrorTarget('Haul_Request__c', 'consumer_drop_off_rc', store),
    ];

    const rf = makeRecordFields();
    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client: mkClient(session, { docking_appointments_rc: 'DOCK', consumer_drop_off_rc: 'CONSUMER' }),
      targets, now: nowFn,
    });

    expect(res.complete).toBe(true);
    expect([...store.keys()].sort()).toEqual(['h1', 'h2', 'h3']); // h2 deduped by the mirror key
    // Detail fetched once per id (batched) — the overlapping h2 is not re-detailed.
    expect(rf.requestedIds().sort()).toEqual(['h1', 'h2', 'h3']);
  });
});

// ── History-view coverage (ADR-0057 D3): active + completed dedup once ────────

describe('sort-flip transport — a haul in BOTH an active and the completed view upserts once', () => {
  it('active + Completed Hauls page independently; the overlapping id is stored + detailed once', async () => {
    const { prisma } = makeFakePrisma();
    const { session } = makeSession({ views: { DOCK: ['h1', 'h2'], COMPLETED: ['h2', 'h3', 'h4'] } }); // h2 overlaps
    const store = new Map<string, { detail: boolean }>();
    const targets = [
      mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store),
      mirrorTarget('Haul_Request__c', 'completed_hauls', store),
    ];

    const rf = makeRecordFields();
    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client: mkClient(session, { docking_appointments_rc: 'DOCK', completed_hauls: 'COMPLETED' }),
      targets, now: nowFn,
    });

    expect(res.complete).toBe(true);
    expect([...store.keys()].sort()).toEqual(['h1', 'h2', 'h3', 'h4']);
    expect(rf.requestedIds().sort()).toEqual(['h1', 'h2', 'h3', 'h4']);
  });
});

describe('sort-flip transport — config override keys the new history views', () => {
  it('resolves completed_hauls / processed_inactive / outbound_inactive from MYMRC_LISTVIEW_IDS overrides', async () => {
    const { prisma } = makeFakePrisma();
    const { session, requestsByFilter } = makeSession({
      views: { COMPLETED_OVERRIDE: ['h1'], PROC_INACTIVE_OVERRIDE: ['p1'], OUT_INACTIVE_OVERRIDE: ['o1'] },
    });
    const store = new Map<string, { detail: boolean }>();
    const targets = [
      mirrorTarget('Haul_Request__c', 'completed_hauls', store),
      mirrorTarget('Materials__c', 'processed_inactive', store),
      mirrorTarget('Materials__c', 'outbound_inactive', store),
    ];

    const res = await runBF({
      prisma: prisma as unknown as P,
      client: mkClient(session, {
        completed_hauls: 'COMPLETED_OVERRIDE',
        processed_inactive: 'PROC_INACTIVE_OVERRIDE',
        outbound_inactive: 'OUT_INACTIVE_OVERRIDE',
      }),
      targets, now: nowFn,
    });

    expect(res.complete).toBe(true);
    expect(Object.keys(requestsByFilter).sort()).toEqual(['COMPLETED_OVERRIDE', 'OUT_INACTIVE_OVERRIDE', 'PROC_INACTIVE_OVERRIDE']);
    expect([...store.keys()].sort()).toEqual(['h1', 'o1', 'p1']);
  });
});

// ── Resume mid-object ────────────────────────────────────────────────────────

describe('sort-flip transport — resumes at the next step, never re-pages a window', () => {
  it('a cursor after the ascending steps resumes at the FIRST descending step only', async () => {
    const { prisma, cursors, key } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'completed_hauls',
        last_page_index: 1, // asc@0 + asc@2 already done
        records_completed: 4,
        completed_at: null,
        started_at: new Date('2026-08-04T00:00:00Z'),
      },
    ]);
    const { session, requestsByFilter } = makeSession({ views: { HAUL: ['d0', 'd1', 'd2', 'd3', 'd4'] } });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'completed_hauls', store);

    await runBF({ prisma: prisma as unknown as P, client: mkClient(session, { completed_hauls: 'HAUL' }), targets: [target], now: nowFn });

    // Only the descending step is requested — the two ascending windows are NOT re-paged.
    expect(requestsByFilter['HAUL']).toEqual([{ sortBy: '-Id', offset: 0 }]);
    const cur = cursors.get(key('Haul_Request__c', 'completed_hauls'));
    expect(cur?.['records_completed']).toBe(6); // 4 seeded + 2 from the resumed step
    expect(cur?.['completed_at']).toEqual(NOW);
    expect(cur?.['total_records_estimated']).toBe(5);
  });
});

// ── Unresolvable id → loud wedge ─────────────────────────────────────────────

describe('sort-flip transport — an unresolvable list-view id fails LOUD', () => {
  it('a view with no observed id / override / runtime capture wedges + pages', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const { session, requestsByFilter } = makeSession({ views: {} }); // capture yields no runtime ids
    // consumer_drop_off_rc has observedFilterName:null and we give NO override.
    const bfClient = createBackfillPortalClient(session, { pageSize: TEST_PAGE_SIZE });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'consumer_drop_off_rc', store);
    const { pager, calls } = spyPager();

    const res = await runBF({ prisma: prisma as unknown as P, client: bfClient, targets: [target], pager: pager as unknown as Pager, now: nowFn });

    expect(res.targets[0]?.status).toBe('error');
    expect(res.targets[0]?.error).toMatch(/could not resolve list-view id/i);
    expect(requestsByFilter).toEqual({}); // never POSTed a getItems with a guessed id
    expect(calls[0]?.['kind']).toBe('error');
    expect(cursors.get(key('Haul_Request__c', 'consumer_drop_off_rc'))?.['error']).toMatch(/could not resolve/i);
  });
});

// ── Logged-out replay → auth_failed ──────────────────────────────────────────

describe('sort-flip transport — a logged-out replay maps to auth_failed', () => {
  it('pages auth_failed, purges state, leaves the cursor clean', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const { session, purged } = makeSession({ views: { HAUL: ['x'] }, loggedOut: true });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'completed_hauls', store);
    const { pager, calls } = spyPager();

    const res = await runBF({ prisma: prisma as unknown as P, client: mkClient(session, { completed_hauls: 'HAUL' }), targets: [target], pager: pager as unknown as Pager, now: nowFn });

    expect(res.targets[0]?.status).toBe('auth_failed');
    expect(calls[0]?.['kind']).toBe('auth_failed');
    expect(purged()).toBeGreaterThanOrEqual(1);
    expect(cursors.get(key('Haul_Request__c', 'completed_hauls'))).toBeUndefined(); // clean resume
  });
});
