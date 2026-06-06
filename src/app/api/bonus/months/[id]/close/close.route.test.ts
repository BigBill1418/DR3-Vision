import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── session double ───────────────────────────────────────────────
let mockSession: { user: { id: string; role: string; primary_site_id?: string | null } } | null =
  null;
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

// ── side-effect doubles ──────────────────────────────────────────
const transitionMonth = vi.fn<(args: unknown) => Promise<unknown>>(async () => ({}));
const notifyPendingSigner = vi.fn<(id: string) => Promise<{ notified: boolean }>>(async () => ({
  notified: true,
}));
vi.mock('@/lib/bonus/state-machine', () => ({
  transitionMonth: (a: unknown) => transitionMonth(a),
}));
vi.mock('@/lib/bonus/signature-notifications', () => ({
  notifyPendingSigner: (id: string) => notifyPendingSigner(id),
}));
vi.mock('@/lib/bonus/signatures', () => ({ recordStateGauge: vi.fn() }));

// ── prisma double ────────────────────────────────────────────────
let monthRow: { id: string; site_id: string; state: string } | null = null;
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        where.code === 'woodland' ? { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' } : null,
      ),
    },
    bonusMonth: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; site_id: string } }) =>
        monthRow && monthRow.id === where.id && monthRow.site_id === where.site_id
          ? { id: monthRow.id, state: monthRow.state }
          : null,
      ),
    },
  },
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'm1' });
const req = () => new Request('http://x/api/bonus/months/m1/close', { method: 'POST' });

beforeEach(() => {
  mockSession = null;
  monthRow = { id: 'm1', site_id: WOODLAND, state: 'draft' };
  transitionMonth.mockClear();
  notifyPendingSigner.mockClear();
});

describe('POST /api/bonus/months/[id]/close — role gate', () => {
  it('401 when unauthenticated', async () => {
    expect((await POST(req(), { params })).status).toBe(401);
    expect(transitionMonth).not.toHaveBeenCalled();
  });
  it('403 for operator', async () => {
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect((await POST(req(), { params })).status).toBe(403);
  });
  it('403 for the Eugene manager (Rick)', async () => {
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    expect((await POST(req(), { params })).status).toBe(403);
  });
});

describe('POST /api/bonus/months/[id]/close — close flow', () => {
  it('closes a draft month and emails the facility signer', async () => {
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'pending_signatures' });
    expect(transitionMonth).toHaveBeenCalledTimes(1);
    expect(transitionMonth.mock.calls[0]![0]).toMatchObject({
      monthId: 'm1',
      to: 'pending_signatures',
      actor: { userId: 'janette' },
    });
    // fire-and-forget notify; allow the microtask to run
    await Promise.resolve();
    expect(notifyPendingSigner).toHaveBeenCalledWith('m1');
  });

  it('409 when the month is already past draft', async () => {
    monthRow = { id: 'm1', site_id: WOODLAND, state: 'pending_signatures' };
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    expect((await POST(req(), { params })).status).toBe(409);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('404 when the month belongs to another site', async () => {
    monthRow = { id: 'm1', site_id: EUGENE, state: 'draft' };
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    expect((await POST(req(), { params })).status).toBe(404);
  });
});
