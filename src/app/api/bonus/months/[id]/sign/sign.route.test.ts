// ADR-0019 §5 — Monthly signature capture: role-gate + dual-signature flow (T-110).
//
// Stands up the POST handler in-process with mocked auth + Prisma + the PDF and
// M365 side-effect modules. Verifies:
//   - anonymous                                    → 401
//   - operator                                     → 403
//   - Eugene manager (Rick, primary=Eugene)        → 403
//   - Janette (Woodland mgr) signs first           → 200, partially_signed, ip/ua/at captured
//   - Morena (both-sites mgr) signs second         → 200, signed, total locked, side effects fire
//   - a signer re-signing their own slot           → 409
//   - cross-site forged month id                   → 404

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: {
  user: {
    id: string;
    role: string;
    name?: string;
    email?: string;
    primary_site_id?: string | null;
  };
} | null = null;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

// Side-effect modules — never launch a browser or hit Graph in tests.
const generateBonusPdf = vi.fn<(id: string) => Promise<{ storageKey: string }>>(async () => ({
  storageKey: 'pdfs/bonus/woodland/2026-06/x.pdf',
}));
const sendPayrollPdf = vi.fn<
  (args: unknown) => Promise<{ delivered: boolean; disabled: boolean; messageId: string }>
>(async () => ({
  delivered: true,
  disabled: false,
  messageId: 'm1',
}));
vi.mock('@/lib/bonus/pdf', () => ({ generateBonusPdf: (id: string) => generateBonusPdf(id) }));
vi.mock('@/lib/m365-mail', () => ({
  sendPayrollPdf: (args: unknown) => sendPayrollPdf(args),
}));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface MockMonth {
  id: string;
  site_id: string;
  period_start: Date;
  period_end: Date;
  state: string;
  facility_signed_by_user_id: string | null;
  facility_signed_at: Date | null;
  facility_signed_ip: string | null;
  facility_signed_user_agent: string | null;
  ops_signed_by_user_id: string | null;
  ops_signed_at: Date | null;
  ops_signed_ip: string | null;
  ops_signed_user_agent: string | null;
  total_payout_cents: number | null;
  pdf_storage_key: string | null;
  amended_from_period_id: string | null;
}

const sitesStore = new Map<string, { id: string; code: string; name: string }>();
const monthStore = new Map<string, MockMonth>();
const entryStore: Array<{ bonus_pay_period_id: string; mattress_count: number }> = [];
const auditRows: Array<{
  action: string;
  table_name: string;
  row_id: string;
  actor_user_id: string | null;
}> = [];

function reset() {
  sitesStore.clear();
  monthStore.clear();
  entryStore.length = 0;
  auditRows.length = 0;
  generateBonusPdf.mockClear();
  sendPayrollPdf.mockClear();
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'Woodland' });
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'Eugene' });
}

function seedMonth(over: Partial<MockMonth> = {}): MockMonth {
  const m: MockMonth = {
    id: 'm1',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(2026, 5, 1)),
    period_end: new Date(Date.UTC(2026, 5, 30)),
    state: 'pending_signatures',
    facility_signed_by_user_id: null,
    facility_signed_at: null,
    facility_signed_ip: null,
    facility_signed_user_agent: null,
    ops_signed_by_user_id: null,
    ops_signed_at: null,
    ops_signed_ip: null,
    ops_signed_user_agent: null,
    total_payout_cents: null,
    pdf_storage_key: null,
    amended_from_period_id: null,
    ...over,
  };
  monthStore.set(m.id, m);
  return m;
}

vi.mock('@/lib/prisma', () => {
  const bonusPayPeriod = {
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
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockMonth> }) => {
      const m = monthStore.get(where.id);
      if (!m) throw new Error('not found');
      Object.assign(m, data);
      return { ...m };
    }),
  };
  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where }: { where: { bonus_pay_period_id: string } }) =>
      entryStore
        .filter((e) => e.bonus_pay_period_id === where.bonus_pay_period_id)
        .map((e) => ({ ...e })),
    ),
  };
  const processorBonusRule = {
    findFirst: vi.fn(async () => ({
      id: 'rule-wo',
      site_id: WOODLAND,
      threshold_low: 50,
      rate_low: { toString: () => '0.5000' },
      threshold_high: 74,
      rate_high: { toString: () => '0.2500' },
      effective_date: new Date(Date.UTC(2026, 0, 1)),
      end_date: null,
    })),
  };
  const site = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.id) return sitesStore.get(where.id) ?? null;
      if (where.code) for (const s of sitesStore.values()) if (s.code === where.code) return s;
      return null;
    }),
  };
  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        actor_user_id: (data['actor_user_id'] as string | null) ?? null,
      });
      return { id: `audit-${auditRows.length}` };
    }),
  };
  // T-125 fires a fire-and-forget signature-request email after the first
  // signature; it resolves the next signer via user.findFirst. Stub it to null so
  // the non-blocking prompt no-ops cleanly (no mail in these tests).
  const user = { findFirst: vi.fn(async () => null) };
  // T-208: the signature service now sources signer/override identity from the
  // bonus_signature_chains row for the period's site. Woodland chain mirrors the
  // T-201 seed (facility=Janette, ops=Morena, facility-override [Bill,Morena],
  // ops-override [Bill], auto=Bill) — outcomes are unchanged from the old role
  // heuristic; identity is just chain-sourced now.
  const bonusSignatureChain = {
    findUnique: vi.fn(async ({ where }: { where: { site_id: string } }) =>
      where.site_id === WOODLAND
        ? {
            facility_signer_user_id: 'janette',
            facility_override_actor_ids: 'bill,morena',
            ops_signer_user_id: 'morena',
            ops_override_actor_ids: 'bill',
            auto_override_actor_user_id: 'bill',
          }
        : null,
    ),
  };
  const client = {
    bonusPayPeriod,
    bonusDailyEntry,
    processorBonusRule,
    site,
    auditLog,
    user,
    bonusSignatureChain,
  };
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

function makeReq(): Request {
  return new Request('http://x/api/bonus/months/m1/sign', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Vitest/1.0' },
  });
}
const params = Promise.resolve({ id: 'm1' });

// ── Role gate ───────────────────────────────────────────────────

describe('POST /api/bonus/months/[id]/sign — role gate', () => {
  it('401 when unauthenticated', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = null;
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(401);
  });

  it('403 for operator', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'op', role: 'operator' } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
  });

  it('403 for Rick (Eugene mgr) requesting Woodland — site isolation', async () => {
    // ADR-0019.2: Rick has Eugene bonus access but not Woodland; requesting the
    // Woodland scope is denied at the gate (before any signature is recorded).
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const req = new Request('http://x/api/bonus/months/m1/sign?site=woodland', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', 'user-agent': 'Vitest/1.0' },
    });
    const res = await POST(req, { params });
    expect(res.status).toBe(403);
  });
});

// ── Dual signature flow ─────────────────────────────────────────

describe('POST /api/bonus/months/[id]/sign — signature flow', () => {
  it('Janette signs first → partially_signed with ip/ua/timestamp captured', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slot: string; state: string; fullySigned: boolean };
    expect(body.slot).toBe('facility');
    expect(body.state).toBe('partially_signed');
    expect(body.fullySigned).toBe(false);

    const m = monthStore.get('m1')!;
    expect(m.state).toBe('partially_signed');
    expect(m.facility_signed_by_user_id).toBe('janette');
    expect(m.facility_signed_ip).toBe('203.0.113.7');
    expect(m.facility_signed_user_agent).toBe('Vitest/1.0');
    expect(m.facility_signed_at).toBeInstanceOf(Date);
    // No side effects on the first signature.
    expect(generateBonusPdf).not.toHaveBeenCalled();
    expect(sendPayrollPdf).not.toHaveBeenCalled();
    // Audit captured the signer.
    expect(
      auditRows.some((r) => r.table_name === 'bonus_pay_periods' && r.actor_user_id === 'janette'),
    ).toBe(true);
  });

  it('Morena signs second → signed, total locked, PDF + mail fired', async () => {
    const { POST } = await import('./route');
    // Pre-seed Janette already signed → partially_signed.
    seedMonth({
      state: 'partially_signed',
      facility_signed_by_user_id: 'janette',
      facility_signed_at: new Date(),
    });
    entryStore.push(
      { bonus_pay_period_id: 'm1', mattress_count: 75 }, // 25*50 + 1*25 = 1275
      { bonus_pay_period_id: 'm1', mattress_count: 60 }, // 10*50 = 500
    );
    mockSession = { user: { id: 'morena', role: 'manager', primary_site_id: null } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slot: string; state: string; fullySigned: boolean };
    expect(body.slot).toBe('ops');
    expect(body.state).toBe('signed');
    expect(body.fullySigned).toBe(true);

    const m = monthStore.get('m1')!;
    expect(m.state).toBe('signed');
    expect(m.ops_signed_by_user_id).toBe('morena');
    expect(m.total_payout_cents).toBe(1775);

    // Side effects fire off the request path; flush microtasks/timers.
    await vi.waitFor(() => expect(generateBonusPdf).toHaveBeenCalledWith('m1'));
  });

  it('re-sign of an already-signed slot is rejected with 409', async () => {
    const { POST } = await import('./route');
    seedMonth({
      state: 'partially_signed',
      facility_signed_by_user_id: 'janette',
      facility_signed_at: new Date(),
    });
    // Janette tries again — her slot is filled.
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(409);
    expect(generateBonusPdf).not.toHaveBeenCalled();
  });

  it('admin with no override target → 403 (no natural slot; override is T-111)', async () => {
    const { POST } = await import('./route');
    seedMonth();
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(403);
  });
});

// ── Cross-site scoping ──────────────────────────────────────────

describe('POST /api/bonus/months/[id]/sign — scoping', () => {
  it('404 when the month belongs to another site', async () => {
    const { POST } = await import('./route');
    seedMonth({ site_id: EUGENE });
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(404);
  });
});
