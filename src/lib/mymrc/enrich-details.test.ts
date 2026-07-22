// ADR-0057 D3 addendum — the batch detail-enrichment engine (enrich-details).
//
// sweepTargetDetail (the ONE shared batch-sweep primitive) + enrichDetails (the
// whole-backlog runner), exercised against fake targets + a fake RecordFieldsClient.
// Proves: batch chunking, writeDetail per SUCCESS record, per-id ERROR isolation,
// the zero-SUCCESS-batch loud page (ADR-0038 D4), and the logged-out abort.

import { describe, expect, it, vi } from 'vitest';
import { enrichDetails, sweepTargetDetail } from './enrich-details';
import type { BackfillTarget } from './backfill';
import type { BatchActionError, RecordFieldsClient } from './record-fields-client';
import { AuthFailedError } from './portal-client';
import type { Pager } from './ntfy';
import type { SfRecord } from './types';

function rec(id: string): SfRecord {
  return { apiName: 'Haul_Request__c', id, fields: {} };
}

/** A target whose null-cursor + writeDetail sink are in-memory (dedup proven by outcome). */
function makeTarget(opts?: {
  object?: string;
  listView?: string;
  pending?: string[];
  optionalFields?: string[];
}): { target: BackfillTarget; written: string[] } {
  const written: string[] = [];
  const target: BackfillTarget = {
    objectApiName: opts?.object ?? 'Haul_Request__c',
    listViewApiName: opts?.listView ?? 'v1',
    optionalFields: opts?.optionalFields ?? ['Haul_Request__c.Name'],
    async upsertListed(ids) {
      return ids.length;
    },
    async idsNeedingDetail() {
      return opts?.pending ?? [];
    },
    async writeDetail(record) {
      written.push(record.id);
    },
  };
  return { target, written };
}

/** A record-fields fake: SUCCESS per id except `errorIds`; `throwAuth` throws. */
function makeRecordFields(opts?: {
  errorIds?: string[];
  throwAuth?: boolean;
}): { client: RecordFieldsClient; batchSizes: number[] } {
  const errorIds = new Set(opts?.errorIds ?? []);
  const batchSizes: number[] = [];
  const client: RecordFieldsClient = {
    fetchRecordFields: vi.fn(async (ids: readonly string[]) => {
      batchSizes.push(ids.length);
      if (opts?.throwAuth) throw new AuthFailedError('logged out');
      const records = new Map<string, SfRecord>();
      const errors: BatchActionError[] = [];
      for (const id of ids) {
        if (errorIds.has(id)) errors.push({ recordId: id, state: 'ERROR', message: 'FLS-hidden' });
        else records.set(id, rec(id));
      }
      return { records, errors };
    }),
  };
  return { client, batchSizes };
}

function spyPager(): { pager: Pager; calls: Parameters<Pager['page']>[0][] } {
  const calls: Parameters<Pager['page']>[0][] = [];
  return { pager: { page: async (a): Promise<void> => void calls.push(a) }, calls };
}

const NOW = new Date('2026-07-22T12:00:00.000Z');
const noPace = { pacingMs: 0, sleep: async (): Promise<void> => undefined, now: NOW };

// ── sweepTargetDetail ────────────────────────────────────────────────────────

describe('sweepTargetDetail', () => {
  it('chunks the null set into batchSize POSTs, writes every SUCCESS record', async () => {
    const { target, written } = makeTarget({ pending: ['1', '2', '3', '4', '5'] });
    const { client, batchSizes } = makeRecordFields();

    const res = await sweepTargetDetail(target, client, { batchSize: 2, ...noPace });

    expect(batchSizes).toEqual([2, 2, 1]); // ceil(5/2) batches
    expect(written.sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(res.requested).toBe(5);
    expect(res.fetched).toBe(5);
    expect(res.errors).toEqual([]);
    expect(res.zeroSuccessBatches).toBe(0);
  });

  it('passes the target optionalFields through to every POST', async () => {
    const { target } = makeTarget({ pending: ['1'], optionalFields: ['Haul_Request__c.Recycler_Weight__c'] });
    const { client } = makeRecordFields();
    await sweepTargetDetail(target, client, { batchSize: 100, ...noPace });
    expect(client.fetchRecordFields).toHaveBeenCalledWith(['1'], ['Haul_Request__c.Recycler_Weight__c']);
  });

  it('isolates a per-id ERROR: the good ids write, the bad id is reported (retried next pass)', async () => {
    const { target, written } = makeTarget({ pending: ['ok1', 'bad', 'ok2'] });
    const { client } = makeRecordFields({ errorIds: ['bad'] });

    const res = await sweepTargetDetail(target, client, { batchSize: 100, ...noPace });

    expect(written.sort()).toEqual(['ok1', 'ok2']);
    expect(res.fetched).toBe(2);
    expect(res.errors).toEqual([{ recordId: 'bad', state: 'ERROR', message: 'FLS-hidden' }]);
    expect(res.zeroSuccessBatches).toBe(0);
  });

  it('flags a zero-SUCCESS batch (all ids errored)', async () => {
    const { target } = makeTarget({ pending: ['x', 'y'] });
    const { client } = makeRecordFields({ errorIds: ['x', 'y'] });
    const res = await sweepTargetDetail(target, client, { batchSize: 100, ...noPace });
    expect(res.fetched).toBe(0);
    expect(res.zeroSuccessBatches).toBe(1);
    expect(res.errors.map((e) => e.recordId).sort()).toEqual(['x', 'y']);
  });

  it('aborts on a logged-out batch (AuthFailedError) without throwing', async () => {
    const { target, written } = makeTarget({ pending: ['1', '2'] });
    const { client } = makeRecordFields({ throwAuth: true });
    const res = await sweepTargetDetail(target, client, { batchSize: 100, ...noPace });
    expect(res.auth).toBe(true);
    expect(res.authMessage).toMatch(/logged out/);
    expect(written).toEqual([]);
  });

  it('an empty null set never POSTs', async () => {
    const { target } = makeTarget({ pending: [] });
    const { client, batchSizes } = makeRecordFields();
    const res = await sweepTargetDetail(target, client, { ...noPace });
    expect(batchSizes).toEqual([]);
    expect(res.requested).toBe(0);
    expect(client.fetchRecordFields).not.toHaveBeenCalled();
  });
});

// ── enrichDetails (whole-backlog) ────────────────────────────────────────────

type P = Parameters<typeof enrichDetails>[0]['prisma'];
const prismaStub = {} as unknown as P;

describe('enrichDetails', () => {
  it('sweeps every target sequentially and reports per-target counts', async () => {
    const hauls = makeTarget({ object: 'Haul_Request__c', pending: ['h1', 'h2'] });
    const mats = makeTarget({ object: 'Materials__c', pending: ['m1'] });
    const { client } = makeRecordFields();
    const { pager, calls } = spyPager();

    const res = await enrichDetails({
      prisma: prismaStub,
      client,
      targets: [hauls.target, mats.target],
      pager,
      batchSize: 100,
      pacingMs: 0,
      sleep: async () => undefined,
      now: () => NOW,
    });

    expect(res.complete).toBe(true);
    expect(res.targets.map((t) => [t.objectApiName, t.fetched])).toEqual([
      ['Haul_Request__c', 2],
      ['Materials__c', 1],
    ]);
    expect(hauls.written.sort()).toEqual(['h1', 'h2']);
    expect(mats.written).toEqual(['m1']);
    expect(calls).toHaveLength(0); // clean sweep is silent
  });

  it('pages dr3-vision-system on a zero-SUCCESS batch (ADR-0038 D4 loud failure)', async () => {
    const t = makeTarget({ pending: ['x', 'y'] });
    const { client } = makeRecordFields({ errorIds: ['x', 'y'] });
    const { pager, calls } = spyPager();

    const res = await enrichDetails({
      prisma: prismaStub,
      client,
      targets: [t.target],
      pager,
      batchSize: 100,
      pacingMs: 0,
      sleep: async () => undefined,
      now: () => NOW,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe('error');
    expect(calls[0]?.fingerprint).toMatch(/^mymrc-enrich-zero:/);
    expect(res.targets[0]?.errored).toBe(2);
    expect(res.targets[0]?.erroredIds.sort()).toEqual(['x', 'y']);
  });

  it('pages auth_failed and does not throw when a target logs out', async () => {
    const t = makeTarget({ pending: ['1', '2'] });
    const { client } = makeRecordFields({ throwAuth: true });
    const { pager, calls } = spyPager();

    const res = await enrichDetails({
      prisma: prismaStub,
      client,
      targets: [t.target],
      pager,
      pacingMs: 0,
      sleep: async () => undefined,
      now: () => NOW,
    });

    expect(res.complete).toBe(false);
    expect(res.targets[0]?.auth).toBe(true);
    expect(calls[0]?.kind).toBe('auth_failed');
    expect(calls[0]?.fingerprint).toBe('mymrc-enrich-auth:Haul_Request__c');
  });
});
