// ADR-0019 §4/§7 — Bonus daily-entry API: role-gate + write integration tests (T-105).
//
// Stands up the POST handler in-process with mocked auth + Prisma. Verifies the
// `requireBonusAccess()` gate (Woodland-scoped) and the end-to-end write path:
//   - anonymous                              → 401
//   - operator                               → 403
//   - Eugene manager (Rick, primary=Eugene)  → 403
//   - Woodland manager (Janette)             → allow, persists + audits
//   - Bill (admin) can key too               → allow
//   - writes blocked (409) once the month leaves draft (ADR-0019 §7)
//   - note field does not change the persisted count's math

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

interface MockSite {
  id: string;
  code: string;
  name: string;
}
interface MockMonth {
  id: string;
  site_id: string;
  month_start: Date;
  month_end: Date;
  state: string;
}
interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  is_active: boolean;
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

const sitesStore = new Map<string, MockSite>();
const monthStore = new Map<string, MockMonth>();
const empStore = new Map<string, MockEmployee>();
const entryStore = new Map<string, MockEntry>();
const auditRows: Array<{
  action: string;
  table_name: string;
  row_id: string;
  actor_user_id: string | null;
}> = [];
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function entryKey(empId: string, date: Date): string {
  return `${empId}|${date.toISOString().slice(0, 10)}`;
}

function reset() {
  sitesStore.clear();
  monthStore.clear();
  empStore.clear();
  entryStore.clear();
  auditRows.length = 0;
  idCounter = 0;
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'Woodland' });
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'Eugene' });
  empStore.set('emp-amy', { id: 'emp-amy', site_id: WOODLAND, full_name: 'Amy', is_active: true });
}

vi.mock('@/lib/prisma', () => {
  const bonusMonth = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if ('id' in where) return monthStore.get(where['id'] as string) ?? null;
      if ('site_id_month_start' in where) {
        const k = where['site_id_month_start'] as { site_id: string; month_start: Date };
        for (const m of monthStore.values()) {
          if (m.site_id === k.site_id && m.month_start.getTime() === k.month_start.getTime())
            return { ...m };
        }
        return null;
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Omit<MockMonth, 'id'> }) => {
      const m: MockMonth = { id: `month-${++idCounter}`, ...data };
      monthStore.set(m.id, m);
      return { ...m };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<MockMonth> }) => {
      const m = monthStore.get(where.id);
      if (!m) throw new Error('not found');
      Object.assign(m, data);
      return { ...m };
    }),
  };
  const bonusEmployee = {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const out: MockEmployee[] = [];
      for (const e of empStore.values()) {
        if (where) {
          if ('site_id' in where && e.site_id !== where['site_id']) continue;
          if ('is_active' in where && e.is_active !== where['is_active']) continue;
          if ('id' in where) {
            const idW = where['id'] as { in?: string[] };
            if (idW.in && !idW.in.includes(e.id)) continue;
          }
        }
        out.push({ ...e });
      }
      return out;
    }),
  };
  const bonusDailyEntry = {
    findMany: vi.fn(async () => [...entryStore.values()].map((e) => ({ ...e }))),
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const k = where['bonus_employee_id_entry_date'] as {
        bonus_employee_id: string;
        entry_date: Date;
      };
      const found = entryStore.get(entryKey(k.bonus_employee_id, k.entry_date));
      return found ? { ...found } : null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: Record<string, unknown>;
        create: Omit<MockEntry, 'id'>;
        update: Partial<MockEntry>;
      }) => {
        const k = where['bonus_employee_id_entry_date'] as {
          bonus_employee_id: string;
          entry_date: Date;
        };
        const key = entryKey(k.bonus_employee_id, k.entry_date);
        const existing = entryStore.get(key);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row: MockEntry = { id: `entry-${++idCounter}`, ...create };
        entryStore.set(key, row);
        return { ...row };
      },
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
      if (where.code) {
        for (const s of sitesStore.values()) if (s.code === where.code) return s;
      }
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
  const client = { bonusMonth, bonusEmployee, bonusDailyEntry, processorBonusRule, site, auditLog };
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
  return new Request('http://x/api/bonus/entries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const TODAY_ISO = '2026-06-05';

// ── Role gate ───────────────────────────────────────────────────

describe('POST /api/bonus/entries — role gate', () => {
  it('401 when unauthenticated', async () => {
    const { POST } = await import('./route');
    mockSession = null;
    const res = await POST(
      makeReq({ entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 1 }] }),
    );
    expect(res.status).toBe(401);
  });

  it('403 for operator', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'op', role: 'operator' } };
    const res = await POST(
      makeReq({ entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 1 }] }),
    );
    expect(res.status).toBe(403);
  });

  it('403 for Eugene manager (Rick)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await POST(
      makeReq({ entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 1 }] }),
    );
    expect(res.status).toBe(403);
  });
});

// ── Happy path ──────────────────────────────────────────────────

describe('POST /api/bonus/entries — write path', () => {
  it('Janette (Woodland manager) persists an entry stamped with her id + audit', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 74 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ entered_by_user_id: string; mattress_count: number }>;
    };
    expect(body.entries[0]!.entered_by_user_id).toBe('janette');
    expect(body.entries[0]!.mattress_count).toBe(74);

    const audit = auditRows.find((r) => r.table_name === 'bonus_daily_entries');
    expect(audit?.actor_user_id).toBe('janette');
  });

  it('Bill (admin) can also key', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 60 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ entered_by_user_id: string }> };
    expect(body.entries[0]!.entered_by_user_id).toBe('bill');
  });

  it('note field does not change the persisted count', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 74, note: 'double shift' }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ mattress_count: number; note: string | null }>;
    };
    expect(body.entries[0]!.mattress_count).toBe(74);
    expect(body.entries[0]!.note).toBe('double shift');
  });
});

// ── Month lock (ADR-0019 §7) ────────────────────────────────────

describe('POST /api/bonus/entries — month lock', () => {
  it('returns 409 once the month is not draft', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    // Seed a non-draft month for 2026-06.
    monthStore.set('m1', {
      id: 'm1',
      site_id: WOODLAND,
      month_start: new Date(Date.UTC(2026, 5, 1)),
      month_end: new Date(Date.UTC(2026, 5, 30)),
      state: 'pending_signatures',
    });
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 5 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(entryStore.size).toBe(0);
  });
});

// ── Validation ──────────────────────────────────────────────────

describe('POST /api/bonus/entries — validation', () => {
  it('422 on an out-of-range count', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 1000 }],
      }),
    );
    expect(res.status).toBe(422);
  });

  it('422 on an empty entries array', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(makeReq({ entry_date: TODAY_ISO, entries: [] }));
    expect(res.status).toBe(422);
  });
});
