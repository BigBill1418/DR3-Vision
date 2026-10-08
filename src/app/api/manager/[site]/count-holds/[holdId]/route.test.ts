// CF-5 — ADR-0024 site isolation on the REMOTE hold routes (ADR-0072).
//
// The manager gate proves the caller may act at the site in the URL. Pre-fix,
// the hold id was then handed to the library without that site, so a manager
// at one site could discard another site's held count by id
// (`/api/manager/<own-site>/count-holds/<other-site-hold-id>`). A hold at
// another site must be the same 404 as a hold that does not exist, on every
// method, and nothing may be written.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { checkManagerForSite, findUnique, updateMany, update, auditCreate, transaction } =
  vi.hoisted(() => ({
    checkManagerForSite: vi.fn(async () => ({
      ok: true as const,
      ctx: {
        userId: 'u-manager',
        siteId: 'site-woodland',
        siteCode: 'woodland',
        siteName: 'Woodland',
        role: 'manager' as const,
      },
    })),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
    auditCreate: vi.fn(),
    transaction: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    inventoryCountHold: { findUnique, updateMany, update },
    auditLog: { create: auditCreate },
    $transaction: transaction,
  },
}));
vi.mock('@/lib/auth-helpers', () => ({ checkManagerForSite }));
vi.mock('@/lib/observability/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { DELETE, POST } from './route';

function call(method: 'POST' | 'DELETE', holdId = 'hold-1'): Promise<Response> {
  const req = new Request(`http://127.0.0.1:3000/api/manager/woodland/count-holds/${holdId}`, {
    method,
    body: method === 'DELETE' ? JSON.stringify({ reason: 'duplicate count' }) : null,
    headers: { 'content-type': 'application/json' },
  });
  const ctx = { params: Promise.resolve({ site: 'woodland', holdId }) };
  return method === 'POST' ? POST(req, ctx) : DELETE(req, ctx);
}

beforeEach(() => vi.clearAllMocks());

describe('CF-5 — /api/manager/[site]/count-holds/[holdId] is site-scoped', () => {
  for (const method of ['POST', 'DELETE'] as const) {
    it(`${method}: another site’s hold is the missing-hold 404 and nothing is written`, async () => {
      findUnique.mockResolvedValue({
        id: 'hold-1',
        site_id: 'site-eugene',
        status: 'pending',
        created_by: 'u-operator',
      });
      const cross = await call(method);
      findUnique.mockResolvedValue(null);
      const missing = await call(method, 'nope');

      expect(cross.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await cross.json()).toEqual(await missing.json());
      expect(updateMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(auditCreate).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });
  }

  it('the gate still runs first: no manager reach, no hold lookup', async () => {
    checkManagerForSite.mockResolvedValueOnce({ ok: false, status: 403 } as never);
    const res = await call('DELETE');
    expect(res.status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
