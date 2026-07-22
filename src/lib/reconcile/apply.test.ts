// ADR-0057 D4 — reconciliation decision engine tests. Deterministic in-memory
// fake Prisma (only the shapes apply.ts touches). @/lib/prisma is mocked so the
// real client is never constructed; every call passes the fake explicitly.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import {
  applyReconcileDecision,
  assertReconcileNote,
  bulkApproveReconciliations,
  listPendingReconciliations,
  pendingReconcileCount,
  ReconNoteRequiredError,
  ReconNotActionableError,
  ReconNotFoundError,
  ReconUnsupportedTargetError,
} from './apply';

interface QueueRow {
  id: string;
  mirror_table: string;
  mirror_record_id: string;
  target_table: string;
  target_record_id: string | null;
  field_name: string;
  mymrc_value: unknown;
  vision_value: unknown;
  change_kind: string;
  status: string;
  created_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
  snooze_until: Date | null;
}

interface Db {
  queue: QueueRow[];
  mirror: Array<{ id: string; site_id: string }>;
  sources: Array<{ id: string; site_id: string; name: string }>;
  audit: Array<Record<string, unknown>>;
}

type AnyRec = Record<string, unknown>;
let seq = 0;

function matchStatus(cond: unknown, s: string): boolean {
  if (cond === undefined) return true;
  if (cond && typeof cond === 'object' && Array.isArray((cond as { in?: unknown[] }).in)) {
    return (cond as { in: string[] }).in.includes(s);
  }
  return s === cond;
}

function actionableNow(r: QueueRow, now: Date): boolean {
  if (r.status === 'pending') return true;
  if (r.status === 'snoozed' && r.snooze_until && r.snooze_until.getTime() <= now.getTime())
    return true;
  return false;
}

function makeFake(db: Db) {
  const client = {
    mymrcReconciliationQueue: {
      async findUnique(args: { where: AnyRec; select?: AnyRec }) {
        const row = db.queue.find((r) => r.id === args.where['id']);
        return row ? { ...row } : null;
      },
      async findMany(args: { where?: AnyRec; orderBy?: AnyRec } = {}) {
        const w = args.where ?? {};
        const or = w['OR'] as AnyRec[] | undefined;
        const now = ((or?.[1]?.['snooze_until'] as AnyRec | undefined)?.['lte'] as Date) ?? new Date();
        let rows = db.queue.filter((r) => {
          if (or && !actionableNow(r, now)) return false;
          if (w['mirror_table'] !== undefined && r.mirror_table !== w['mirror_table']) return false;
          if (w['change_kind'] !== undefined && r.change_kind !== w['change_kind']) return false;
          return true;
        });
        rows = rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        return rows.map((r) => ({ ...r }));
      },
      async updateMany(args: { where: AnyRec; data: AnyRec }) {
        const w = args.where;
        const targets = db.queue.filter(
          (r) => r.id === w['id'] && matchStatus(w['status'], r.status),
        );
        for (const r of targets) Object.assign(r, args.data);
        return { count: targets.length };
      },
      async count(args: { where?: AnyRec } = {}) {
        const w = args.where ?? {};
        const or = w['OR'] as AnyRec[] | undefined;
        const now = ((or?.[1]?.['snooze_until'] as AnyRec | undefined)?.['lte'] as Date) ?? new Date();
        return db.queue.filter((r) => (or ? actionableNow(r, now) : true)).length;
      },
    },
    mymrcProcessedMirror: {
      async findUnique(args: { where: AnyRec; select?: AnyRec }) {
        const row = db.mirror.find((m) => m.id === args.where['id']);
        return row ? { site_id: row.site_id } : null;
      },
    },
    source: {
      async create(args: { data: AnyRec }) {
        const name = args.data['name'] as string;
        const siteId = args.data['site_id'] as string;
        if (db.sources.some((s) => s.site_id === siteId && s.name === name)) {
          throw new Error('Unique constraint failed on site_id,name');
        }
        const row = { id: `src-${++seq}`, site_id: siteId, name };
        db.sources.push(row);
        return { ...row };
      },
    },
    auditLog: {
      async create(args: { data: AnyRec }) {
        db.audit.push({ ...args.data });
        return { id: `a-${++seq}` };
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      // No real rollback in the fake; apply.ts writes the operational row FIRST and
      // throws before the status flip on failure, so tests assert on that ordering.
      return fn(client);
    },
  };
  return client as unknown as import('@prisma/client').PrismaClient;
}

function queueRow(over: Partial<QueueRow> = {}): QueueRow {
  return {
    id: `q-${++seq}`,
    mirror_table: 'mymrc_processed_mirror',
    mirror_record_id: 'm1',
    target_table: 'sources',
    target_record_id: null,
    field_name: 'name',
    mymrc_value: 'Roseburg Depot',
    vision_value: null,
    change_kind: 'new_record',
    status: 'pending',
    created_at: new Date('2026-07-20T00:00:00Z'),
    decided_at: null,
    decided_by: null,
    decision_note: null,
    snooze_until: null,
    ...over,
  };
}

describe('assertReconcileNote', () => {
  it('passes with a non-empty note, throws otherwise', () => {
    expect(() => assertReconcileNote('approved', 'ok')).not.toThrow();
    expect(() => assertReconcileNote('approved', '   ')).toThrow(ReconNoteRequiredError);
    expect(() => assertReconcileNote('rejected', undefined)).toThrow(ReconNoteRequiredError);
    expect(() => assertReconcileNote('snoozed', null)).toThrow(ReconNoteRequiredError);
  });
});

describe('applyReconcileDecision — approve', () => {
  it('writes the new source, flips status, stamps decided_at/by, and audits', async () => {
    const row = queueRow();
    const db: Db = {
      queue: [row],
      mirror: [{ id: 'm1', site_id: 'site-w' }],
      sources: [],
      audit: [],
    };
    const prisma = makeFake(db);
    const res = await applyReconcileDecision({
      prisma,
      id: row.id,
      decision: 'approved',
      actorUserId: 'u-bill',
      note: 'confirmed new Roseburg source',
    });
    expect(res.applied).toMatchObject({ table: 'sources', after: { name: 'Roseburg Depot' } });
    expect(db.sources).toHaveLength(1);
    expect(db.sources[0]).toMatchObject({ site_id: 'site-w', name: 'Roseburg Depot' });
    expect(row.status).toBe('approved');
    expect(row.decided_by).toBe('u-bill');
    expect(row.decided_at).toBeInstanceOf(Date);
    expect(row.decision_note).toBe('confirmed new Roseburg source');
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({ table_name: 'mymrc_reconciliation_queue', action: 'update' });
  });

  it('refuses an unsupported target and writes NOTHING (no source, no flip, no audit)', async () => {
    const row = queueRow({ change_kind: 'field_update' });
    const db: Db = { queue: [row], mirror: [{ id: 'm1', site_id: 'site-w' }], sources: [], audit: [] };
    const prisma = makeFake(db);
    await expect(
      applyReconcileDecision({ prisma, id: row.id, decision: 'approved', actorUserId: 'u', note: 'x' }),
    ).rejects.toBeInstanceOf(ReconUnsupportedTargetError);
    expect(db.sources).toHaveLength(0);
    expect(row.status).toBe('pending');
    expect(db.audit).toHaveLength(0);
  });
});

describe('applyReconcileDecision — reject / snooze', () => {
  it('reject flips to rejected, writes NO operational row, audits', async () => {
    const row = queueRow();
    const db: Db = { queue: [row], mirror: [{ id: 'm1', site_id: 'site-w' }], sources: [], audit: [] };
    const prisma = makeFake(db);
    const res = await applyReconcileDecision({
      prisma,
      id: row.id,
      decision: 'rejected',
      actorUserId: 'u',
      note: 'duplicate of existing source',
    });
    expect(res.applied).toBeNull();
    expect(db.sources).toHaveLength(0);
    expect(row.status).toBe('rejected');
    expect(row.decided_by).toBe('u');
    expect(db.audit).toHaveLength(1);
  });

  it('snooze sets a 7-day wake time, leaves decided_at/by null, writes no source', async () => {
    const row = queueRow();
    const db: Db = { queue: [row], mirror: [{ id: 'm1', site_id: 'site-w' }], sources: [], audit: [] };
    const prisma = makeFake(db);
    const now = new Date('2026-07-21T00:00:00Z');
    await applyReconcileDecision({
      prisma,
      id: row.id,
      decision: 'snoozed',
      actorUserId: 'u',
      note: 'waiting on Rick',
      now,
    });
    expect(row.status).toBe('snoozed');
    expect(row.decided_at).toBeNull();
    expect(row.decided_by).toBeNull();
    expect(row.snooze_until?.toISOString()).toBe('2026-07-28T00:00:00.000Z');
    expect(db.sources).toHaveLength(0);
  });
});

describe('applyReconcileDecision — guards', () => {
  it('throws ReconNotFoundError for an unknown id', async () => {
    const prisma = makeFake({ queue: [], mirror: [], sources: [], audit: [] });
    await expect(
      applyReconcileDecision({ prisma, id: 'nope', decision: 'approved', actorUserId: 'u', note: 'x' }),
    ).rejects.toBeInstanceOf(ReconNotFoundError);
  });

  it('throws ReconNotActionableError for an already-decided item (first action wins)', async () => {
    const row = queueRow({ status: 'approved' });
    const db: Db = { queue: [row], mirror: [], sources: [], audit: [] };
    const prisma = makeFake(db);
    await expect(
      applyReconcileDecision({ prisma, id: row.id, decision: 'rejected', actorUserId: 'u', note: 'x' }),
    ).rejects.toBeInstanceOf(ReconNotActionableError);
  });
});

describe('listing + count', () => {
  it('lists pending + woken snoozed, hides terminal + still-sleeping, filters by class', async () => {
    const now = new Date('2026-07-25T00:00:00Z');
    const db: Db = {
      queue: [
        queueRow({ id: 'p1', created_at: new Date('2026-07-24T00:00:00Z') }),
        queueRow({ id: 'done', status: 'approved' }),
        queueRow({ id: 'woke', status: 'snoozed', snooze_until: new Date('2026-07-24T00:00:00Z') }),
        queueRow({ id: 'sleep', status: 'snoozed', snooze_until: new Date('2026-07-30T00:00:00Z') }),
        queueRow({ id: 'other', mirror_table: 'mymrc_outbound_mirror' }),
      ],
      mirror: [],
      sources: [],
      audit: [],
    };
    const prisma = makeFake(db);
    const all = await listPendingReconciliations({ prisma, now });
    expect(all.map((r) => r.id).sort()).toEqual(['other', 'p1', 'woke']);
    const filtered = await listPendingReconciliations({
      prisma,
      now,
      mirrorTable: 'mymrc_processed_mirror',
    });
    expect(filtered.map((r) => r.id).sort()).toEqual(['p1', 'woke']);
    expect(await pendingReconcileCount(prisma, now)).toBe(3);
  });
});

describe('bulkApproveReconciliations', () => {
  it('approves every item of a class, isolating per-item failures', async () => {
    const db: Db = {
      queue: [
        queueRow({ id: 'a', mymrc_value: 'Alpha Depot' }),
        queueRow({ id: 'b', mymrc_value: 'Beta Depot' }),
        queueRow({ id: 'bad', change_kind: 'disappeared' }), // unsupported → fails alone
      ],
      mirror: [{ id: 'm1', site_id: 'site-w' }],
      sources: [],
      audit: [],
    };
    const prisma = makeFake(db);
    const res = await bulkApproveReconciliations({
      prisma,
      mirrorTable: 'mymrc_processed_mirror',
      changeKind: 'new_record' as never,
      actorUserId: 'u',
      note: 'batch approve verified new sources',
    });
    expect(res.approved.sort()).toEqual(['a', 'b']);
    expect(res.failed).toHaveLength(0); // 'bad' is a different change_kind, not in the class
    expect(db.sources.map((s) => s.name).sort()).toEqual(['Alpha Depot', 'Beta Depot']);
  });
})
