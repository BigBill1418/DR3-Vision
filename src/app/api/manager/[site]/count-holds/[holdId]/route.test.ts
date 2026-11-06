// ADR-0072 Amendment 1 — the remote release/discard route, through the REAL
// handler and the REAL `checkManagerForSite` guard. Only `auth()`, Prisma and the
// two writing service calls are faked; `isHoldAtSite` and the error classes are
// the real ones, so the site-ownership check is tested as wired.
//
// The cross-site case is the reason this file exists: before 2026-11-06 a manager
// authorized for one site could discard another site's held count by putting its
// id under their own site's URL, because `discardHold` checks status only.

import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockSession: {
  user: { id: string; role: string; primary_site_id?: string | null; all_sites?: boolean };
} | null = null;
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

const SITES = [
  { id: 'site-eugene', code: 'eugene', name: 'Eugene' },
  { id: 'site-woodland', code: 'woodland', name: 'Woodland' },
];
const HOLDS: Record<string, { site_id: string }> = {
  'hold-w': { site_id: 'site-woodland' },
  'hold-e': { site_id: 'site-eugene' },
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(
        async ({ where }: { where: { code: string } }) =>
          SITES.find((s) => s.code === where.code) ?? null,
      ),
    },
    inventoryCountHold: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => HOLDS[where.id] ?? null),
    },
  },
}));

const { releaseHold, discardHold } = vi.hoisted(() => ({
  releaseHold: vi.fn(),
  discardHold: vi.fn(),
}));
vi.mock('@/lib/inventory/anchor-holds', async (orig) => ({
  ...(await orig<typeof import('@/lib/inventory/anchor-holds')>()),
  releaseHold,
  discardHold,
}));
vi.mock('@/lib/observability/logger', () => ({ log: { error: vi.fn() } }));

import { DELETE, POST } from './route';
import {
  HoldNotPendingError,
  NotAManagerError,
  SelfReleaseRefusedError,
} from '@/lib/inventory/anchor-holds';

const params = (site: string, holdId: string) => ({ params: Promise.resolve({ site, holdId }) });
const post = (site: string, holdId: string) =>
  POST(new Request('http://x', { method: 'POST' }), params(site, holdId));
const del = (site: string, holdId: string, body: unknown) =>
  DELETE(
    new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) }),
    params(site, holdId),
  );

const woodlandManager = () => {
  mockSession = { user: { id: 'mgr-w', role: 'manager', primary_site_id: 'site-woodland' } };
};

beforeEach(() => {
  vi.clearAllMocks();
  woodlandManager();
  releaseHold.mockResolvedValue({
    snapshotId: 'snap-1',
    classification: { newTotal: 1200, prior: { total: 2483 } },
  });
  discardHold.mockResolvedValue(undefined);
});

describe('POST — approve remotely', () => {
  it('releases a hold at the manager’s site, as the session user, on the remote path', async () => {
    const res = await post('woodland', 'hold-w');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ released: true, newTotal: 1200, priorTotal: 2483 });
    expect(releaseHold).toHaveBeenCalledWith(expect.anything(), {
      holdId: 'hold-w',
      approverUserId: 'mgr-w',
      path: 'remote',
    });
  });

  it('answers another site’s hold exactly like a missing one, and writes nothing', async () => {
    mockSession = { user: { id: 'adm', role: 'admin' } };
    const res = await post('woodland', 'hold-e');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'hold_not_found' });
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('refuses no session 401 and an operator 403 before reading the hold', async () => {
    mockSession = null;
    expect((await post('woodland', 'hold-w')).status).toBe(401);
    mockSession = { user: { id: 'op', role: 'operator', primary_site_id: 'site-woodland' } };
    expect((await post('woodland', 'hold-w')).status).toBe(403);
    expect(releaseHold).not.toHaveBeenCalled();
  });

  it('names the self-release, not-a-manager and not-pending refusals', async () => {
    releaseHold.mockRejectedValueOnce(new SelfReleaseRefusedError('x'));
    let res = await post('woodland', 'hold-w');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('operator_cannot_self_release');

    releaseHold.mockRejectedValueOnce(new NotAManagerError('x'));
    res = await post('woodland', 'hold-w');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_a_manager');

    releaseHold.mockRejectedValueOnce(new HoldNotPendingError('hold_approved'));
    res = await post('woodland', 'hold-w');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('hold_approved');
  });
});

describe('DELETE — discard remotely', () => {
  it('discards with the reason, as the session user', async () => {
    const res = await del('woodland', 'hold-w', { reason: 'duplicate entry' });
    expect(res.status).toBe(200);
    expect(discardHold).toHaveBeenCalledWith(expect.anything(), {
      holdId: 'hold-w',
      userId: 'mgr-w',
      reason: 'duplicate entry',
    });
  });

  it('refuses a missing reason 422', async () => {
    const res = await del('woodland', 'hold-w', { reason: '' });
    expect(res.status).toBe(422);
    expect(discardHold).not.toHaveBeenCalled();
  });

  it('will not discard another site’s hold through this site’s URL', async () => {
    const res = await del('woodland', 'hold-e', { reason: 'not mine' });
    expect(res.status).toBe(404);
    expect(discardHold).not.toHaveBeenCalled();
  });
});
