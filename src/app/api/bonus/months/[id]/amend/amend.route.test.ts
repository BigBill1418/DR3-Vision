// T-116 — Amendment routes (ADR-0019 §6, admin-only). In-process handler tests
// with mocked auth + Prisma + the signature-notification side effect. Covers the
// unlock (amend) route and the resubmit route:
//   - anonymous            -> 401
//   - operator             -> 403
//   - Janette (Woodland mgr) -> 403 (managers never amend)
//   - Morena (both-sites mgr) -> 403
//   - Rick (Eugene mgr)    -> 403
//   - Bill (admin) unlock signed, with reason -> 200 amended, sigs cleared
//   - Bill unlock with no reason -> 422
//   - Bill resubmit amended -> 200 pending_signatures + signer re-prompted
//   - cross-site forged id -> 404

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: {
  user: { id: string; role: string; primary_site_id?: string | null };
} | null = null;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

// Re-notify side effect — never sends real mail in tests.
const notifyPendingSigner = vi.fn<(id: string) => Promise<{ notified: boolean }>>(async () => ({
  notified: true,
}));
vi.mock('@/lib/bonus/signature-notifications', () => ({
  notifyPendingSigner: (id: string) => notifyPendingSigner(id),
}));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface MockMonth {
  id: string;
  site_id: string;
  state: string;
  janette_signed_by_user_id: string | null;
  janette_signed_at: Date | null;
  janette_signed_ip: string | null;
  janette_signed_user_agent: string | null;
  janette_override_actor_id: string | null;
  janette_override_reason: string | null;
  morena_signed_by_user_id: string | null;
  morena_signed_at: Date | null;
  morena_signed_ip: string | null;
  morena_signed_user_agent: string | null;
  morena_override_actor_id: string | null;
  morena_override_reason: string | null;
  amended_from_month_id: string | null;
  amendment_reason: string | null;
  amended_by_user_id: string | null;
  amended_at: Date | null;
  payroll_sent_at: Date | null;
}

const sitesStore = new Map<string, { id: string; code: string; name: string }>();
const monthStore = new Map<string, MockMonth>();
const auditRows: Array<{ table_name: string; row_id: string; before: unknown }> = [];

function reset() {
  sitesStore.clear();
  monthStore.clear();
  auditRows.length = 0;
  notifyPendingSigner.mockClear();
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' });
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'DR3 Eugene' });
}

function seedMonth(over: Partial<MockMonth> = {}): MockMonth {
  const m: MockMonth = {
    id: 'm1',
    site_id: WOODLAND,
    state: 'signed',
    janette_signed_by_user_id: 'janette',
    janette_signed_at: new Date(),
    janette_signed_ip: '203.0.113.7',
    janette_signed_user_agent: 'JB/1.0',
    janette_override_actor_id: null,
    janette_override_reason: null,
    morena_signed_by_user_id: 'morena',
    morena_signed_at: new Date(),
    morena_signed_ip: '203.0.113.8',
    morena_signed_user_agent: 'MB/1.0',
    morena_override_actor_id: null,
    morena_override_reason: null,
    amended_from_month_id: null,
    amendment_reason: null,
    amended_by_user_id: null,
    amended_at: null,
    payroll_sent_at: new Date(),
    ...over,
  };
  monthStore.set(m.id, m);
  return m;
}

vi.mock('@/lib/prisma', () => {
  const bonusMonth = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const m = monthStore.get(where.id);
      return m ? { ...m } : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: { id: string; site_id?: string } }) => {
      const m = monthStore.get(where.id);
      if (!m) return null;
      if (where.site_id !== undefined && m.site_id !== where.site_id) return null;
      return { ...m };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const m = monthStore.get(where.id);
        if (!m) throw new Error('not found');
        Object.assign(m, data);
        return { ...m };
      },
    ),
  };
  const site = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.code) for (const s of sitesStore.values()) if (s.code === where.code) return s;
      if (where.id) return sitesStore.get(where.id) ?? null;
      return null;
    }),
  };
  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
      });
      return { id: `audit-${auditRows.length}` };
    }),
  };
  const client = { bonusMonth, site, auditLog };
  return {
    prisma: {
      ...client,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
    },
  };
});

beforeEach(() => {
  reset();
  mockSession = null;
});

function makeReq(body?: unknown): Request {
  return new Request('http://x/api/bonus/months/m1/amend', {
    method: 'POST',
    headers: {
      'x-forwarded-for': '198.51.100.1',
      'user-agent': 'Vitest/1.0',
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const params = Promise.resolve({ id: 'm1' });

// ── Amend (unlock) ──────────────────────────────────────────────────

describe('POST /api/bonus/months/[id]/amend — role gate (admin-only)', () => {
  it('401 unauthenticated', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = null;
    expect((await POST(makeReq({ reason: 'x' }), { params })).status).toBe(401);
  });

  it('403 operator', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect((await POST(makeReq({ reason: 'x' }), { params })).status).toBe(403);
  });

  it('403 Woodland manager (Janette) — managers never amend', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    expect((await POST(makeReq({ reason: 'x' }), { params })).status).toBe(403);
    expect(monthStore.get('m1')!.state).toBe('signed');
  });

  it('403 both-sites manager (Morena)', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'morena', role: 'manager', primary_site_id: null } };
    expect((await POST(makeReq({ reason: 'x' }), { params })).status).toBe(403);
  });

  it('403 Eugene manager (Rick)', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    expect((await POST(makeReq({ reason: 'x' }), { params })).status).toBe(403);
  });
});

describe('POST /api/bonus/months/[id]/amend — admin unlock', () => {
  it('Bill unlocks a signed month with a reason -> 200 amended, signatures cleared', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq({ reason: 'Maria 5/12 was 60, should be 80' }), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('amended');

    const m = monthStore.get('m1')!;
    expect(m.state).toBe('amended');
    expect(m.janette_signed_by_user_id).toBeNull();
    expect(m.morena_signed_by_user_id).toBeNull();
    expect(m.amended_by_user_id).toBe('bill');
    expect(m.amended_from_month_id).toBe('m1'); // PDF marker
    expect(m.payroll_sent_at).toBeInstanceOf(Date); // supersedes date preserved
    // Prior signed state preserved in an audit row.
    expect(
      auditRows.some(
        (r) =>
          r.table_name === 'bonus_months' &&
          JSON.stringify(r.before).includes('janette') &&
          JSON.stringify(r.before).includes('morena'),
      ),
    ).toBe(true);
  });

  it('422 when no reason supplied', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq({ reason: '  ' }), { params });
    expect(res.status).toBe(422);
    expect(monthStore.get('m1')!.state).toBe('signed');
  });

  it('409 when the month is not signed/paid', async () => {
    const { POST } = await import('./route');
    seedMonth({ state: 'draft' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq({ reason: 'x' }), { params });
    expect(res.status).toBe(409);
  });

  it('404 cross-site month id', async () => {
    const { POST } = await import('./route');
    seedMonth({ site_id: EUGENE });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq({ reason: 'x' }), { params });
    expect(res.status).toBe(404);
  });
});

// ── Resubmit ────────────────────────────────────────────────────────

describe('POST /api/bonus/months/[id]/resubmit — admin re-submit', () => {
  it('403 for a Woodland manager', async () => {
    const { POST } = await import('../resubmit/route');
    seedMonth({ state: 'amended' });
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    expect((await POST(makeReq(), { params })).status).toBe(403);
  });

  it('Bill resubmits an amended month -> 200 pending_signatures + signer re-prompted', async () => {
    const { POST } = await import('../resubmit/route');
    seedMonth({ state: 'amended' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe('pending_signatures');
    expect(monthStore.get('m1')!.state).toBe('pending_signatures');
    await vi.waitFor(() => expect(notifyPendingSigner).toHaveBeenCalledWith('m1'));
  });

  it('409 when the month is not amended', async () => {
    const { POST } = await import('../resubmit/route');
    seedMonth({ state: 'signed' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(409);
    expect(notifyPendingSigner).not.toHaveBeenCalled();
  });
});
