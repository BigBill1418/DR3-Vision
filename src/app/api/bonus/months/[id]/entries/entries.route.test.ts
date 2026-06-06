// T-116 — Month-scoped daily-entry write endpoint (ADR-0019 §6). In-process
// handler test with mocked auth + Prisma. Covers:
//   - anonymous -> 401, operator -> 403, Eugene mgr -> 403
//   - admin edits an amended month -> 200, count upserted
//   - manager (Janette) may also key corrected counts while amended -> 200
//   - edit refused on a still-signed month -> 409
//   - cross-site month id -> 404

import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockSession: {
  user: { id: string; role: string; primary_site_id?: string | null };
} | null = null;

vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => mockSession) }));

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

interface MockMonth {
  id: string;
  site_id: string;
  state: string;
}
interface MockEntry {
  id: string;
  bonus_employee_id: string;
  bonus_month_id: string;
  entry_date: Date;
  mattress_count: number;
  note: string | null;
  entered_by_user_id: string;
}

const sitesStore = new Map<string, { id: string; code: string; name: string }>();
const monthStore = new Map<string, MockMonth>();
const employeeStore = new Map<string, { id: string; site_id: string; is_active: boolean }>();
const entryStore: MockEntry[] = [];
let seq = 0;

function reset() {
  sitesStore.clear();
  monthStore.clear();
  employeeStore.clear();
  entryStore.length = 0;
  seq = 0;
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' });
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'DR3 Eugene' });
  employeeStore.set('e1', { id: 'e1', site_id: WOODLAND, is_active: true });
}

vi.mock('@/lib/prisma', () => {
  const bonusMonth = {
    findFirst: vi.fn(async ({ where }: { where: { id: string; site_id?: string } }) => {
      const m = monthStore.get(where.id);
      if (!m) return null;
      if (where.site_id !== undefined && m.site_id !== where.site_id) return null;
      return { ...m };
    }),
  };
  const bonusEmployee = {
    findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; site_id: string } }) =>
      [...employeeStore.values()]
        .filter((e) => where.id.in.includes(e.id) && e.site_id === where.site_id)
        .map((e) => ({ id: e.id })),
    ),
  };
  const bonusDailyEntry = {
    findUnique: vi.fn(
      async ({
        where,
      }: {
        where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
      }) => {
        const k = where.bonus_employee_id_entry_date;
        const e = entryStore.find(
          (r) =>
            r.bonus_employee_id === k.bonus_employee_id &&
            r.entry_date.getTime() === k.entry_date.getTime(),
        );
        return e ? { ...e } : null;
      },
    ),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { bonus_employee_id_entry_date: { bonus_employee_id: string; entry_date: Date } };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const k = where.bonus_employee_id_entry_date;
        const existing = entryStore.find(
          (r) =>
            r.bonus_employee_id === k.bonus_employee_id &&
            r.entry_date.getTime() === k.entry_date.getTime(),
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row: MockEntry = {
          id: `de-${++seq}`,
          bonus_employee_id: create['bonus_employee_id'] as string,
          bonus_month_id: create['bonus_month_id'] as string,
          entry_date: create['entry_date'] as Date,
          mattress_count: create['mattress_count'] as number,
          note: (create['note'] as string | null) ?? null,
          entered_by_user_id: create['entered_by_user_id'] as string,
        };
        entryStore.push(row);
        return { ...row };
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
  const auditLog = { create: vi.fn(async () => ({ id: 'a1' })) };
  const client = { bonusMonth, bonusEmployee, bonusDailyEntry, site, auditLog };
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

function makeReq(body: unknown): Request {
  return new Request('http://x/api/bonus/months/m1/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Vitest/1.0' },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: 'm1' });
const goodBody = {
  entry_date: '2026-05-12',
  entries: [{ bonus_employee_id: 'e1', mattress_count: 80 }],
};

describe('POST /api/bonus/months/[id]/entries — gate', () => {
  it('401 unauthenticated', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'amended' });
    mockSession = null;
    expect((await POST(makeReq(goodBody), { params })).status).toBe(401);
  });

  it('403 operator', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'amended' });
    mockSession = { user: { id: 'op', role: 'operator' } };
    expect((await POST(makeReq(goodBody), { params })).status).toBe(403);
  });

  it('403 Eugene manager (Rick)', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'amended' });
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    expect((await POST(makeReq(goodBody), { params })).status).toBe(403);
  });
});

describe('POST /api/bonus/months/[id]/entries — month-scoped edit', () => {
  it('admin edits an amended month -> 200, count upserted', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'amended' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(goodBody), { params });
    expect(res.status).toBe(200);
    expect(entryStore[0]!.mattress_count).toBe(80);
    expect(entryStore[0]!.bonus_month_id).toBe('m1');
    expect(entryStore[0]!.entered_by_user_id).toBe('bill');
  });

  it('Woodland manager (Janette) may also key corrected counts while amended', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'amended' });
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(makeReq(goodBody), { params });
    expect(res.status).toBe(200);
  });

  it('409 when the month is still signed (locked)', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: WOODLAND, state: 'signed' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(goodBody), { params });
    expect(res.status).toBe(409);
  });

  it('404 cross-site month id', async () => {
    const { POST } = await import('./route');
    monthStore.set('m1', { id: 'm1', site_id: EUGENE, state: 'amended' });
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(makeReq(goodBody), { params });
    expect(res.status).toBe(404);
  });
});
