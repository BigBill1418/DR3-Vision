// ADR-0105 — the AUTHORIZATION falsifications for the manager correction route.
//
// The service-level gates (window, audit, chain, delta) are falsified in
// `src/lib/inventory/correct-count.test.ts`. This file exists for the one claim
// that CANNOT be tested there, because it lives in the transport: **a
// non-manager is refused, and operators keep exactly what they already have.**
//
// Tested through the REAL route handler and the REAL `requireManagerForSite`
// guard, not through a stub of either — the whole point is that the wiring is
// right, and a test that mocked the guard would pass against a route that forgot
// to call it. Only `auth()` and Prisma are faked.
//
// The role check runs BEFORE the site lookup and before any snapshot read, so
// these cases never reach the correction service. That is asserted rather than
// assumed: `serviceCalls` counts every touch of the snapshot table, and a refusal
// that got as far as reading a count would fail here even while returning the
// right status.

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: {
  user: { id: string; role: string; primary_site_id?: string | null; all_sites?: boolean };
} | null = null;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

/** Every read/write the correction path would perform, counted. */
let serviceCalls: string[] = [];

const sites = new Map([
  ['site-eugene', { id: 'site-eugene', code: 'eugene', name: 'Eugene' }],
  ['site-woodland', { id: 'site-woodland', code: 'woodland', name: 'Woodland' }],
]);

vi.mock('@/lib/prisma', () => {
  const track =
    (label: string, result: unknown = null) =>
    async () => {
      serviceCalls.push(label);
      return result;
    };
  return {
    prisma: {
      site: {
        findUnique: vi.fn(async ({ where }: { where: { code?: string; id?: string } }) => {
          if (where.code) {
            for (const s of sites.values()) if (s.code === where.code) return s;
            return null;
          }
          return where.id ? (sites.get(where.id) ?? null) : null;
        }),
      },
      // The correction service's reads. Returning null means "no such snapshot",
      // so an ALLOWED caller gets a 404 — which is exactly the discrimination we
      // want: 403 = refused at the gate, 404 = past the gate.
      siteInventorySnapshot: {
        findUnique: track('snapshot.findUnique'),
        findMany: track('snapshot.findMany', []),
        updateMany: track('snapshot.updateMany', { count: 0 }),
        create: track('snapshot.create'),
      },
      auditLog: { findFirst: track('audit.findFirst'), findMany: track('audit.findMany', []) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        // Mirrors the real client shape closely enough for the gate tests: the
        // route must never reach here for a refused caller.
        serviceCalls.push('$transaction');
        return fn({
          siteInventorySnapshot: {
            findUnique: track('snapshot.findUnique'),
            updateMany: track('snapshot.updateMany', { count: 0 }),
            create: track('snapshot.create'),
          },
          auditLog: { findFirst: track('audit.findFirst'), findMany: track('audit.findMany', []) },
          $executeRaw: track('executeRaw', 1),
          $queryRaw: track('queryRaw', []),
        });
      },
    },
  };
});

// The ADR-0037 D7 rollout gate is stubbed OPEN so these tests isolate the ROLE
// check. Leaving it live would let a not-activated site produce the same 403 a
// wrong role does, and the test could not tell which gate fired.
vi.mock('@/lib/loads/record-guards', async (orig) => ({
  ...(await orig<typeof import('@/lib/loads/record-guards')>()),
  assertLoadsInventoryActivated: async () => {},
}));

import { POST, GET } from './route';

const call = (site: string, id = 'snap-1', body: unknown = { units_total: 5 }) =>
  POST(new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ site, id }),
  });

beforeEach(() => {
  serviceCalls = [];
  mockSession = null;
});

describe('ADR-0105 — who may correct a count', () => {
  it('an OPERATOR is refused 403 and never reaches the count', async () => {
    // The audience ADR-0084 serves. They keep their same-day self-void at
    // /api/operator/[site]/count/void; this route grants them nothing.
    mockSession = { user: { id: 'user-jt', role: 'operator', primary_site_id: 'site-eugene' } };
    const res = await call('eugene');
    expect(res.status).toBe(403);
    expect(
      serviceCalls,
      'an operator was refused, but only after the correction service had already ' +
        'read the count — the role gate is not the first thing that runs',
    ).toEqual([]);
  });

  it('an anonymous caller is refused 401', async () => {
    mockSession = null;
    expect((await call('eugene')).status).toBe(401);
    expect(serviceCalls).toEqual([]);
  });

  it('a manager of the OTHER site is refused 403 (hard rule #2)', async () => {
    mockSession = {
      user: { id: 'user-rick', role: 'manager', primary_site_id: 'site-eugene', all_sites: false },
    };
    expect((await call('woodland')).status).toBe(403);
    expect(serviceCalls).toEqual([]);
  });

  it('an unknown site code is 404', async () => {
    mockSession = {
      user: { id: 'user-rick', role: 'manager', primary_site_id: 'site-eugene', all_sites: false },
    };
    expect((await call('stockton')).status).toBe(404);
    expect(serviceCalls).toEqual([]);
  });

  it('the site manager IS admitted — the refusals above are the ROLE, not a dead route', async () => {
    // Without this, every assertion above would pass against a handler that
    // refused everyone, and the suite would be measuring nothing.
    mockSession = {
      user: {
        id: 'user-morena',
        role: 'manager',
        primary_site_id: 'site-eugene',
        all_sites: false,
      },
    };
    const res = await call('eugene');
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    // Admitted, reached the service, and 404'd on the nonexistent snapshot id —
    // which is the correct answer and proves the gate was passed.
    expect(serviceCalls).toContain('snapshot.findUnique');
    expect(res.status).toBe(404);
  });

  it('an ADMIN is admitted (unconditional, per requireManagerForSite)', async () => {
    mockSession = { user: { id: 'user-bill', role: 'admin', primary_site_id: null } };
    expect((await call('woodland')).status).toBe(404);
    expect(serviceCalls).toContain('snapshot.findUnique');
  });

  it('an all-sites manager (ADR-0024) reaches either site', async () => {
    mockSession = {
      user: { id: 'user-daven', role: 'manager', primary_site_id: 'site-eugene', all_sites: true },
    };
    expect((await call('woodland')).status).toBe(404);
  });

  it('the correctable LIST is gated the same way', async () => {
    mockSession = { user: { id: 'user-jt', role: 'operator', primary_site_id: 'site-eugene' } };
    const res = await GET(new Request('http://localhost/x'), {
      params: Promise.resolve({ site: 'eugene' }),
    });
    expect(res.status).toBe(403);
    expect(serviceCalls).toEqual([]);
  });

  it('a malformed body is 422, and only AFTER the caller is authorized', async () => {
    mockSession = {
      user: {
        id: 'user-morena',
        role: 'manager',
        primary_site_id: 'site-eugene',
        all_sites: false,
      },
    };
    const res = await call('eugene', 'snap-1', { units_in_processing: -4 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'invalid_input' });
    // Validation refused it before any snapshot was touched.
    expect(serviceCalls).toEqual([]);
  });
});
