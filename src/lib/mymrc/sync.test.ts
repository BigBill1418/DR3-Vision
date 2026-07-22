import { describe, expect, it, vi } from 'vitest';
import {
  chunk,
  checkDeadman,
  computeDisappearedIds,
  decidePage,
  isZeroAnomaly,
  makeSiteIdResolver,
  siteCodeFromDiscriminator,
  syncFeed,
} from './sync';
import { AuthFailedError, PortalContractDriftError, type PortalClient } from './portal-client';
import type { Pager } from './ntfy';
import type { FeedName, SfRecord, SyncRunStatus } from './types';

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('isZeroAnomaly', () => {
  it('flags 0-listed only when a prior successful run listed >0', () => {
    expect(isZeroAnomaly(0, 5)).toBe(true);
    expect(isZeroAnomaly(0, 0)).toBe(false); // legitimately empty feed
    expect(isZeroAnomaly(0, null)).toBe(false); // never succeeded yet
    expect(isZeroAnomaly(3, 5)).toBe(false);
  });
});

describe('decidePage (cross-tick dedup)', () => {
  const t = (iso: string): Date => new Date(iso);
  it('pages on the leading edge (no prior, or status changed)', () => {
    expect(decidePage(null, 'auth_failed', t('2026-07-03T18:00:00Z'))).toBe(true);
    expect(
      decidePage({ status: 'ok', started_at: t('2026-07-03T17:00:00Z') }, 'auth_failed', t('2026-07-03T18:00:00Z')),
    ).toBe(true);
  });
  it('suppresses a repeat within the re-page window, re-pages after it', () => {
    const prior = { status: 'auth_failed' as SyncRunStatus, started_at: t('2026-07-03T17:00:00Z') };
    expect(decidePage(prior, 'auth_failed', t('2026-07-03T18:00:00Z'))).toBe(false); // 1h < 6h
    expect(decidePage(prior, 'auth_failed', t('2026-07-04T00:00:00Z'))).toBe(true); // 7h > 6h
  });
});

describe('computeDisappearedIds', () => {
  it('returns active ids absent from the latest list', () => {
    expect(computeDisappearedIds(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    expect(computeDisappearedIds(['a'], ['a'])).toEqual([]);
  });
});

describe('chunk', () => {
  it('splits into bounded groups (never a zero-size group)', () => {
    expect(chunk([1, 2, 3, 4, 5], 3)).toEqual([[1, 2, 3], [4, 5]]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('siteCodeFromDiscriminator (site-on-data attribution)', () => {
  it('maps MyMRC recycler/account display names to DR3 site codes', () => {
    expect(siteCodeFromDiscriminator('DR3 Eugene')).toBe('eugene');
    expect(siteCodeFromDiscriminator('DR3 Woodland')).toBe('woodland');
    expect(siteCodeFromDiscriminator('dr3 woodland recycling ctr')).toBe('woodland');
    expect(siteCodeFromDiscriminator(null)).toBeNull();
    expect(siteCodeFromDiscriminator('Some Other Yard')).toBeNull();
  });
});

describe('makeSiteIdResolver', () => {
  it('resolves a code to its site id; null for unknown or null code', () => {
    const resolve = makeSiteIdResolver([
      { id: 's-e', code: 'eugene' },
      { id: 's-w', code: 'woodland' },
    ]);
    expect(resolve('eugene')).toBe('s-e');
    expect(resolve('woodland')).toBe('s-w');
    expect(resolve(null)).toBeNull();
  });
});

// ── Fakes ────────────────────────────────────────────────────────────────────

function processedRecord(id: string): SfRecord {
  return {
    apiName: 'Materials__c',
    id,
    fields: {
      Name: { displayValue: null, value: `M-${id}` },
      Entry_Date__c: { displayValue: null, value: '2024-03-01' },
      Number_of_Program_Units__c: { displayValue: null, value: 100 },
    },
  };
}

/** A Materials record carrying the site discriminator + billing count. */
function processedRecordEugene(id: string): SfRecord {
  return {
    apiName: 'Materials__c',
    id,
    fields: {
      Name: { displayValue: null, value: `M-${id}` },
      Type__c: { displayValue: null, value: 'Processing' },
      Account__r: {
        displayValue: 'DR3 Eugene',
        value: { apiName: 'Account', id: 'acc-1', fields: { Name: { displayValue: null, value: 'DR3 Eugene' } } },
      },
      Number_of_Program_Units__c: { displayValue: null, value: 42 },
      Entry_Date__c: { displayValue: null, value: '2024-03-01' },
    },
  };
}

function fakeClient(over: Partial<PortalClient>): PortalClient {
  return {
    fetchListRecordIds: vi.fn(async () => []),
    fetchRecordDetail: vi.fn(async (_feed: FeedName, id: string) => processedRecord(id)),
    close: vi.fn(async () => undefined),
    ...over,
  };
}

interface FakeOpts {
  prior?: { status: SyncRunStatus; started_at: Date } | null;
  lastOk?: { rows_listed: number } | null;
  needDetail?: string[]; // ids idsNeedingDetail returns
}

function fakePrisma(opts: FakeOpts) {
  const ledgerCreate = vi.fn(async (args: { data: unknown }) => ({ id: 'run-1', ...(args.data as object) }));
  const modelUpdate = vi.fn<(a: { data: Record<string, unknown> }) => Promise<object>>(async () => ({}));
  const model = {
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    findMany: vi.fn(async () => (opts.needDetail ?? []).map((id) => ({ id }))),
    update: modelUpdate,
  };
  const prisma = {
    site: {
      findUnique: vi.fn(async () => ({ id: 'site-1' })),
      // Global pull derives site on the detail pass from the preloaded code→id map.
      findMany: vi.fn(async () => [
        { id: 'site-1', code: 'woodland' },
        { id: 'site-2', code: 'eugene' },
      ]),
    },
    mymrcSyncRun: {
      findFirst: vi.fn(async (args: { where: { status?: string } }) =>
        args.where.status === 'ok' ? (opts.lastOk ?? null) : (opts.prior ?? null),
      ),
      create: ledgerCreate,
    },
    mymrcProcessedMirror: model,
    mymrcHaulsMirror: model,
    mymrcOutboundMirror: model,
  };
  return { prisma, ledgerCreate, model, modelUpdate };
}

function spyPager(): { pager: Pager; calls: Parameters<Pager['page']>[0][] } {
  const calls: Parameters<Pager['page']>[0][] = [];
  return { pager: { page: async (a): Promise<void> => void calls.push(a) }, calls };
}

const NOW = (): Date => new Date('2026-07-03T18:00:00.000Z');
type P = Parameters<typeof syncFeed>[0]['prisma'];

// ── Orchestration ────────────────────────────────────────────────────────────

describe('syncFeed — happy path', () => {
  it('lists → upserts → fetches detail → writes an ok ledger row, no page', async () => {
    const { prisma, ledgerCreate, modelUpdate } = fakePrisma({ needDetail: ['id1', 'id2'] });
    const client = fakeClient({ fetchListRecordIds: vi.fn(async () => ['id1', 'id2']) });
    const { pager, calls } = spyPager();

    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });

    expect(res.status).toBe('ok');
    expect(res.rowsListed).toBe(2);
    expect(res.detailsFetched).toBe(2);
    expect(modelUpdate).toHaveBeenCalledTimes(2); // detail persisted per record
    expect(calls).toHaveLength(0); // healthy run is silent
    const ledger = ledgerCreate.mock.calls[0]?.[0]?.data as { status: string; rows_listed: number };
    expect(ledger.status).toBe('ok');
    expect(ledger.rows_listed).toBe(2);
  });
});

describe('syncFeed — detail pass derives site_id + populates real columns', () => {
  it('stamps site_id from the account discriminator and writes program_unit_count/type', async () => {
    const { prisma, modelUpdate } = fakePrisma({ needDetail: ['m1'] });
    const client = fakeClient({
      fetchListRecordIds: vi.fn(async () => ['m1']),
      fetchRecordDetail: vi.fn(async () => processedRecordEugene('m1')),
    });
    const { pager } = spyPager();

    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });

    expect(res.status).toBe('ok');
    const data = modelUpdate.mock.calls[0]?.[0]?.data;
    expect(data?.['site_id']).toBe('site-2'); // "DR3 Eugene" → eugene → site-2 (site-on-data)
    expect(data?.['program_unit_count']).toBe(42); // billing-authoritative count populated
    expect(data?.['type']).toBe('Processing');
    expect(data?.['account_name']).toBe('DR3 Eugene');
  });

  it('leaves site_id unset (undefined in the update) when the discriminator is unresolvable', async () => {
    const { prisma, modelUpdate } = fakePrisma({ needDetail: ['m2'] });
    const client = fakeClient({
      fetchListRecordIds: vi.fn(async () => ['m2']),
      fetchRecordDetail: vi.fn(async () => processedRecord('m2')), // no Account__r
    });
    const { pager } = spyPager();

    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });

    expect(res.status).toBe('ok');
    const data = modelUpdate.mock.calls[0]?.[0]?.data;
    // Never force-attribute: an unresolved row is not stamped (stays NULL in DB).
    expect(data?.['site_id']).toBeUndefined();
    expect(data?.['detail_fetched_at']).toBeDefined();
  });
});

describe('syncFeed — zero-anomaly', () => {
  it('0 listed where prior success listed >0 ⇒ error + page + ledger', async () => {
    const { prisma, ledgerCreate } = fakePrisma({ lastOk: { rows_listed: 5 } });
    const client = fakeClient({ fetchListRecordIds: vi.fn(async () => []) });
    const { pager, calls } = spyPager();

    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });

    expect(res.status).toBe('error');
    expect(calls[0]?.kind).toBe('zero_anomaly');
    expect(calls[0]?.fingerprint).toBe('mymrc-zero-anomaly:woodland:processed');
    expect((ledgerCreate.mock.calls[0]?.[0]?.data as { status: string }).status).toBe('error');
  });

  it('0 listed with NO prior success is a legitimate empty feed (status ok)', async () => {
    const { prisma } = fakePrisma({ lastOk: null });
    const client = fakeClient({ fetchListRecordIds: vi.fn(async () => []) });
    const { pager, calls } = spyPager();
    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });
    expect(res.status).toBe('ok');
    expect(calls).toHaveLength(0);
  });
});

describe('syncFeed — typed failures always write a ledger row (D4)', () => {
  it('AuthFailedError ⇒ status auth_failed + auth page + ledger', async () => {
    const { prisma, ledgerCreate } = fakePrisma({});
    const client = fakeClient({
      fetchListRecordIds: vi.fn(async () => {
        throw new AuthFailedError('logged out');
      }),
    });
    const { pager, calls } = spyPager();
    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'eugene', feed: 'processed', pager, now: NOW });
    expect(res.status).toBe('auth_failed');
    expect(calls[0]?.kind).toBe('auth_failed');
    expect(calls[0]?.fingerprint).toBe('mymrc-auth-failed:eugene');
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
  });

  it('PortalContractDriftError ⇒ status contract_drift + drift page + ledger', async () => {
    const { prisma, ledgerCreate } = fakePrisma({});
    const client = fakeClient({
      fetchListRecordIds: vi.fn(async () => {
        throw new PortalContractDriftError('fwuid drift');
      }),
    });
    const { pager, calls } = spyPager();
    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'eugene', feed: 'outbound', pager, now: NOW });
    expect(res.status).toBe('contract_drift');
    expect(calls[0]?.kind).toBe('contract_drift');
    expect(ledgerCreate).toHaveBeenCalledTimes(1);
  });
});

describe('syncFeed — a failed detail fetch does not fail the run (retries next run)', () => {
  it('leaves status ok, counts only successful details', async () => {
    const { prisma } = fakePrisma({ needDetail: ['ok1', 'bad2'] });
    const client = fakeClient({
      fetchListRecordIds: vi.fn(async () => ['ok1', 'bad2']),
      fetchRecordDetail: vi.fn(async (_f: FeedName, id: string) => {
        if (id === 'bad2') throw new PortalContractDriftError('record vanished mid-run');
        return processedRecord(id);
      }),
    });
    const { pager, calls } = spyPager();
    const res = await syncFeed({ prisma: prisma as unknown as P, client, site: 'woodland', feed: 'processed', pager, now: NOW });
    expect(res.status).toBe('ok'); // partial detail progress is never a run failure
    expect(res.detailsFetched).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('checkDeadman', () => {
  it('pages when the last successful run is older than 26h', async () => {
    const { prisma } = fakePrisma({ lastOk: { rows_listed: 3 } });
    // Override findFirst to return an old success timestamp.
    prisma.mymrcSyncRun.findFirst = vi.fn(async () => ({ started_at: new Date('2026-07-02T00:00:00Z') })) as never;
    const { pager, calls } = spyPager();
    await checkDeadman({ prisma: prisma as unknown as P, sites: ['woodland'], pager, now: NOW });
    expect(calls.every((c) => c.kind === 'deadman')).toBe(true);
    expect(calls.length).toBe(3); // one per feed
  });

  it('does not page a feed that has never succeeded (first-run state)', async () => {
    const { prisma } = fakePrisma({});
    prisma.mymrcSyncRun.findFirst = vi.fn(async () => null) as never;
    const { pager, calls } = spyPager();
    await checkDeadman({ prisma: prisma as unknown as P, sites: ['woodland'], pager, now: NOW });
    expect(calls).toHaveLength(0);
  });
});
