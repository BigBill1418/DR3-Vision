import { describe, expect, it, vi } from 'vitest';
import {
  runBackfill,
  type BackfillContext,
  type BackfillListPage,
  type BackfillPortalClient,
  type BackfillTarget,
} from './backfill';
import { AuthFailedError } from './portal-client';
import type { BatchActionError, RecordFieldsClient } from './record-fields-client';
import type { Pager } from './ntfy';
import type { SfRecord } from './types';

// ── Fakes ────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-08-04T12:00:00.000Z');
const nowFn = (): Date => NOW;

function rec(id: string): SfRecord {
  return { apiName: 'Haul_Request__c', id, fields: {} };
}

/** In-memory prisma double backing ONLY the backfill cursor — real persisted
 *  state so resumability is proven by outcome, not just call assertions. */
function makeFakePrisma(seed: Record<string, unknown>[] = []) {
  const cursors = new Map<string, Record<string, unknown>>();
  const key = (o: string, l: string): string => `${o} ${l}`;
  for (const row of seed)
    cursors.set(key(row['object_api_name'] as string, row['list_view_api_name'] as string), {
      ...row,
    });
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

interface TargetProbe {
  target: BackfillTarget;
  listed: string[][];
  detailed: string[];
}

function makeTarget(opts?: {
  object?: string;
  listView?: string;
  needDetail?: () => Promise<string[]>;
  writeDetail?: (record: SfRecord) => Promise<void>;
}): TargetProbe {
  const listed: string[][] = [];
  const detailed: string[] = [];
  const target: BackfillTarget = {
    objectApiName: opts?.object ?? 'Haul_Request__c',
    listViewApiName: opts?.listView ?? 'v1',
    optionalFields: [],
    async upsertListed(ids) {
      listed.push([...ids]);
      return ids.length;
    },
    idsNeedingDetail: opts?.needDetail ?? (async (): Promise<string[]> => []),
    async writeDetail(record) {
      if (opts?.writeDetail) await opts.writeDetail(record);
      detailed.push(record.id);
    },
  };
  return { target, listed, detailed };
}

function makeClient(opts: {
  pages?: Record<number, BackfillListPage>;
  pageThrow?: (pageIndex: number) => unknown;
}): BackfillPortalClient {
  return {
    fetchListPage: vi.fn(async (_o: string, _l: string, pageIndex: number) => {
      const t = opts.pageThrow?.(pageIndex);
      if (t) throw t;
      return opts.pages?.[pageIndex] ?? { ids: [], hasMoreData: false };
    }),
  };
}

// The BATCHED getRecordWithFields detail transport (record-fields-client).
// Serves one SfRecord per requested id in ONE call; `errorIds` come back as
// per-action ERRORs (retried next run); `throwAuth` throws AuthFailedError.
function makeRecordFields(opts?: { errorIds?: string[]; throwAuth?: boolean }): {
  client: RecordFieldsClient;
  callCount: () => number;
  requested: string[];
} {
  const errorIds = new Set(opts?.errorIds ?? []);
  const requested: string[] = [];
  let calls = 0;
  const client: RecordFieldsClient = {
    fetchRecordFields: vi.fn(async (ids: readonly string[]) => {
      calls += 1;
      if (opts?.throwAuth) throw new AuthFailedError('logged out');
      const records = new Map<string, SfRecord>();
      const errors: BatchActionError[] = [];
      for (const id of ids) {
        requested.push(id);
        if (errorIds.has(id))
          errors.push({ recordId: id, state: 'ERROR', message: 'record vanished mid-run' });
        else records.set(id, rec(id));
      }
      return { records, errors };
    }),
  };
  return { client, callCount: () => calls, requested };
}

// Shared record-fields fake for pagination-focused tests (no detail assertions).
const RF = makeRecordFields().client;
/** runBackfill with the shared record-fields fake injected (pagination tests). */
const runBF = (args: Omit<BackfillContext, 'recordFields'>): ReturnType<typeof runBackfill> =>
  runBackfill({ recordFields: RF, ...args });

function spyPager(): { pager: Pager; calls: Parameters<Pager['page']>[0][] } {
  const calls: Parameters<Pager['page']>[0][] = [];
  return { pager: { page: async (a): Promise<void> => void calls.push(a) }, calls };
}

type P = BackfillContext['prisma'];

// ── Pagination across multiple windows ───────────────────────────────────────

describe('runBackfill — pagination advances through every window to hasMoreData:false', () => {
  it('pages 0→1→2, upserts each window, drains, marks the cursor complete', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const client = makeClient({
      pages: {
        0: { ids: ['a', 'b'], hasMoreData: true },
        1: { ids: ['c'], hasMoreData: true },
        2: { ids: ['d'], hasMoreData: false },
      },
    });
    const { target, listed } = makeTarget();
    const { pager, calls } = spyPager();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager,
      now: nowFn,
    });

    expect(listed).toEqual([['a', 'b'], ['c'], ['d']]); // every window upserted, in order
    const pageArgs = (client.fetchListPage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(pageArgs).toEqual([0, 1, 2]); // sequential paging, no gaps
    const t = res.targets[0];
    expect(t?.status).toBe('complete');
    expect(t?.recordsListedThisRun).toBe(4);
    expect(t?.pagesThisRun).toBe(3);
    expect(t?.paginationComplete).toBe(true);
    const cur = cursors.get(key('Haul_Request__c', 'v1'));
    expect(cur?.['completed_at']).toEqual(NOW);
    expect(cur?.['records_completed']).toBe(4);
    expect(cur?.['last_page_index']).toBe(2);
    expect(cur?.['total_records_estimated']).toBe(4); // exact at drain
    expect(calls).toHaveLength(0); // healthy run is silent
  });
});

// ── Resume from a persisted cursor ───────────────────────────────────────────

describe('runBackfill — resumes from the cursor (never re-pages completed windows)', () => {
  it('starts at last_page_index+1 and carries records_completed forward', async () => {
    const { prisma, cursors, key } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 1,
        last_record_id: 'c',
        records_completed: 3,
        completed_at: null,
        started_at: new Date('2026-08-04T00:00:00Z'),
      },
    ]);
    const client = makeClient({ pages: { 2: { ids: ['d'], hasMoreData: false } } });
    const { target, listed } = makeTarget();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      now: nowFn,
    });

    const pageArgs = (client.fetchListPage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(pageArgs).toEqual([2]); // resumed at page 2 — pages 0,1 never refetched
    expect(listed).toEqual([['d']]);
    expect(res.targets[0]?.recordsListedThisRun).toBe(1);
    const cur = cursors.get(key('Haul_Request__c', 'v1'));
    expect(cur?.['records_completed']).toBe(4); // 3 carried + 1 new
    expect(cur?.['completed_at']).toEqual(NOW);
  });
});

// ── Batched detail sweep (record-fields-client) ──────────────────────────────

describe('runBackfill — detail is fetched in batched getRecordWithFields POSTs', () => {
  it('sweeps 9 records with one POST at the default batch size (100)', async () => {
    // Pagination already drained → engine goes straight to the detail sweep.
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 0,
        records_completed: 9,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const client = makeClient({});
    const rf = makeRecordFields();
    const { target, detailed } = makeTarget({ needDetail: async () => ids });

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      now: nowFn,
    });

    expect(rf.callCount()).toBe(1); // 9 ids ≤ 100 → a single POST
    expect(rf.requested.sort()).toEqual(ids); // every id requested exactly once
    expect(detailed.sort()).toEqual(ids); // every record written exactly once
    expect(res.targets[0]?.detailsFetched).toBe(9);
    expect(res.targets[0]?.status).toBe('complete');
    expect((client.fetchListPage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0); // no re-paging
  });

  it('chunks into detailBatchSize batches (5 ids at size 2 → 3 POSTs)', async () => {
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 0,
        records_completed: 5,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const client = makeClient({});
    const rf = makeRecordFields();
    const { target, detailed } = makeTarget({ needDetail: async () => ['1', '2', '3', '4', '5'] });

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      now: nowFn,
      detailBatchSize: 2,
      detailPacingMs: 0,
    });

    expect(rf.callCount()).toBe(3); // ceil(5/2)
    expect(detailed.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(res.targets[0]?.detailsFetched).toBe(5);
  });
});

// ── Idempotent re-run ────────────────────────────────────────────────────────

describe('runBackfill — a drained + fully-detailed cursor is a no-op re-run', () => {
  it('does not page, does not fetch detail', async () => {
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 2,
        records_completed: 4,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const client = makeClient({});
    const rf = makeRecordFields();
    const { target } = makeTarget({ needDetail: async () => [] }); // nothing left to detail

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      now: nowFn,
    });

    expect((client.fetchListPage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(rf.callCount()).toBe(0); // no null ids → never POSTs
    expect(res.targets[0]?.status).toBe('complete');
    expect(res.targets[0]?.pagesThisRun).toBe(0);
    expect(res.complete).toBe(true);
  });

  it('a drained cursor with detail gaps sweeps details only (no re-pagination)', async () => {
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 2,
        records_completed: 4,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const client = makeClient({});
    const rf = makeRecordFields();
    const { target, detailed } = makeTarget({ needDetail: async () => ['x', 'y'] });

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      now: nowFn,
    });

    expect((client.fetchListPage as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(detailed.sort()).toEqual(['x', 'y']);
    expect(res.targets[0]?.detailsFetched).toBe(2);
    expect(res.targets[0]?.status).toBe('complete');
  });
});

// ── Wedge → error persisted to cursor + ntfy page ────────────────────────────

describe('runBackfill — a pagination wedge fails loud and stays resumable', () => {
  it('persists the error onto the cursor and pages ntfy (kind=error)', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const client = makeClient({
      pageThrow: (i) => (i === 0 ? new Error('portal 500') : undefined),
    });
    const { target } = makeTarget();
    const { pager, calls } = spyPager();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('error');
    expect(res.targets[0]?.error).toBe('portal 500');
    const cur = cursors.get(key('Haul_Request__c', 'v1'));
    expect(cur?.['error']).toBe('portal 500');
    // Pre-page-0 wedge → last_page_index=-1 so a resume recomputes page 0 (not 1).
    expect(cur?.['last_page_index']).toBe(-1);
    expect(cur?.['completed_at']).toBeUndefined();
    expect(calls[0]?.kind).toBe('error');
    expect(calls[0]?.fingerprint).toBe('mymrc-backfill-error:Haul_Request__c:v1');
  });

  it('a mid-pagination wedge, then a clean re-run, drains to completion (RESUMABILITY PROOF)', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    let attempt = 0;
    const client = makeClient({
      pages: {
        0: { ids: ['a', 'b'], hasMoreData: true },
        1: { ids: ['c'], hasMoreData: true },
        2: { ids: ['d'], hasMoreData: false },
      },
      pageThrow: (i) => {
        if (i === 2 && attempt === 0) {
          attempt = 1;
          return new Error('transient wedge at page 2');
        }
        return undefined;
      },
    });
    const { target: t1, listed: listed1 } = makeTarget();
    const { pager, calls } = spyPager();

    // Run 1: pages 0,1 persist; page 2 wedges.
    const run1 = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [t1],
      pager,
      now: nowFn,
    });
    expect(run1.targets[0]?.status).toBe('error');
    expect(listed1).toEqual([['a', 'b'], ['c']]); // only the two good pages upserted
    let cur = cursors.get(key('Haul_Request__c', 'v1'));
    expect(cur?.['last_page_index']).toBe(1); // progress through page 1 preserved
    expect(cur?.['records_completed']).toBe(3);
    expect(cur?.['error']).toBe('transient wedge at page 2');
    expect(calls[0]?.kind).toBe('error');

    // Run 2: fresh target probe, SAME persisted cursor store → resumes at page 2.
    const { target: t2, listed: listed2 } = makeTarget();
    const run2 = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [t2],
      pager,
      now: nowFn,
    });
    expect(run2.targets[0]?.status).toBe('complete');
    expect(listed2).toEqual([['d']]); // ONLY the previously-failed page redone — no double upsert of a/b/c
    cur = cursors.get(key('Haul_Request__c', 'v1'));
    expect(cur?.['completed_at']).toEqual(NOW);
    expect(cur?.['records_completed']).toBe(4); // 3 + 1, no double count
    expect(cur?.['error']).toBeNull(); // cleared on the successful drain
  });
});

// ── Auth failures ────────────────────────────────────────────────────────────

describe('runBackfill — auth failure pages auth_failed and leaves the cursor clean', () => {
  it('during pagination', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const client = makeClient({ pageThrow: () => new AuthFailedError('logged out') });
    const { target } = makeTarget();
    const { pager, calls } = spyPager();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('auth_failed');
    expect(calls[0]?.kind).toBe('auth_failed');
    expect(calls[0]?.fingerprint).toBe('mymrc-backfill-auth:Haul_Request__c');
    // Auth is transient — no error stamped, cursor never created for a clean resume.
    expect(cursors.get(key('Haul_Request__c', 'v1'))).toBeUndefined();
  });

  it('during the detail sweep aborts the run (logged-out batch)', async () => {
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 0,
        records_completed: 3,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const client = makeClient({});
    const rf = makeRecordFields({ throwAuth: true });
    const { target } = makeTarget({ needDetail: async () => ['1', '2', '3', '4', '5', '6'] });
    const { pager, calls } = spyPager();

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('auth_failed');
    expect(calls[0]?.kind).toBe('auth_failed');
    // The batch throwing AuthFailedError aborts the sweep immediately — no further POSTs.
    expect(rf.callCount()).toBe(1);
  });
});

// ── Transient detail failures are NOT a wedge ────────────────────────────────

describe('runBackfill — a per-record detail failure is retried next run, not a wedge', () => {
  it('marks the target incomplete, counts the failure, does not page', async () => {
    const { prisma } = makeFakePrisma([
      {
        object_api_name: 'Haul_Request__c',
        list_view_api_name: 'v1',
        last_page_index: 0,
        records_completed: 3,
        completed_at: NOW,
        started_at: NOW,
      },
    ]);
    const client = makeClient({});
    const rf = makeRecordFields({ errorIds: ['bad'] }); // 'bad' comes back as a per-action ERROR
    const { target, detailed } = makeTarget({ needDetail: async () => ['ok1', 'bad', 'ok2'] });
    const { pager, calls } = spyPager();

    const res = await runBackfill({
      prisma: prisma as unknown as P,
      recordFields: rf.client,
      client,
      targets: [target],
      pager,
      now: nowFn,
    });

    expect(res.targets[0]?.status).toBe('incomplete');
    expect(res.targets[0]?.detailsFetched).toBe(2);
    expect(res.targets[0]?.detailFailures).toBe(1);
    expect(detailed.sort()).toEqual(['ok1', 'ok2']); // the good ones persisted
    expect(calls).toHaveLength(0); // transient detail failure never pages
    expect(res.complete).toBe(false);
  });
});

// ── Multi-target isolation ───────────────────────────────────────────────────

describe('runBackfill — one wedged target does not stop the others', () => {
  it('runs every target and reports per-target status', async () => {
    const { prisma } = makeFakePrisma();
    const client: BackfillPortalClient = {
      fetchListPage: vi.fn(async (object: string, _l: string, pageIndex: number) => {
        if (object === 'BadObject') throw new Error('boom');
        if (pageIndex === 0) return { ids: ['a'], hasMoreData: false };
        return { ids: [], hasMoreData: false };
      }),
    };
    const bad = makeTarget({ object: 'BadObject', listView: 'v1' });
    const good = makeTarget({ object: 'GoodObject', listView: 'v1' });
    const { pager, calls } = spyPager();

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [bad.target, good.target],
      pager,
      now: nowFn,
    });

    expect(res.targets).toHaveLength(2);
    expect(res.targets[0]?.status).toBe('error');
    expect(res.targets[1]?.status).toBe('complete');
    expect(good.listed).toEqual([['a']]); // the healthy target ran despite the earlier wedge
    expect(res.complete).toBe(false);
    expect(calls.filter((c) => c.kind === 'error')).toHaveLength(1);
  });
});

// ── ADR-0133: the backfill cursor is a redaction boundary too ────────────────
//
// `mymrc_backfill_cursors.error` is the same sink class as
// `mymrc_sync_runs.error`, fed by the SAME Playwright transport
// (`backfill-portal-client.ts` is where the 2026-09-16 `apiRequestContext.post`
// throw originated) and published to the SAME topic. Its column comment also
// said "never credentials". Every secret below is SYNTHESISED.

describe('runBackfill — a Playwright call log never reaches the cursor or the page', () => {
  const CALL_LOG = [
    'apiRequestContext.post: Timeout 45000ms exceeded.',
    'Call log:',
    '  - → POST https://mymrc.example.force.com/s/sfsites/aura?r=7',
    '  -   cookie: BrowserId=FAKEbrowserid; sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtoken0000',
    '  -   authorization: Bearer FAKEbearerFAKEtoken',
  ].join('\n');

  const clean = (text: string): void => {
    expect(text).not.toContain('cookie:');
    expect(text).not.toContain('sid=');
    expect(text).not.toContain('Bearer');
    expect(text).not.toMatch(/00D[0-9A-Za-z]{12,15}!/);
  };

  it('redacts a WEDGE — cursor row, returned error, page body and log line', async () => {
    const { prisma, cursors, key } = makeFakePrisma();
    const client = makeClient({
      pageThrow: (i) => (i === 0 ? new Error(CALL_LOG) : undefined),
    });
    const { target } = makeTarget();
    const { pager, calls } = spyPager();
    const lines: string[] = [];

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager,
      now: nowFn,
      log: (_l, m) => lines.push(m),
    });

    const cursorError = String(cursors.get(key('Haul_Request__c', 'v1'))?.['error']);
    clean(cursorError);
    clean(String(res.targets[0]?.error));
    clean(String(calls[0]?.message));
    clean(lines.join('\n'));
    // The diagnosis survives.
    expect(cursorError).toContain('Timeout 45000ms exceeded.');
  });

  it('redacts an AUTH failure message on the same paths', async () => {
    const { prisma } = makeFakePrisma();
    const client = makeClient({
      pageThrow: (i) =>
        i === 0
          ? new AuthFailedError(
              'locator.fill: Timeout 45000ms exceeded.\nCall log:\n  -   cookie: sid=00Dxx0000000FAKE!AQEAQFAKEsessionFAKEtoken0000',
            )
          : undefined,
    });
    const { target } = makeTarget();
    const { pager, calls } = spyPager();
    const lines: string[] = [];

    const res = await runBF({
      prisma: prisma as unknown as P,
      client,
      targets: [target],
      pager,
      now: nowFn,
      log: (_l, m) => lines.push(m),
    });

    expect(res.targets[0]?.status).toBe('auth_failed');
    clean(String(res.targets[0]?.error));
    clean(String(calls[0]?.message));
    clean(lines.join('\n'));
  });
});
