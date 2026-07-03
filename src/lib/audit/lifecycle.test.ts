import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  AUTO_RESOLVE_NOTE,
  isAllowedTransition,
  persistRun,
  reconcileFindings,
  transitionFinding,
  type ExistingFindingLite,
} from './lifecycle';
import type { Finding } from './types';

function finding(fp: string, over: Partial<Finding> = {}): Finding {
  return {
    checkCode: 'c1_inbound',
    siteId: 'site-1',
    windowStartISO: '2026-06-01',
    windowEndISO: '2026-06-15',
    severity: 'high',
    kind: 'value_mismatch',
    legARef: 'L1',
    legBRef: 'H1',
    expected: { units: 10 },
    actual: { units: 9 },
    detail: null,
    fingerprint: fp,
    ...over,
  };
}

describe('reconcileFindings', () => {
  it('creates a finding with no existing counterpart', () => {
    const plan = reconcileFindings([], [finding('fp-1')]);
    expect(plan.toCreate).toHaveLength(1);
    expect(plan.toRefresh).toHaveLength(0);
  });

  it('refreshes (not duplicates) an unchanged open discrepancy', () => {
    const existing: ExistingFindingLite[] = [{ id: 'x1', fingerprint: 'fp-1', status: 'open', autoResolved: false }];
    const plan = reconcileFindings(existing, [finding('fp-1')]);
    expect(plan.toCreate).toHaveLength(0);
    expect(plan.toRefresh).toHaveLength(1);
    expect(plan.toRefresh[0]!.id).toBe('x1');
  });

  it('auto-resolves an open finding that disappears from the computed set', () => {
    const existing: ExistingFindingLite[] = [{ id: 'x1', fingerprint: 'fp-gone', status: 'open', autoResolved: false }];
    const plan = reconcileFindings(existing, []);
    expect(plan.toAutoResolve).toEqual(['x1']);
  });

  it('reopens an auto-resolved finding that recurs', () => {
    const existing: ExistingFindingLite[] = [{ id: 'x1', fingerprint: 'fp-1', status: 'resolved', autoResolved: true }];
    const plan = reconcileFindings(existing, [finding('fp-1')]);
    expect(plan.toReopen).toHaveLength(1);
    expect(plan.toCreate).toHaveLength(0);
  });

  it('respects a MANUAL resolution — does not reopen or auto-resolve', () => {
    const existing: ExistingFindingLite[] = [{ id: 'x1', fingerprint: 'fp-1', status: 'not_an_issue', autoResolved: false }];
    const plan = reconcileFindings(existing, [finding('fp-1')]);
    expect(plan.toReopen).toHaveLength(0);
    expect(plan.toRefresh).toHaveLength(1); // last_seen refresh, status untouched
    expect(plan.toAutoResolve).toHaveLength(0);
  });

  it('a manually resolved finding NOT recurring is left alone (not auto-resolved again)', () => {
    const existing: ExistingFindingLite[] = [{ id: 'x1', fingerprint: 'fp-1', status: 'resolved', autoResolved: false }];
    const plan = reconcileFindings(existing, []);
    expect(plan.toAutoResolve).toHaveLength(0);
  });
});

describe('isAllowedTransition', () => {
  it('allows the D2 lifecycle transitions', () => {
    expect(isAllowedTransition('open', 'acknowledged')).toBe(true);
    expect(isAllowedTransition('open', 'resolved')).toBe(true);
    expect(isAllowedTransition('acknowledged', 'not_an_issue')).toBe(true);
    expect(isAllowedTransition('resolved', 'open')).toBe(true);
  });
  it('rejects no-op and illegal transitions', () => {
    expect(isAllowedTransition('open', 'open')).toBe(false);
    expect(isAllowedTransition('resolved', 'acknowledged')).toBe(false);
    expect(isAllowedTransition('not_an_issue', 'resolved')).toBe(false);
  });
});

// ── DB application (fake PrismaClient) ──────────────────────────────────

interface Captured {
  creates: unknown[];
  updates: unknown[];
  audits: unknown[];
}

function fakeDb(existing: Array<{ id: string; fingerprint: string; status: string; resolution_note: string | null }>): {
  db: PrismaClient;
  captured: Captured;
} {
  const captured: Captured = { creates: [], updates: [], audits: [] };
  const tx = {
    auditFinding: {
      upsert: vi.fn(async (a: { create: { fingerprint: string } }) => {
        captured.creates.push(a);
        return { id: `new-${a.create.fingerprint}` };
      }),
      update: vi.fn(async (a: unknown) => {
        captured.updates.push(a);
        return { id: 'u' };
      }),
    },
    auditLog: { create: vi.fn(async (a: unknown) => captured.audits.push(a)) },
  };
  const db = {
    auditFinding: {
      findMany: vi.fn(async () => existing),
      findUnique: vi.fn(async () => (existing[0] ? { id: existing[0].id, status: existing[0].status } : null)),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { db: db as unknown as PrismaClient, captured };
}

describe('persistRun', () => {
  it('creates new findings, auto-resolves the vanished ones, and audits both', async () => {
    // Existing 'fp-gone' is open and absent from computed → auto-resolve.
    const { db, captured } = fakeDb([{ id: 'x1', fingerprint: 'fp-gone', status: 'open', resolution_note: null }]);
    const res = await persistRun({
      db,
      window: { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-15' },
      checkCodes: ['c1_inbound'],
      computed: [finding('fp-new')],
      actorLabel: 'system:audit-sweep',
    });
    expect(res.opened).toBe(1);
    expect(res.resolved).toBe(1);
    expect(captured.creates).toHaveLength(1);
    // Two audit rows: one insert, one auto-resolve update.
    expect(captured.audits).toHaveLength(2);
    const autoResolveUpdate = captured.updates.find(
      (u) => (u as { data?: { resolution_note?: string } }).data?.resolution_note === AUTO_RESOLVE_NOTE,
    );
    expect(autoResolveUpdate).toBeDefined();
  });
});

describe('transitionFinding', () => {
  it('rejects closing without a cause category', async () => {
    const { db } = fakeDb([{ id: 'x1', fingerprint: 'fp', status: 'open', resolution_note: null }]);
    const r = await transitionFinding({ db, findingId: 'x1', toStatus: 'resolved', actorUserId: 'u1' });
    expect(r).toEqual({ ok: false, reason: 'cause_required' });
  });

  it('rejects an illegal transition', async () => {
    const { db } = fakeDb([{ id: 'x1', fingerprint: 'fp', status: 'resolved', resolution_note: null }]);
    const r = await transitionFinding({ db, findingId: 'x1', toStatus: 'acknowledged', actorUserId: 'u1' });
    expect(r).toEqual({ ok: false, reason: 'illegal_transition' });
  });

  it('applies a valid resolution with cause + audit row', async () => {
    const { db, captured } = fakeDb([{ id: 'x1', fingerprint: 'fp', status: 'open', resolution_note: null }]);
    const r = await transitionFinding({
      db,
      findingId: 'x1',
      toStatus: 'resolved',
      actorUserId: 'u1',
      causeCategory: 'data_entry',
      resolutionNote: 'fat-fingered unit count',
    });
    expect(r).toEqual({ ok: true });
    expect(captured.audits).toHaveLength(1);
  });

  it('404s an unknown finding', async () => {
    const { db } = fakeDb([]);
    const r = await transitionFinding({ db, findingId: 'nope', toStatus: 'acknowledged', actorUserId: 'u1' });
    expect(r).toEqual({ ok: false, reason: 'not_found' });
  });
});
