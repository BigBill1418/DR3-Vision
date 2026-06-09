import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the session + prisma site lookups, then exercise the real guard.
// The matrix maps a manager's `primary_site_id` (a uuid) → site code, so the
// prisma mock answers both findUnique-by-id (id → code) and findUnique-by-code
// (code → row) shapes.
let mockSession: unknown = null;
let mockCookie: string | undefined;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === 'dr3_bonus_site' && mockCookie ? { value: mockCookie } : undefined,
  })),
}));

const WOODLAND_ID = 'site-woodland';
const EUGENE_ID = 'site-eugene';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id) {
          if (where.id === WOODLAND_ID) return { code: 'woodland' };
          if (where.id === EUGENE_ID) return { code: 'eugene' };
          return null;
        }
        if (where.code === 'woodland')
          return { id: WOODLAND_ID, code: 'woodland', name: 'DR3 Woodland' };
        if (where.code === 'eugene') return { id: EUGENE_ID, code: 'eugene', name: 'DR3 Eugene' };
        return null;
      }),
    },
  },
}));

import { checkBonusAccess, requireBonusAccess, tryBonusAccess } from './access';

type SessionArg = Parameters<typeof checkBonusAccess>[0];

function session(over: Record<string, unknown>): SessionArg {
  return { user: { id: 'u1', name: 'Test', email: 't@svdp.us', ...over } } as SessionArg;
}

// Role/site fixtures from ADR-0019.2 §1.
const BILL = session({ role: 'admin', primary_site_id: null });
const JANETTE = session({ role: 'manager', primary_site_id: WOODLAND_ID });
const RICK = session({ role: 'manager', primary_site_id: EUGENE_ID });
const MORENA = session({ role: 'manager', primary_site_id: null });
const OPERATOR = session({ role: 'operator', primary_site_id: WOODLAND_ID });

// T-312 (ADR-0023): Patrick Dills — a NEW Eugene manager. Same access shape as
// Rick (manager primary_site_id = eugene) → Eugene-scoped bonus access under the
// EXISTING manager+ rule, no production change. (His non-membership in any Eugene
// signature-chain slot — separation of duties, he is also a BonusEmployee at
// Eugene — is asserted in signature-chain.test.ts / signatures.test.ts.)
const PATRICK = session({ id: 'patrick', role: 'manager', primary_site_id: EUGENE_ID });

// ADR-0024: Kelsey Ruhland — an all-sites MANAGER (not admin). `all_sites=true`
// grants every site like an admin, but she keeps role=manager so she gets NONE
// of the admin-only powers (user mgmt, amendment, override). Her primary_site_id
// is incidental once all_sites is set.
const KELSEY = session({
  id: 'kelsey',
  role: 'manager',
  primary_site_id: EUGENE_ID,
  all_sites: true,
});

beforeEach(() => {
  mockSession = null;
  mockCookie = undefined;
});

describe('checkBonusAccess — ADR-0019.2 §1 matrix (no requestedSite)', () => {
  it('admin (Bill, Kelsey) → both sites', async () => {
    expect(await checkBonusAccess(BILL)).toEqual({
      allowed: true,
      sites: ['woodland', 'eugene'],
    });
  });

  it('Woodland manager (Janette) → woodland only', async () => {
    expect(await checkBonusAccess(JANETTE)).toEqual({ allowed: true, sites: ['woodland'] });
  });

  it('Eugene manager (Rick) → eugene only', async () => {
    expect(await checkBonusAccess(RICK)).toEqual({ allowed: true, sites: ['eugene'] });
  });

  // T-312 (ADR-0023): Patrick Dills qualifies for Eugene bonus access under the
  // SAME manager+ rule as Rick — no production code change to access.ts.
  it('Eugene manager (Patrick Dills, T-312) → eugene only', async () => {
    expect(await checkBonusAccess(PATRICK)).toEqual({ allowed: true, sites: ['eugene'] });
  });

  it('California-ops manager (Morena, primary_site_id null) → woodland only, NO eugene', async () => {
    expect(await checkBonusAccess(MORENA)).toEqual({ allowed: true, sites: ['woodland'] });
  });

  // ADR-0024: all-sites manager (Kelsey) reaches both sites like an admin would,
  // but via the all_sites flag rather than the admin role.
  it('all-sites manager (Kelsey, all_sites=true) → both sites', async () => {
    expect(await checkBonusAccess(KELSEY)).toEqual({
      allowed: true,
      sites: ['woodland', 'eugene'],
    });
  });

  it('operator → denied, empty sites', async () => {
    expect(await checkBonusAccess(OPERATOR)).toEqual({ allowed: false, sites: [] });
  });

  it('no session → denied, empty sites', async () => {
    expect(await checkBonusAccess(null)).toEqual({ allowed: false, sites: [] });
  });
});

describe('checkBonusAccess — requestedSite narrowing', () => {
  it('Janette requesting woodland → allowed', async () => {
    expect(await checkBonusAccess(JANETTE, 'woodland')).toEqual({
      allowed: true,
      sites: ['woodland'],
    });
  });

  it('Janette requesting eugene → 403 (denied, empty)', async () => {
    expect(await checkBonusAccess(JANETTE, 'eugene')).toEqual({ allowed: false, sites: [] });
  });

  it('Rick requesting eugene → allowed', async () => {
    expect(await checkBonusAccess(RICK, 'eugene')).toEqual({ allowed: true, sites: ['eugene'] });
  });

  it('Rick requesting woodland → denied', async () => {
    expect(await checkBonusAccess(RICK, 'woodland')).toEqual({ allowed: false, sites: [] });
  });

  // T-312 (ADR-0023): Patrick is Eugene-scoped — granted eugene, denied woodland.
  it('Patrick (T-312) requesting eugene → allowed', async () => {
    expect(await checkBonusAccess(PATRICK, 'eugene')).toEqual({ allowed: true, sites: ['eugene'] });
  });

  it('Patrick (T-312) requesting woodland → denied (Eugene-scoped)', async () => {
    expect(await checkBonusAccess(PATRICK, 'woodland')).toEqual({ allowed: false, sites: [] });
  });

  it('Morena requesting eugene → denied (California-ops, no Oregon)', async () => {
    expect(await checkBonusAccess(MORENA, 'eugene')).toEqual({ allowed: false, sites: [] });
  });

  it('Bill requesting eugene → narrowed to eugene', async () => {
    expect(await checkBonusAccess(BILL, 'eugene')).toEqual({ allowed: true, sites: ['eugene'] });
  });

  it('Bill requesting woodland → narrowed to woodland', async () => {
    expect(await checkBonusAccess(BILL, 'woodland')).toEqual({
      allowed: true,
      sites: ['woodland'],
    });
  });

  // ADR-0024: an all-sites manager narrows to either requested site, like an admin.
  it('Kelsey (all-sites manager) requesting eugene → allowed', async () => {
    expect(await checkBonusAccess(KELSEY, 'eugene')).toEqual({ allowed: true, sites: ['eugene'] });
  });

  it('Kelsey (all-sites manager) requesting woodland → allowed', async () => {
    expect(await checkBonusAccess(KELSEY, 'woodland')).toEqual({
      allowed: true,
      sites: ['woodland'],
    });
  });
});

describe('requireBonusAccess — effective site resolution', () => {
  it('Janette → Woodland context', async () => {
    mockSession = JANETTE;
    const ctx = await requireBonusAccess();
    expect(ctx.siteId).toBe(WOODLAND_ID);
    expect(ctx.siteCode).toBe('woodland');
    expect(ctx.allowedSites).toEqual(['woodland']);
    expect(ctx.isAdmin).toBe(false);
  });

  it('Rick → Eugene context', async () => {
    mockSession = RICK;
    const ctx = await requireBonusAccess();
    expect(ctx.siteId).toBe(EUGENE_ID);
    expect(ctx.siteCode).toBe('eugene');
    expect(ctx.allowedSites).toEqual(['eugene']);
  });

  it('Morena → Woodland context (California-ops scoped)', async () => {
    mockSession = MORENA;
    const ctx = await requireBonusAccess();
    expect(ctx.siteId).toBe(WOODLAND_ID);
  });

  it('admin with no pick → defaults to first allowed site (woodland)', async () => {
    mockSession = BILL;
    const ctx = await requireBonusAccess();
    expect(ctx.siteCode).toBe('woodland');
    expect(ctx.allowedSites).toEqual(['woodland', 'eugene']);
  });

  it('admin with eugene cookie → Eugene context', async () => {
    mockSession = BILL;
    mockCookie = 'eugene';
    const ctx = await requireBonusAccess();
    expect(ctx.siteCode).toBe('eugene');
  });

  it('explicit requestedSite beats the cookie', async () => {
    mockSession = BILL;
    mockCookie = 'eugene';
    const ctx = await requireBonusAccess('woodland');
    expect(ctx.siteCode).toBe('woodland');
  });

  it('admin requesting eugene → Eugene context', async () => {
    mockSession = BILL;
    const ctx = await requireBonusAccess('eugene');
    expect(ctx.siteCode).toBe('eugene');
  });
});

describe('requireBonusAccess — deny paths', () => {
  async function expectStatus(fn: () => Promise<unknown>, status: number) {
    await expect(fn()).rejects.toMatchObject({ status });
  }

  it('anonymous → 401', async () => {
    mockSession = null;
    await expectStatus(() => requireBonusAccess(), 401);
  });

  it('operator → 403', async () => {
    mockSession = OPERATOR;
    await expectStatus(() => requireBonusAccess(), 403);
  });

  it('Janette requesting eugene → 403', async () => {
    mockSession = JANETTE;
    await expectStatus(() => requireBonusAccess('eugene'), 403);
  });

  it('Rick requesting woodland → 403', async () => {
    mockSession = RICK;
    await expectStatus(() => requireBonusAccess('woodland'), 403);
  });
});

describe('tryBonusAccess — page-friendly discriminated result', () => {
  it('ok:true with ctx for admin', async () => {
    mockSession = BILL;
    const r = await tryBonusAccess();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ctx.siteCode).toBe('woodland');
  });

  it('ok:false 403 for Rick requesting woodland', async () => {
    mockSession = RICK;
    const r = await tryBonusAccess('woodland');
    expect(r).toEqual({ ok: false, status: 403 });
  });

  it('ok:false 401 for anonymous', async () => {
    mockSession = null;
    const r = await tryBonusAccess();
    expect(r).toEqual({ ok: false, status: 401 });
  });
});
