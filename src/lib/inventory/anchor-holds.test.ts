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
  NoFloorPinError,
  NotAManagerError,
  PinLockedError,
  SelfReleaseRefusedError,
  countPendingHolds,
  discardHold,
  heldCountsLabel,
  releaseHold,
} from './anchor-holds';

const OPERATOR = 'user-operator';
const MANAGER = 'user-manager';
const OUTSIDER = 'user-outsider';
const SITE = 'site-woodland';
/** ADR-0072 Am.2 — MANAGER's own operator account, the one that carries the PIN. */
const MANAGER_FLOOR = 'user-manager-floor';

type LinkRow = { id: string; floor_user_id: string | null };
const DEFAULT_LINKS: LinkRow[] = [{ id: MANAGER, floor_user_id: MANAGER_FLOOR }];

type FloorRow = {
  role: string;
  is_active: boolean;
  deleted_at: Date | null;
  primary_site_id: string | null;
};
const GOOD_FLOOR: FloorRow = {
  role: 'operator',
  is_active: true,
  deleted_at: null,
  primary_site_id: SITE,
};

function fakeDb(
  over: Partial<Record<string, unknown>> = {},
  links: LinkRow[] = DEFAULT_LINKS,
  floor: FloorRow | null = GOOD_FLOOR,
) {
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
  const self = {
    hold,
    updates,
    audits,
    inventoryCountHold: {
      findUnique: async () => hold,
      // ADR-0118 — the loser's error message is re-read INSIDE the transaction,
      // so the fake must answer with the state that actually won.
      findUniqueOrThrow: async () => hold,
      update: async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return hold;
      },
      // ADR-0118 — the release gate. Modelled FAITHFULLY rather than as
      // `async () => ({ count: 1 })`: the `where` is re-evaluated against the
      // fixture row and the row is mutated on a hit, so a fixture whose status
      // is not `pending` makes the guard MISS — which is the whole behaviour
      // under test. A fake that always reports a hit cannot fail when the guard
      // stops guarding.
      updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const h = hold as unknown as Record<string, unknown>;
        for (const [k, v] of Object.entries(a.where)) {
          if (k === 'id') continue;
          if (h[k] !== v) return { count: 0 };
        }
        updates.push(a.data);
        for (const [k, v] of Object.entries(a.data)) h[k] = v;
        return { count: 1 };
      },
    },
    user: {
      // The linked floor account, read to confirm it is still an active operator
      // at the hold's site (the link outlives role/site changes).
      findUnique: async () => floor,
      // Two reads share this: the eligible-approver list, and the ADR-0072 Am.2
      // person-link read, which is the only one that filters on `floor_user_id`.
      // The link read is evaluated against `links` the way Postgres would.
      findMany: async (a: { where: Record<string, unknown> }) => {
        if (!JSON.stringify(a.where).includes('floor_user_id')) {
          return [{ id: MANAGER, name: 'Morena Gomez' }];
        }
        const or = a.where['OR'] as Array<Record<string, { in: string[] }>>;
        const ids = or.find((c) => 'id' in c)!['id']!.in;
        return links.filter(
          (r) => ids.includes(r.id) || (r.floor_user_id !== null && ids.includes(r.floor_user_id)),
        );
      },
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
  // ADR-0118 — `releaseHold` now does its work on one transaction. The fake runs
  // the callback against ITSELF, so every write the release makes is still
  // observable through `updates` / `audits`. It does NOT model rollback: that
  // claim is not expressible against a fake at all, and is proven in
  // `anchor-holds.db.test.ts` against a real Postgres.
  return Object.assign(self, {
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(self),
  });
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

  it('ADR-0138 — the release writes the HELD counter, not the approver', async () => {
    const db = fakeDb({ counted_by: 'Chris R', confirmed_by: 'Patrick D' });
    await releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' });
    const args = vi.mocked(reconcilePhysicalCount).mock.calls[0]![0];
    expect(args.countedBy).toBe('Chris R');
    expect(args.confirmedBy).toBe('Patrick D');
    expect(args.actorUserId).toBe(MANAGER);
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

describe('ADR-0072 Am.2 — floor PIN via a linked operator account', () => {
  it('verifies the PIN against the LINKED operator account, and audits whose PIN it was', async () => {
    const db = fakeDb();
    await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'pin',
      pin: 'good',
    });
    expect(verifyPin).toHaveBeenCalledTimes(1);
    expect(verifyPin).toHaveBeenCalledWith(MANAGER_FLOOR, 'good');
    // The approver of record is still the manager account, not the floor one.
    expect(db.updates[0]!['approved_by']).toBe(MANAGER);
    const after = db.audits[0]!['after'] as Record<string, unknown>;
    expect(after['approver_user_id']).toBe(MANAGER);
    expect(after['pin_verified_user_id']).toBe(MANAGER_FLOOR);
  });

  it('a manager with NO link gets no_floor_pin, before any PIN is verified', async () => {
    const db = fakeDb({}, []);
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(NoFloorPinError);
    expect(verifyPin).not.toHaveBeenCalled();
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it('an unlinked manager can still release REMOTELY (the desktop path needs no PIN)', async () => {
    const db = fakeDb({}, []);
    const out = await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'remote',
    });
    expect(out.snapshotId).toBe('snap-new');
    const after = db.audits[0]!['after'] as Record<string, unknown>;
    expect(after['pin_verified_user_id']).toBeNull();
  });

  it('a wrong floor PIN is bad_pin and writes nothing', async () => {
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'wrong',
      }),
    ).rejects.toBeInstanceOf(BadPinError);
    expect(verifyPin).toHaveBeenCalledWith(MANAGER_FLOOR, 'wrong');
    expect(db.updates).toHaveLength(0);
  });

  it.each([
    ['moved to another site', { ...GOOD_FLOOR, primary_site_id: 'site-eugene' }],
    ['promoted off the operator role', { ...GOOD_FLOOR, role: 'manager' }],
    ['deactivated', { ...GOOD_FLOOR, is_active: false }],
    ['deleted', { ...GOOD_FLOOR, deleted_at: new Date('2026-11-01T00:00:00Z') }],
  ])('a linked floor account that was %s is no_floor_pin and no PIN is checked', async (_n, row) => {
    const db = fakeDb({}, DEFAULT_LINKS, row);
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(NoFloorPinError);
    expect(verifyPin).not.toHaveBeenCalled();
    expect(db.updates).toHaveLength(0);
  });

  it('a stale link does NOT dissolve the same-person rule', async () => {
    // Even with the floor account moved away, the person that entered the count
    // is still the person on the manager login: the self-release refusal stands.
    const db = fakeDb({ created_by: MANAGER_FLOOR }, DEFAULT_LINKS, {
      ...GOOD_FLOOR,
      primary_site_id: 'site-eugene',
    });
    await expect(
      releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
  });

  it('a locked-out floor account is pin_locked, not bad_pin, and writes nothing', async () => {
    vi.mocked(verifyPin).mockResolvedValueOnce({
      ok: false,
      reason: 'locked',
      locked_until: new Date('2026-11-06T23:59:00Z'),
    });
    const db = fakeDb();
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(PinLockedError);
    expect(db.updates).toHaveLength(0);
  });

  // ── Four-eyes by PERSON ────────────────────────────────────────────────────
  // Morena counts on her operator login; Morena's manager login must not release
  // it. Refused before the PIN, so the refusal is not a PIN oracle.
  it('PIN path: refuses the manager account linked to the operator who ENTERED it', async () => {
    const db = fakeDb({ created_by: MANAGER_FLOOR });
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    expect(verifyPin).not.toHaveBeenCalled();
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('remote path: the same person cannot release it from the desktop either', async () => {
    const db = fakeDb({ created_by: MANAGER_FLOOR });
    await expect(
      releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path: 'remote' }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    expect(reconcilePhysicalCount).not.toHaveBeenCalled();
  });

  it('the link is found from the CREATOR side too (the approver row alone is not trusted)', async () => {
    // The person-link read returns rows matching either id or either link, so a
    // creator who is the TARGET of a link is matched even when the read is keyed
    // on the creator. Same refusal, both paths.
    for (const path of ['pin', 'remote'] as const) {
      const db = fakeDb({ created_by: OPERATOR }, [{ id: MANAGER, floor_user_id: OPERATOR }]);
      await expect(
        releaseHold(db as never, { holdId: 'hold-1', approverUserId: MANAGER, path, pin: 'good' }),
      ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    }
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it('a count entered on the MANAGER login cannot be released with that person’s floor PIN', async () => {
    const db = fakeDb({ created_by: MANAGER });
    await expect(
      releaseHold(db as never, {
        holdId: 'hold-1',
        approverUserId: MANAGER,
        path: 'pin',
        pin: 'good',
      }),
    ).rejects.toBeInstanceOf(SelfReleaseRefusedError);
    expect(verifyPin).not.toHaveBeenCalled();
  });

  it('a DIFFERENT linked person may release an operator’s count', async () => {
    // Someone else's link must not trip the rule: OPERATOR is unlinked, MANAGER is
    // linked to MANAGER_FLOOR.
    const db = fakeDb({ created_by: OPERATOR });
    const out = await releaseHold(db as never, {
      holdId: 'hold-1',
      approverUserId: MANAGER,
      path: 'pin',
      pin: 'good',
    });
    expect(out.snapshotId).toBe('snap-new');
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

describe('discardHold — ADR-0072 Am.2 CAS (PR #313 review)', () => {
  it('a release that lands between the read and the write wins; discard writes nothing', async () => {
    const db = fakeDb();
    // The pre-read sees `pending`; by the time the guarded write runs, a manager
    // has released it.
    const pendingCopy = { ...db.hold };
    db.inventoryCountHold.findUnique = async () => pendingCopy;
    (db.hold as Record<string, unknown>)['status'] = 'approved';
    await expect(
      discardHold(db as never, { holdId: 'hold-1', userId: OPERATOR, reason: 'x' }),
    ).rejects.toThrow('hold_approved');
    expect(db.updates).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it('writes the status and its audit row on ONE transaction', async () => {
    const db = fakeDb();
    const tx = vi.spyOn(db, '$transaction');
    await discardHold(db as never, { holdId: 'hold-1', userId: OPERATOR, reason: 'typo' });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(db.updates).toHaveLength(1);
    expect(db.audits).toHaveLength(1);
  });
});

describe('countPendingHolds / heldCountsLabel — the dashboard link degrades', () => {
  it('returns the count when the read works', async () => {
    const db = { inventoryCountHold: { count: async () => 3 } };
    expect(await countPendingHolds(db as never, SITE)).toBe(3);
  });

  it('returns null instead of throwing when the read fails', async () => {
    const db = {
      inventoryCountHold: {
        count: async () => {
          throw new Error('connection reset');
        },
      },
    };
    expect(await countPendingHolds(db as never, SITE)).toBeNull();
  });

  it('labels the link, falling back to the plain label', () => {
    expect(heldCountsLabel(2)).toBe('Held counts (2 waiting)');
    expect(heldCountsLabel(0)).toBe('Held counts');
    expect(heldCountsLabel(null)).toBe('Held counts');
  });
});
