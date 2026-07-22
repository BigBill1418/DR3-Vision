// ADR-0057 Phase 1 (D3) — the offset transport wired into the backfill engine,
// exercised end-to-end against a FAKE BackfillSession (no Playwright, no live
// portal). Proves the money-adjacent contract the whole feature turns on:
//   • the offset loop advances 0→50→100 and stops on hasMoreData:false,
//   • multi-view objects merge deduped by salesforce_record_id,
//   • a mid-object cursor resumes at the next offset (no re-paged windows),
//   • drained + fully-detailed ⇒ completed_at set (status complete),
//   • a list-view id that resolves to NONE fails LOUD (wedge + ntfy),
//   • a logged-out replay maps to auth_failed (clean cursor, transient).

import { describe, expect, it, vi } from 'vitest';
import {
  createBackfillPortalClient,
  type BackfillSession,
} from './backfill-portal-client';
import { runBackfill, type BackfillContext, type BackfillTarget } from './backfill';
import type { Pager } from './ntfy';
import type { AuraFrameworkParams } from './list-page';
import type { SfRecord } from './types';

const NOW = new Date('2026-08-04T12:00:00.000Z');
const nowFn = (): Date => NOW;

const FRAMEWORK: AuraFrameworkParams = {
  auraContext: '{"fwuid":"FAKE"}',
  auraToken: 'tok',
  auraPageUri: '/s/hauls',
};

interface PageSpec {
  ids: string[];
  hasMoreData: boolean;
}

/** A fake session: postGetItems parses (filterName, offset) from the replay body
 *  and returns the scripted page; requested offsets are recorded per filterName. */
function makeSession(opts: {
  pages: Record<string, Record<number, PageSpec>>; // filterName → offset → page
  captured?: { requestMessages: string[]; responseBodies: string[] };
  framework?: AuraFrameworkParams | null;
  loggedOut?: boolean;
}): { session: BackfillSession; offsetsByFilter: Record<string, number[]>; purged: () => number } {
  const offsetsByFilter: Record<string, number[]> = {};
  let purgeCount = 0;
  const session: BackfillSession = {
    captureListPage: vi.fn(async () => ({
      framework: opts.framework === undefined ? FRAMEWORK : opts.framework,
      requestMessages: opts.captured?.requestMessages ?? [],
      responseBodies: opts.captured?.responseBodies ?? [],
    })),
    postGetItems: vi.fn(async (fields: Record<string, string>) => {
      const message = JSON.parse(fields['message']!) as {
        actions: Array<{ params: { filterName: string; offset: number } }>;
      };
      const { filterName, offset } = message.actions[0]!.params;
      (offsetsByFilter[filterName] ??= []).push(offset);
      if (opts.loggedOut) return '<html>login</html>'; // unparseable → auth path
      const spec = opts.pages[filterName]?.[offset] ?? { ids: [], hasMoreData: false };
      return JSON.stringify({
        actions: [
          {
            id: 'r',
            state: 'SUCCESS',
            returnValue: {
              recordIdActionsList: spec.ids.map((recordId) => ({ recordId })),
              offset: offset + spec.ids.length,
              hasMoreData: spec.hasMoreData,
              filterTitle: 't',
              isErrorListView: false,
            },
          },
        ],
      });
    }),
    fetchRecordDetail: vi.fn(async (id: string): Promise<SfRecord> => ({ apiName: 'X__c', id, fields: {} })),
    isLoggedOut: vi.fn(async () => opts.loggedOut === true),
    purgeState: vi.fn(async () => {
      purgeCount += 1;
    }),
  };
  return { session, offsetsByFilter, purged: () => purgeCount };
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

// ── The offset loop ──────────────────────────────────────────────────────────

describe('backfill offset transport — pages 0→50→100 and stops on hasMoreData:false', () => {
  it('drives the confirmed offsets through the engine and drains the cursor', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const { session, offsetsByFilter } = makeSession({
      pages: {
        DOCK_ID: {
          0: { ids: ['a', 'b'], hasMoreData: true },
          50: { ids: ['c', 'd'], hasMoreData: true },
          100: { ids: ['e'], hasMoreData: false },
        },
      },
    });
    const client = createBackfillPortalClient(session, { listViewOverrides: { docking_appointments_rc: 'DOCK_ID' } });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store);

    const res = await runBackfill({ prisma: prisma as unknown as P, client, targets: [target], now: nowFn });

    expect(offsetsByFilter['DOCK_ID']).toEqual([0, 50, 100]); // exact confirmed offsets, in order
    expect([...store.keys()].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    const t = res.targets[0];
    expect(t?.status).toBe('complete');
    expect(t?.pagesThisRun).toBe(3);
    expect(t?.recordsListedThisRun).toBe(5);
    const cur = cursors.get(key('Haul_Request__c', 'docking_appointments_rc'));
    expect(cur?.['completed_at']).toEqual(NOW); // complete=true set completed_at
    expect(cur?.['last_page_index']).toBe(2);
  });
});

// ── Multi-view dedup ─────────────────────────────────────────────────────────

describe('backfill offset transport — multi-view object merges deduped by record id', () => {
  it('two Haul views into one mirror; overlapping id stored once', async () => {
    const { prisma } = makeFakePrisma();
    const { session } = makeSession({
      pages: {
        DOCK_ID: { 0: { ids: ['h1', 'h2'], hasMoreData: false } },
        CONSUMER_ID: { 0: { ids: ['h2', 'h3'], hasMoreData: false } }, // h2 overlaps
      },
    });
    const client = createBackfillPortalClient(session, {
      listViewOverrides: { docking_appointments_rc: 'DOCK_ID', consumer_drop_off_rc: 'CONSUMER_ID' },
    });
    const store = new Map<string, { detail: boolean }>();
    const targets = [
      mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store),
      mirrorTarget('Haul_Request__c', 'consumer_drop_off_rc', store),
    ];

    const res = await runBackfill({ prisma: prisma as unknown as P, client, targets, now: nowFn });

    expect(res.complete).toBe(true);
    expect([...store.keys()].sort()).toEqual(['h1', 'h2', 'h3']); // h2 deduped by the mirror key
    // Detail fetched once per distinct id across both views (second view finds none pending).
    expect((session.fetchRecordDetail as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]).sort()).toEqual([
      'h1',
      'h2',
      'h3',
    ]);
  });
});

// ── Resume mid-object ────────────────────────────────────────────────────────

describe('backfill offset transport — resumes at the next offset, never re-pages', () => {
  it('a cursor at page 1 resumes by requesting offset 100 only', async () => {
    const { prisma, cursors, key } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'docking_appointments_rc',
        last_page_index: 1,
        records_completed: 100,
        completed_at: null,
        started_at: new Date('2026-08-04T00:00:00Z'),
      },
    ]);
    const { session, offsetsByFilter } = makeSession({
      pages: { DOCK_ID: { 100: { ids: ['tail'], hasMoreData: false } } },
    });
    const client = createBackfillPortalClient(session, { listViewOverrides: { docking_appointments_rc: 'DOCK_ID' } });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store);

    await runBackfill({ prisma: prisma as unknown as P, client, targets: [target], now: nowFn });

    expect(offsetsByFilter['DOCK_ID']).toEqual([100]); // offsets 0 + 50 never re-requested
    const cur = cursors.get(key('Haul_Request__c', 'docking_appointments_rc'));
    expect(cur?.['records_completed']).toBe(101);
    expect(cur?.['completed_at']).toEqual(NOW);
  });
});

// ── Unresolvable id → loud wedge ─────────────────────────────────────────────

describe('backfill offset transport — an unresolvable list-view id fails LOUD', () => {
  it('a view with no observed id / override / runtime capture wedges + pages', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const { session, offsetsByFilter } = makeSession({ pages: {} }); // capture yields no runtime ids
    // consumer_drop_off_rc has observedFilterName:null and we give NO override.
    const client = createBackfillPortalClient(session, {});
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'consumer_drop_off_rc', store);
    const { pager, calls } = spyPager();

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager: pager as unknown as Pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('error');
    expect(res.targets[0]?.error).toMatch(/could not resolve list-view id/i);
    expect(offsetsByFilter).toEqual({}); // never POSTed a getItems with a guessed id
    expect(calls[0]?.['kind']).toBe('error');
    const cur = cursors.get(key('Haul_Request__c', 'consumer_drop_off_rc'));
    expect(cur?.['error']).toMatch(/could not resolve/i);
  });
});

// ── Logged-out replay → auth_failed ──────────────────────────────────────────

describe('backfill offset transport — a logged-out replay maps to auth_failed', () => {
  it('pages auth_failed, purges state, leaves the cursor clean', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const { session, purged } = makeSession({
      pages: { DOCK_ID: { 0: { ids: ['x'], hasMoreData: false } } },
      loggedOut: true,
    });
    const client = createBackfillPortalClient(session, { listViewOverrides: { docking_appointments_rc: 'DOCK_ID' } });
    const store = new Map<string, { detail: boolean }>();
    const target = mirrorTarget('Haul_Request__c', 'docking_appointments_rc', store);
    const { pager, calls } = spyPager();

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager: pager as unknown as Pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('auth_failed');
    expect(calls[0]?.['kind']).toBe('auth_failed');
    expect(purged()).toBeGreaterThanOrEqual(1);
    // Auth is transient — no cursor error row written for a clean resume.
    expect(cursors.get(key('Haul_Request__c', 'docking_appointments_rc'))).toBeUndefined();
  });
});
