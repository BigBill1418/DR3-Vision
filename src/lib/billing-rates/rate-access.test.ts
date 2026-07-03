// ADR-0040 D5 — scoped rate-write access gate matrix.
//
// Proves:
//   - requireRateManager grants for admin (via=admin) and for a manager WITH
//     can_manage_rates (via=can_manage_rates); denies a plain manager (403), an
//     operator (403), and anonymous (401).
//   - requireRateRead grants manager+admin, denies operator.
//   - THE INVARIANT: can_manage_rates does NOT unlock any admin power. The same
//     flag-holding manager is rejected (403) by (1) requireAdmin and by two REAL
//     existing admin routes — /api/admin/audit and /api/admin/users.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: { user: { id: string; role: string } } | null = null;
let mockCanManageRates = false;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ can_manage_rates: mockCanManageRates })),
    },
    // Present so the admin-route module graph loads; the 403 gate short-circuits
    // before any of these are reached.
    auditLog: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
  },
}));

import {
  requireRateManager,
  requireRateRead,
  requireAdmin,
} from '@/lib/auth-helpers';

async function statusOf(run: () => Promise<Response | unknown>): Promise<number> {
  try {
    const r = await run();
    if (r instanceof Response) return r.status;
    return 200; // resolved to a non-Response context object = allowed
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

beforeEach(() => {
  mockSession = null;
  mockCanManageRates = false;
});

describe('requireRateManager — write gate', () => {
  it('grants an admin (via=admin)', async () => {
    mockSession = { user: { id: 'kelsey', role: 'admin' } };
    expect(await requireRateManager()).toEqual({ userId: 'kelsey', role: 'admin', via: 'admin' });
  });

  it('grants a manager holding can_manage_rates (via=can_manage_rates)', async () => {
    mockSession = { user: { id: 'rick', role: 'manager' } };
    mockCanManageRates = true;
    expect(await requireRateManager()).toEqual({
      userId: 'rick',
      role: 'manager',
      via: 'can_manage_rates',
    });
  });

  it('denies a manager WITHOUT the flag (403)', async () => {
    mockSession = { user: { id: 'morena', role: 'manager' } };
    mockCanManageRates = false;
    expect(await statusOf(requireRateManager)).toBe(403);
  });

  it('denies an operator (403) and anonymous (401)', async () => {
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect(await statusOf(requireRateManager)).toBe(403);
    mockSession = null;
    expect(await statusOf(requireRateManager)).toBe(401);
  });
});

describe('requireRateRead — read gate', () => {
  it('grants manager + admin, denies operator', async () => {
    mockSession = { user: { id: 'm', role: 'manager' } };
    expect((await requireRateRead()).role).toBe('manager');
    mockSession = { user: { id: 'a', role: 'admin' } };
    expect((await requireRateRead()).role).toBe('admin');
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect(await statusOf(requireRateRead)).toBe(403);
  });
});

describe('the flag does NOT unlock any admin power', () => {
  it('requireAdmin still 403s a manager holding can_manage_rates', async () => {
    mockSession = { user: { id: 'rick', role: 'manager' } };
    mockCanManageRates = true;
    expect(await statusOf(requireAdmin)).toBe(403);
  });

  it('two real admin routes (audit, users) 403 the flag-holding manager', async () => {
    mockSession = { user: { id: 'rick', role: 'manager' } };
    mockCanManageRates = true;
    const req = new Request('http://127.0.0.1/api/admin/x');

    const { GET: auditGet } = await import('@/app/api/admin/audit/route');
    expect(await statusOf(() => auditGet(req))).toBe(403);

    const { GET: usersGet } = await import('@/app/api/admin/users/route');
    expect(await statusOf(() => usersGet(req))).toBe(403);
  });
});
