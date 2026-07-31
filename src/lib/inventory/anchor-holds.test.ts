// ADR-0072 — releasing a held count.
//
// The rule the whole tier exists for: **the operator who entered the count can
// never release it.** If that can be bypassed, Tier 2 is decoration.
//
// Every guard was falsified before being kept.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/pin-service', () => ({
  verifyPin: vi.fn(async (_userId: string, pin: string) =>
    pin === 'good' ? { ok: true, userId: _userId } : { ok: false, reason: 'wrong_pin' },
  ),
}));
vi.mock('@/lib/inventory/running-balance', () => ({
  reconcilePhysicalCount: vi.fn(async () => ({
    snapshotId: 'snap-new',
    computedTotal: '2483',
    physicalTotal: 1200,
    reconciledDelta: -1283,
  })),
}));

import { verifyPin } from '@/lib/pin-service';
import { reconcilePhysicalCount } from '@/lib/inventory/running-balance';
import {
  BadPinError,
  HoldNotPendingError,
  NotAManagerError,
  SelfReleaseRefusedError,
  discardHold,
  releaseHold,
} from './anchor-holds';

const OPERATOR = 'user-operator';
const MANAGER = 'user-manager';
const OUTSIDER = 'user-outsider';
const SITE = 'site-woodland';

function fakeDb(over: Partial<Record<string, unknown>> = {}) {
  const hold = {
    id: 'hold-1',
    site_id: SITE,
    units_indoor: null,
    units_total: 1200,
    units_in_processing: 0,
    program_units: null,
    non_program_units: null,
    pool_attribution: 'measured',
    prior_snapshot_id: 'snap-prior',
    prior_total: 2483,
    new_total: 1200,
    swing_pct: 51.67,
    threshold_pct: 20,
    status: 'pending',
    created_by: OPERATOR,
    ...over,
  };
  const updates: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  return {
    hold,
    updates,
    audits,
    inventoryCountHold: {
      findUnique: async () => hold,
      update: async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return hold;
      },
    },
    user: {
      findMany: async () => [{ id: MANAGER, name: 'Morena Gomez' }],
    },
    siteInventorySnapshot: {
      findFirst: async () => ({
        id: 'snap-prior',
        snapshot_at: new Date('2026-07-22T07:00:00.000Z'),
        units_indoor: null,
        units_total: 2483,
        units_in_processing: 0,
        program_units: null,
        non_program_units: null,
      }),
    },
    inventoryAnchorConfig: {
      findUnique: async () => ({ swing_threshold_pct: 20 }),
    },
    auditLog: {
      create: async (a: { data: Record<string, unknown> }) => {
        audits.push(a.data);
        return { id: 'audit-1' };
      },
    },
  };
}

beforeEach(() => vi.clearAllMocks());

describe('releaseHold', () => {
  it('a manager with the right PIN releases it and the anchor is written', async () => {
    const db = fakeDb();
    const out = await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'pin',
      pin: 'good',
    });
    expect(out.snapshotId).toBe('snap-new');
    expect(reconcilePhysicalCount).toHaveBeenCalledTimes(1);
    expect(db.updates[0]!['status']).toBe('approved');
    expect(db.updates[0]!['approval_path']).toBe('pin');
    expect(db.updates[0]!['approved_by']).toBe(MANAGER);
  });

  it('REFUSES a self-release by the operator who entered it', async () => {
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: OPERATOR,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('checks self-release BEFORE the PIN — a refusal must not double as a PIN oracle', async () => {
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: OPERATOR,
        path: 'pin',
        pin: 'wrong',
      }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    // If the PIN were checked first, a self-release attempt would reveal whether
    // the supplied PIN was right.
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it('refuses someone who is not a manager at this site', async () => {
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: OUTSIDER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(NotAManagerError);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('refuses a wrong PIN and writes nothing', async () => {
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'wrong',
      }),
    ).rejects.toBeInstanceOf(BadPinError);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('the REMOTE path needs no PIN — the manager session is the identity', async () => {
    const db = fakeDb();
    const out = await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'remote',
    });
    expect(out.snapshotId).toBe('snap-new');
    expect(verifyPin).not.toHaveBeenCalled();
    expect(db.updates[0]!['approval_path']).toBe('remote');
  });

  it('the remote path is bound by the SAME self-release rule', async () => {
    // A manager who entered the count on the floor cannot release it from their
    // desk either — the rule is about the person, not the surface.
    const db = fakeDb({ created_by: MANAGER });
    await expect(
      releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
  });

  it('will not release a hold twice', async () => {
    const db = fakeDb({ status: 'approved' });
    await expect(
      releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' }),
    ).rejects.toBeInstanceOf(HoldNotPendingError);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('will not release a discarded hold', async () => {
    const db = fakeDb({ status: 'discarded' });
    await expect(
      releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' }),
    ).rejects.toBeInstanceOf(HoldNotPendingError);
  });

  it('records the approver, the operator, the swing and the path in the audit row', async () => {
    const db = fakeDb();
    await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'pin',
      pin: 'good',
    });
    const after = db.audits[0]!['after'] as Record<string, unknown>;
    expect(after['approver_user_id']).toBe(MANAGER);
    expect(after['operator_user_id']).toBe(OPERATOR);
    expect(after['approval_path']).toBe('pin');
    expect(after['prior_total']).toBe(2483);
    expect(after['new_total']).toBe(1200);
    expect(after['tier']).toBe(2);
    expect(after['resulting_snapshot_id']).toBe('snap-new');
  });

  it('RECOMPUTES the swing at release rather than trusting the stored one', async () => {
    // The stored swing said 51.67% against a prior of 2,483. The live anchor here
    // is the same, so the recomputed figure must match reality, not the record —
    // if the anchor had moved, writing the stale figure is how a guardrail
    // becomes theatre.
    const db = fakeDb({ swing_pct: 1, prior_total: 9999 });
    const out = await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'remote',
    });
    expect(out.classification.prior?.total).toBe(2483);
    expect(Math.round(out.classification.swingPct!)).toBe(52);
  });
});

describe('discardHold', () => {
  it('records who and why, and writes nothing to inventory', async () => {
    const db = fakeDb();
    await discardHold(db as never, {
      holdId: 'hold-1',
      userId: OPERATOR,
      reason: 'mistyped a digit',
    });
    expect(db.updates[0]!['status']).toBe('discarded');
    expect(db.updates[0]!['discard_reason']).toBe('mistyped a digit');
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('will not discard a hold that has already been released', async () => {
    const db = fakeDb({ status: 'approved' });
    await expect(
      discardHold(db as never, { holdId: 'hold-1', userId: OPERATOR, reason: 'x' }),
    ).rejects.toBeInstanceOf(HoldNotPendingError);
  });
});
