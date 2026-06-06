// T-203 — Skip route (ADR-0019.1 bootstrap disposition, ADMIN-ONLY). In-process
// handler tests with mocked auth + Prisma + the state-machine transition. Covers:
//   - anonymous                 -> 401
//   - operator                  -> 403
//   - Janette (Woodland mgr)    -> 403 (managers never skip)
//   - Morena (both-sites mgr)   -> 403
//   - Rick (Eugene mgr)         -> 403
//   - Bill (admin) skips a draft period -> 200 skipped, transition called admin-only
//   - 409 when the period is already past draft
//   - 404 cross-site period id
//   - the state machine's own 403 backstop maps to a 403 response

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransitionForbiddenError, TransitionError } from '@/lib/bonus/state-machine';

// ── session double ───────────────────────────────────────────────
let mockSession: { user: { id: string; role: string; primary_site_id?: string | null } } | null =
  null;
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

// ── side-effect doubles ──────────────────────────────────────────
// Re-export the real error classes so `instanceof` checks in the route still work
// while the transition itself is a spy.
const transitionMonth = vi.fn<(args: unknown) => Promise<unknown>>(async () => ({}));
vi.mock('@/lib/bonus/state-machine', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/bonus/state-machine')>();
  return { ...actual, transitionMonth: (a: unknown) => transitionMonth(a) };
});
vi.mock('@/lib/bonus/signatures', () => ({ recordStateGauge: vi.fn() }));

// ── prisma double ────────────────────────────────────────────────
let periodRow: { id: string; site_id: string; state: string } | null = null;
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        where.code === 'woodland' ? { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' } : null,
      ),
    },
    bonusPayPeriod: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; site_id: string } }) =>
        periodRow && periodRow.id === where.id && periodRow.site_id === where.site_id
          ? { id: periodRow.id, state: periodRow.state }
          : null,
      ),
    },
  },
}));

import { POST } from './route';

const params = Promise.resolve({ id: 'p12' });
const req = () =>
  new Request('http://x/api/bonus/months/p12/skip', {
    method: 'POST',
    headers: { 'x-forwarded-for': '198.51.100.1', 'user-agent': 'Vitest/1.0' },
  });

beforeEach(() => {
  mockSession = null;
  periodRow = { id: 'p12', site_id: WOODLAND, state: 'draft' };
  transitionMonth.mockReset();
  transitionMonth.mockResolvedValue({});
});

describe('POST /api/bonus/months/[id]/skip — role gate (admin-only)', () => {
  it('401 when unauthenticated', async () => {
    expect((await POST(req(), { params })).status).toBe(401);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('403 for operator', async () => {
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect((await POST(req(), { params })).status).toBe(403);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('403 for the Woodland manager (Janette) — managers never skip', async () => {
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    expect((await POST(req(), { params })).status).toBe(403);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('403 for the both-sites manager (Morena)', async () => {
    mockSession = { user: { id: 'morena', role: 'manager', primary_site_id: null } };
    expect((await POST(req(), { params })).status).toBe(403);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('403 for the Eugene manager (Rick)', async () => {
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    expect((await POST(req(), { params })).status).toBe(403);
  });
});

describe('POST /api/bonus/months/[id]/skip — skip flow', () => {
  it('Bill (admin) skips a draft period -> 200 skipped, transition called admin-only', async () => {
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(req(), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: 'skipped' });
    expect(transitionMonth).toHaveBeenCalledTimes(1);
    expect(transitionMonth.mock.calls[0]![0]).toMatchObject({
      monthId: 'p12',
      to: 'skipped',
      actor: { userId: 'bill', isAdmin: true },
    });
  });

  it('409 when the period is already past draft', async () => {
    periodRow = { id: 'p12', site_id: WOODLAND, state: 'pending_signatures' };
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    expect((await POST(req(), { params })).status).toBe(409);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it('404 when the period belongs to another site', async () => {
    periodRow = { id: 'p12', site_id: EUGENE, state: 'draft' };
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    expect((await POST(req(), { params })).status).toBe(404);
    expect(transitionMonth).not.toHaveBeenCalled();
  });

  it("maps the state machine's TransitionForbiddenError backstop to a 403", async () => {
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    transitionMonth.mockRejectedValueOnce(new TransitionForbiddenError('draft', 'skipped'));
    expect((await POST(req(), { params })).status).toBe(403);
  });

  it('maps a TransitionError (illegal edge) to a 409', async () => {
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    transitionMonth.mockRejectedValueOnce(new TransitionError('illegal', 'skipped', 'signed'));
    expect((await POST(req(), { params })).status).toBe(409);
  });
});
