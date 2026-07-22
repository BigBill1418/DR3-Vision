import { describe, it, expect, vi, beforeEach } from 'vitest';

// Exercise the real `requireManagerForSite` guard against a mocked session +
// site lookup. Focus: the ADR-0024 all-sites manager — a manager whose
// `all_sites` flag is set reaches ANY site, where a plain manager is hard-scoped
// to `primary_site_id`.
let mockSession: unknown = null;
// Keyed by user id → the columns requireApHistoryRead selects (can_view_ap_history).
let mockUsers: Record<string, { can_view_ap_history?: boolean }> = {};

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

const WOODLAND_ID = 'site-woodland';
const EUGENE_ID = 'site-eugene';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async ({ where }: { where: { code?: string } }) => {
        if (where.code === 'woodland')
          return { id: WOODLAND_ID, code: 'woodland', name: 'DR3 Woodland' };
        if (where.code === 'eugene') return { id: EUGENE_ID, code: 'eugene', name: 'DR3 Eugene' };
        return null;
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
        where.id && mockUsers[where.id] ? mockUsers[where.id] : null,
      ),
    },
  },
}));

import { requireManagerForSite, checkManagerForSite, checkApHistoryRead } from './auth-helpers';

function session(over: Record<string, unknown>): void {
  mockSession = { user: { id: 'u1', name: 'Test', email: 't@svdp.us', ...over } };
}

beforeEach(() => {
  mockSession = null;
  mockUsers = {};
});

describe('requireManagerForSite — ADR-0024 all-sites manager', () => {
  it('plain Eugene manager requesting woodland → 403 (regression guard)', async () => {
    session({ role: 'manager', primary_site_id: EUGENE_ID });
    const r = await checkManagerForSite('woodland');
    expect(r).toEqual({ ok: false, status: 403 });
  });

  it('all-sites manager requesting woodland → allowed (off their primary site)', async () => {
    session({ role: 'manager', primary_site_id: EUGENE_ID, all_sites: true });
    const ctx = await requireManagerForSite('woodland');
    expect(ctx.siteCode).toBe('woodland');
    expect(ctx.role).toBe('manager');
  });

  it('all-sites manager requesting eugene → allowed (their primary site too)', async () => {
    session({ role: 'manager', primary_site_id: EUGENE_ID, all_sites: true });
    const ctx = await requireManagerForSite('eugene');
    expect(ctx.siteCode).toBe('eugene');
  });

  it('plain Eugene manager requesting eugene → allowed (unchanged)', async () => {
    session({ role: 'manager', primary_site_id: EUGENE_ID });
    const ctx = await requireManagerForSite('eugene');
    expect(ctx.siteCode).toBe('eugene');
  });

  it('operator → 403 regardless of all_sites', async () => {
    session({ role: 'operator', primary_site_id: EUGENE_ID, all_sites: true });
    const r = await checkManagerForSite('eugene');
    expect(r).toEqual({ ok: false, status: 403 });
  });
});

// ADR-0046 Amendment 5 (D-M5-5) — /admin/ap/history read gate. Admins + the
// designated second approvers (via can_view_ap_history) only; the general
// ap_approvers roster (operators/managers WITHOUT the flag) is refused.
describe('checkApHistoryRead — AP invoice-history gate', () => {
  it('no session → 401', async () => {
    mockSession = null;
    expect(await checkApHistoryRead()).toEqual({ ok: false, status: 401 });
  });

  it('admin → granted via admin (no DB flag needed)', async () => {
    session({ role: 'admin' });
    const r = await checkApHistoryRead();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.via).toBe('admin');
  });

  it('non-admin WITHOUT the flag → 403 (general roster is excluded)', async () => {
    session({ role: 'manager' });
    mockUsers['u1'] = { can_view_ap_history: false };
    expect(await checkApHistoryRead()).toEqual({ ok: false, status: 403 });
  });

  it('operator WITHOUT the flag → 403', async () => {
    session({ role: 'operator' });
    expect(await checkApHistoryRead()).toEqual({ ok: false, status: 403 });
  });

  it('designated second approver (flag set) → granted via can_view_ap_history', async () => {
    session({ role: 'manager' });
    mockUsers['u1'] = { can_view_ap_history: true };
    const r = await checkApHistoryRead();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.via).toBe('can_view_ap_history');
  });
});
