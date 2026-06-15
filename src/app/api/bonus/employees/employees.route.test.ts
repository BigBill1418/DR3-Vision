// ADR-0019 §9 — Bonus employee API: role-gate + happy-path integration tests.
//
// Stands up the route handlers in-process with mocked auth + Prisma. The gate
// under test is `requireBonusAccess()` (Woodland-scoped, ADR-0019):
//   - anonymous                              → 401
//   - operator                               → 403
//   - Eugene manager (Rick, primary=Eugene)  → 403  (acceptance requirement)
//   - Woodland manager (Janette)             → allow
//   - admin                                  → allow
// Plus: create writes an audit row; rehire path returns the 409 signal.

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
interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  employee_number: string | null;
  previous_names: unknown;
  is_active: boolean;
  notes: string | null;
  user_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const sitesStore = new Map<string, MockSite>();
const empStore = new Map<string, MockEmployee>();
const auditRows: Array<{
  action: string;
  table_name: string;
  row_id: string;
  actor_user_id: string | null;
}> = [];
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function reset() {
  sitesStore.clear();
  empStore.clear();
  auditRows.length = 0;
  idCounter = 0;
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'Woodland' });
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'Eugene' });
}

function insertEmp(
  p: Partial<MockEmployee> & { full_name: string; site_id: string },
): MockEmployee {
  const now = new Date();
  const e: MockEmployee = {
    id: p.id ?? `emp-${++idCounter}`,
    site_id: p.site_id,
    full_name: p.full_name,
    employee_number: p.employee_number ?? null,
    previous_names: p.previous_names ?? [],
    is_active: p.is_active ?? true,
    notes: p.notes ?? null,
    user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: p.deleted_at ?? null,
  };
  empStore.set(e.id, e);
  return e;
}

function matchesWhere(e: MockEmployee, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'id' && e.id !== v) return false;
    if (k === 'site_id' && e.site_id !== v) return false;
    if (k === 'is_active' && e.is_active !== v) return false;
    if (k === 'employee_number' && e.employee_number !== v) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const bonusEmployeeClient = {
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const out: MockEmployee[] = [];
      for (const e of empStore.values()) if (!where || matchesWhere(e, where)) out.push({ ...e });
      return out;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const e of empStore.values()) if (matchesWhere(e, where)) return { ...e };
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Partial<MockEmployee> }) => {
      const e = insertEmp({
        site_id: data.site_id as string,
        full_name: data.full_name as string,
        employee_number: (data.employee_number as string | null) ?? null,
        notes: (data.notes as string | null) ?? null,
        previous_names: data.previous_names ?? [],
      });
      return { ...e };
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = empStore.get(where.id);
        if (!e) throw new Error('not found');
        for (const k of [
          'full_name',
          'employee_number',
          'previous_names',
          'is_active',
          'deleted_at',
          'notes',
        ] as const) {
          if (k in data) (e as unknown as Record<string, unknown>)[k] = data[k];
        }
        e.updated_at = new Date();
        return { ...e };
      },
    ),
  };
  const siteClient = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.id) return sitesStore.get(where.id) ?? null;
      if (where.code) {
        for (const s of sitesStore.values()) if (s.code === where.code) return s;
      }
      return null;
    }),
  };
  const auditLogClient = {
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
  return {
    prisma: {
      bonusEmployee: bonusEmployeeClient,
      site: siteClient,
      auditLog: auditLogClient,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ bonusEmployee: bonusEmployeeClient, auditLog: auditLogClient }),
      ),
    },
  };
});

function makeReq(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}
function jsonBody(b: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(b),
    headers: { 'Content-Type': 'application/json' },
  };
}

beforeEach(() => {
  reset();
  mockSession = null;
});

describe('POST /api/bonus/employees — role gate', () => {
  it('401 when unauthenticated', async () => {
    const { POST } = await import('./route');
    mockSession = null;
    const res = await POST(makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'A' })));
    expect(res.status).toBe(401);
  });

  it('403 for an operator', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'op', role: 'operator', primary_site_id: WOODLAND } };
    const res = await POST(makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'A' })));
    expect(res.status).toBe(403);
  });

  it('403 for Rick (Eugene mgr) requesting Woodland — site isolation (acceptance)', async () => {
    // ADR-0019.2: Rick has bonus access (Eugene) but NOT Woodland. Requesting
    // ?site=woodland is denied; his own Eugene site is allowed (next test).
    const { POST } = await import('./route');
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await POST(
      makeReq('http://x/api/bonus/employees?site=woodland', jsonBody({ full_name: 'A' })),
    );
    expect(res.status).toBe(403);
  });

  it('allows Rick on his own Eugene site (?site=eugene) → 201', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await POST(
      makeReq('http://x/api/bonus/employees?site=eugene', jsonBody({ full_name: 'Eugene Hire' })),
    );
    expect(res.status).toBe(201);
  });

  it('allows Janette — the Woodland manager', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'New Hire' })),
    );
    expect(res.status).toBe(201);
  });

  it('allows an admin', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: EUGENE } };
    const res = await POST(
      makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'Admin Add' })),
    );
    expect(res.status).toBe(201);
  });
});

describe('POST /api/bonus/employees — create + rehire', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
  });

  it('creates an employee scoped to Woodland and writes an audit row with the actor', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'Carla Reyes' })),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { employee: { site_id: string; full_name: string } };
    expect(body.employee.site_id).toBe(WOODLAND);
    expect(body.employee.full_name).toBe('Carla Reyes');

    const row = auditRows.find((a) => a.action === 'insert');
    expect(row).toBeDefined();
    expect(row?.table_name).toBe('bonus_employees');
    expect(row?.actor_user_id).toBe('janette');
  });

  it('creates with a valid 4-digit employee_number → 201 and echoes it', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        'http://x/api/bonus/employees',
        jsonBody({ full_name: 'Numbered Person', employee_number: '5420' }),
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { employee: { employee_number: string | null } };
    expect(body.employee.employee_number).toBe('5420');
  });

  it('rejects a non-4-digit employee_number with 422', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        'http://x/api/bonus/employees',
        jsonBody({ full_name: 'Bad Number', employee_number: '12' }),
      ),
    );
    expect(res.status).toBe(422);
  });

  it('rejects a duplicate employee_number at the same site with 409', async () => {
    insertEmp({
      id: 'holder',
      site_id: WOODLAND,
      full_name: 'Holder',
      employee_number: '6048',
      is_active: true,
    });
    const { POST } = await import('./route');
    const res = await POST(
      makeReq(
        'http://x/api/bonus/employees',
        jsonBody({ full_name: 'Claimant', employee_number: '6048' }),
      ),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Employee #/);
  });

  it('re-adding a deactivated name returns the 409 rehire_candidate signal', async () => {
    insertEmp({
      id: 'e-gone',
      site_id: WOODLAND,
      full_name: 'Rehire Me',
      is_active: false,
      deleted_at: new Date('2026-04-01T00:00:00Z'),
    });
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/bonus/employees', jsonBody({ full_name: 'rehire me' })),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { rehire_candidate?: boolean; employee?: { id: string } };
    expect(body.rehire_candidate).toBe(true);
    expect(body.employee?.id).toBe('e-gone');
  });
});

describe('PATCH /api/bonus/employees/[id]', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
  });

  it('403 for Rick renaming a Woodland employee (?site=woodland) — site isolation', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'X', is_active: true });
    const { PATCH } = await import('./[id]/route');
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1?site=woodland', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'rename', full_name: 'Y' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(403);
  });

  it('renames and records the previous name', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Old', is_active: true });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'rename', full_name: 'New' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      employee: { full_name: string; previous_names: Array<{ name: string }> };
    };
    expect(body.employee.full_name).toBe('New');
    expect(body.employee.previous_names[0]?.name).toBe('Old');
  });

  it('set_number sets a 4-digit employee_number → 200', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Setme', is_active: true });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set_number', employee_number: '5680' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee: { employee_number: string | null } };
    expect(body.employee.employee_number).toBe('5680');
    expect(auditRows.some((a) => a.action === 'update' && a.row_id === 'e1')).toBe(true);
  });

  it('set_number with null clears the number → 200', async () => {
    insertEmp({
      id: 'e1',
      site_id: WOODLAND,
      full_name: 'Clearme',
      employee_number: '5680',
      is_active: true,
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set_number', employee_number: null }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { employee: { employee_number: string | null } };
    expect(body.employee.employee_number).toBeNull();
  });

  it('set_number rejects an invalid number → 422', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Setme', is_active: true });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set_number', employee_number: 'abcd' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(422);
  });

  it('set_number rejects a duplicate at the same site → 409', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'A', is_active: true });
    insertEmp({
      id: 'e2',
      site_id: WOODLAND,
      full_name: 'B',
      employee_number: '6048',
      is_active: true,
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set_number', employee_number: '6048' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(res.status).toBe(409);
  });

  it('deactivate then reactivate', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Toggle', is_active: true });
    const { PATCH } = await import('./[id]/route');
    const off = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'deactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(off.status).toBe(200);
    expect(auditRows.some((a) => a.action === 'soft_delete')).toBe(true);

    const on = await PATCH(
      makeReq('http://x/api/bonus/employees/e1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e1' }) },
    );
    expect(on.status).toBe(200);
    expect(auditRows.some((a) => a.action === 'restore')).toBe(true);
  });

  it('404 when targeting an id at another site', async () => {
    insertEmp({ id: 'e-eu', site_id: EUGENE, full_name: 'Eugene Emp', is_active: true });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/bonus/employees/e-eu', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'deactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'e-eu' }) },
    );
    expect(res.status).toBe(404);
  });
});
