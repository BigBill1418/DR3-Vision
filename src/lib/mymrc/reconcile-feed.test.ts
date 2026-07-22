// ADR-0057 D4 — reconciliation FEED wiring. Verifies the classifier→queue writer:
// unknown source names are queued as new_record candidates (once, deduped across
// feeds AND across runs); known names are not; and the carrier mirror row with a
// resolved site is preferred. Uses an in-memory fake Prisma — no DB.

import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { feedReconciliationQueue } from './reconcile-feed';

interface CreatedRow {
  mirror_table: string;
  mirror_record_id: string;
  target_table: string;
  target_record_id: string | null;
  field_name: string;
  mymrc_value: unknown;
  change_kind: string;
}

interface MirrorRow {
  id: string;
  payload: unknown;
  site_id: string | null;
}

interface FakeState {
  sources: Array<{ id: string; name: string }>;
  aliases: Array<{ alias: string; source_id: string }>;
  processed: MirrorRow[];
  hauls: MirrorRow[];
  queueExisting: Array<{ mymrc_value: unknown }>;
  created: CreatedRow[];
}

function fakePrisma(state: FakeState): PrismaClient {
  return {
    source: { findMany: async () => state.sources },
    sourceAlias: { findMany: async () => state.aliases },
    mymrcProcessedMirror: { findMany: async () => state.processed },
    mymrcHaulsMirror: { findMany: async () => state.hauls },
    mymrcReconciliationQueue: {
      findMany: async () => state.queueExisting,
      createMany: async ({ data }: { data: CreatedRow[] }) => {
        state.created.push(...data);
        return { count: data.length };
      },
    },
  } as unknown as PrismaClient;
}

function state(over: Partial<FakeState> = {}): FakeState {
  return {
    sources: [{ id: 'src-albany', name: 'SVDP Albany' }],
    aliases: [{ alias: 'Albany', source_id: 'src-albany' }],
    processed: [],
    hauls: [],
    queueExisting: [],
    created: [],
    ...over,
  };
}

function processedRow(id: string, accountName: string, site_id: string | null): MirrorRow {
  return {
    id,
    site_id,
    payload: {
      apiName: 'Materials__c',
      id,
      fields: {
        Name: { displayValue: null, value: 'M-000264' },
        Account__r: {
          displayValue: accountName,
          value: { apiName: 'Account', id: '001x', fields: { Name: { value: accountName } } },
        },
      },
    },
  };
}

function haulRow(id: string, site: string, site_id: string | null): MirrorRow {
  return {
    id,
    site_id,
    payload: {
      apiName: 'Haul_Request__c',
      id,
      fields: { Collection_Site__c: { displayValue: null, value: site } },
    },
  };
}

describe('feedReconciliationQueue', () => {
  it('queues an unknown processed source name as a new_record candidate', async () => {
    const s = state({ processed: [processedRow('a2L1', 'SVDP Roseburg', 'site-eugene')] });
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(res).toMatchObject({ processedCandidates: 1, haulCandidates: 0, queued: 1, skippedExisting: 0 });
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({
      mirror_table: 'mymrc_processed_mirror',
      mirror_record_id: 'a2L1',
      target_table: 'sources',
      target_record_id: null,
      field_name: 'name',
      mymrc_value: 'SVDP Roseburg',
      change_kind: 'new_record',
    });
  });

  it('queues an unknown haul collection site, keyed to the hauls mirror', async () => {
    const s = state({ hauls: [haulRow('a2K1', 'Roseburg Depot', 'site-eugene')] });
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(res).toMatchObject({ haulCandidates: 1, queued: 1 });
    expect(s.created[0]).toMatchObject({
      mirror_table: 'mymrc_hauls_mirror',
      mirror_record_id: 'a2K1',
      mymrc_value: 'Roseburg Depot',
    });
  });

  it('does NOT queue a name already known to sources (verbatim or alias)', async () => {
    const s = state({
      processed: [processedRow('a2L1', 'SVDP Albany', 'site-eugene')],
      hauls: [haulRow('a2K1', 'Albany', 'site-eugene')], // resolves via alias
    });
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(res.queued).toBe(0);
    expect(s.created).toHaveLength(0);
  });

  it('cross-run dedup: does not re-queue a name already present in the queue (any status)', async () => {
    const s = state({
      processed: [processedRow('a2L1', 'SVDP Roseburg', 'site-eugene')],
      queueExisting: [{ mymrc_value: 'svdp   ROSEBURG' }], // normalized-equal, prior tick
    });
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(res).toMatchObject({ processedCandidates: 1, queued: 0, skippedExisting: 1 });
    expect(s.created).toHaveLength(0);
  });

  it('cross-feed dedup: one unknown name surfaced by BOTH feeds is queued once (processed wins)', async () => {
    const s = state({
      processed: [processedRow('a2L1', 'Roseburg Depot', 'site-eugene')],
      hauls: [haulRow('a2K1', 'Roseburg Depot', 'site-eugene')],
    });
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(res.queued).toBe(1);
    expect(s.created).toHaveLength(1);
    expect(s.created[0]).toMatchObject({
      mirror_table: 'mymrc_processed_mirror',
      mirror_record_id: 'a2L1',
    });
  });

  it('prefers a site-resolved carrier row so the candidate is approvable', async () => {
    // Same unknown name on two rows: an unresolved (site_id null) row FIRST in the
    // query result, a resolved one second. The feed must pick the resolved carrier.
    const s = state({
      processed: [
        processedRow('a2L-null', 'SVDP Roseburg', null),
        processedRow('a2L-resolved', 'SVDP Roseburg', 'site-eugene'),
      ],
    });
    await feedReconciliationQueue({ prisma: fakePrisma(s) });

    expect(s.created).toHaveLength(1);
    expect(s.created[0]?.mirror_record_id).toBe('a2L-resolved');
  });

  it('queues nothing (and inserts nothing) when there are no mirror rows', async () => {
    const s = state();
    const res = await feedReconciliationQueue({ prisma: fakePrisma(s) });
    expect(res).toEqual({ processedCandidates: 0, haulCandidates: 0, queued: 0, skippedExisting: 0 });
    expect(s.created).toHaveLength(0);
  });
});
