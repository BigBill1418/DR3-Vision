// ADR-0140 Amendment 1, review F1 — the read-only hold status GET.
//
// A device whose Approve/Discard timed out asks this route whether it landed.
// It must answer only `{ status }`, only for a hold at the operator's own site
// (another site's hold is the same 404 as a missing one — no id probing), and
// write nothing.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requireOperatorForSite, assertUiSurfaceActivated, findUnique } = vi.hoisted(() => ({
  requireOperatorForSite: vi.fn(async () => ({
    userId: 'u-operator',
    siteId: 'site-woodland',
    siteCode: 'woodland',
    role: 'operator',
  })),
  assertUiSurfaceActivated: vi.fn(async () => undefined),
  findUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: { inventoryCountHold: { findUnique } } }));
vi.mock('@/lib/auth-helpers', () => ({ requireOperatorForSite }));
vi.mock('@/lib/loads/record-guards', () => ({
  assertUiSurfaceActivated,
  assertLoadsInventoryActivated: async () => undefined,
  LoadsInventoryNotActivatedError: class extends Error {
    status = 423;
  },
}));

import { GET } from './route';

function get(holdId = 'hold-1'): Promise<Response> {
  return GET(new Request(`http://127.0.0.1:3000/api/operator/woodland/count/holds/${holdId}`), {
    params: Promise.resolve({ site: 'woodland', holdId }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/operator/[site]/count/holds/[holdId]', () => {
  it('returns only the status of a hold at the operator’s site', async () => {
    findUnique.mockResolvedValue({ status: 'approved', site_id: 'site-woodland' });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'approved' });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'hold-1' },
      select: { status: true, site_id: true },
    });
  });

  it('another site’s hold is a 404, indistinguishable from a missing one', async () => {
    findUnique.mockResolvedValue({ status: 'pending', site_id: 'site-eugene' });
    const cross = await get();
    findUnique.mockResolvedValue(null);
    const missing = await get('nope');
    expect(cross.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await cross.json()).toEqual(await missing.json());
  });

  it('needs an operator session for the site, like the write routes', async () => {
    requireOperatorForSite.mockRejectedValueOnce(new Response('unauthenticated', { status: 401 }));
    const res = await get();
    expect(res.status).toBe(401);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
