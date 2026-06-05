import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the session + prisma site lookup, then exercise the real guard.
let mockSession: unknown = null;
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

const WOODLAND_ID = 'site-woodland';
const EUGENE_ID = 'site-eugene';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) =>
        where.code === 'woodland'
          ? { id: WOODLAND_ID, code: 'woodland', name: 'DR3 Woodland' }
          : null,
      ),
    },
  },
}));

import { requireBonusAccess, checkBonusAccess } from './access';

function session(over: Record<string, unknown>) {
  return { user: { id: 'u1', name: 'Test', email: 't@svdp.us', ...over } };
}

beforeEach(() => {
  mockSession = null;
});

describe('requireBonusAccess — allow paths', () => {
  it('allows admin (Bill) unconditionally', async () => {
    mockSession = session({ role: 'admin', primary_site_id: null });
    const ctx = await requireBonusAccess();
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.siteId).toBe(WOODLAND_ID);
  });

  it('allows the Woodland manager (Janette)', async () => {
    mockSession = session({ role: 'manager', primary_site_id: WOODLAND_ID });
    const ctx = await requireBonusAccess();
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.role).toBe('manager');
    expect(ctx.siteId).toBe(WOODLAND_ID);
  });

  it('allows the both-sites operations manager (Morena, primary_site_id null)', async () => {
    mockSession = session({ role: 'manager', primary_site_id: null });
    const ctx = await requireBonusAccess();
    expect(ctx.siteId).toBe(WOODLAND_ID);
  });
});

describe('requireBonusAccess — deny paths', () => {
  async function expectStatus(fn: () => Promise<unknown>, status: number) {
    await expect(fn()).rejects.toMatchObject({ status });
  }

  it('rejects anonymous with 401', async () => {
    mockSession = null;
    await expectStatus(requireBonusAccess, 401);
  });

  it('rejects the Eugene manager (Rick) with 403', async () => {
    mockSession = session({ role: 'manager', primary_site_id: EUGENE_ID });
    await expectStatus(requireBonusAccess, 403);
  });

  it('rejects operators with 403', async () => {
    mockSession = session({ role: 'operator', primary_site_id: WOODLAND_ID });
    await expectStatus(requireBonusAccess, 403);
  });
});

describe('checkBonusAccess — discriminated result', () => {
  it('returns ok:true for admin', async () => {
    mockSession = session({ role: 'admin', primary_site_id: null });
    const r = await checkBonusAccess();
    expect(r.ok).toBe(true);
  });

  it('returns ok:false status 403 for Rick', async () => {
    mockSession = session({ role: 'manager', primary_site_id: EUGENE_ID });
    const r = await checkBonusAccess();
    expect(r).toEqual({ ok: false, status: 403 });
  });
});
