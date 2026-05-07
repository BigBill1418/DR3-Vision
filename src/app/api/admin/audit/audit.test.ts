// T-014 — API integration tests for /api/admin/audit.
//
// Mirrors the pattern in `src/app/api/admin/users/users.test.ts`:
// in-memory Prisma double + mocked auth(), driving the real route
// handler. Verifies role gate, filter composition, pagination, and
// the row-existence resolver (linkable vs gone vs unlinkable).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditAction } from '@prisma/client';

// ── Mocked session ─────────────────────────────────────────────
let mockSession: { user: { id: string; role: string; name?: string; email?: string } } | null =
  null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

// ── In-memory stores ───────────────────────────────────────────

interface MockAudit {
  id: string;
  actor_user_id: string | null;
  actor_label: string | null;
  action: AuditAction;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

interface MockUserLite {
  id: string;
  name: string;
  email: string | null;
  role: 'operator' | 'manager' | 'admin';
}

interface MockLoadLite {
  id: string;
}

const auditStore: MockAudit[] = [];
const userStore = new Map<string, MockUserLite>();
const loadStore = new Map<string, MockLoadLite>();

function resetStores() {
  auditStore.length = 0;
  userStore.clear();
  loadStore.clear();

  userStore.set('admin-1', {
    id: 'admin-1',
    name: 'Admin One',
    email: 'admin@example.com',
    role: 'admin',
  });
  userStore.set('mgr-1', {
    id: 'mgr-1',
    name: 'Mgr One',
    email: 'mgr@example.com',
    role: 'manager',
  });
  userStore.set('op-1', {
    id: 'op-1',
    name: 'Op One',
    email: null,
    role: 'operator',
  });
  loadStore.set('load-1', { id: 'load-1' });
  // load-2 INTENTIONALLY absent — exercises the "row gone" path
}

function addAudit(p: Partial<MockAudit> & { table_name: string; row_id: string }): MockAudit {
  const r: MockAudit = {
    id: p.id ?? `aud-${auditStore.length + 1}`,
    actor_user_id: p.actor_user_id ?? null,
    actor_label: p.actor_label ?? null,
    action: p.action ?? 'update',
    table_name: p.table_name,
    row_id: p.row_id,
    before: p.before ?? null,
    after: p.after ?? null,
    ip: p.ip ?? null,
    user_agent: p.user_agent ?? null,
    created_at: p.created_at ?? new Date(),
  };
  auditStore.push(r);
  return r;
}

// Where-matcher for our minimal audit findMany. Supports the exact
// shapes the application emits from `admin-audit.ts :: buildWhere`.
function matchesAudit(a: MockAudit, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'actor_user_id' && a.actor_user_id !== v) return false;
    if (k === 'table_name' && a.table_name !== v) return false;
    if (k === 'action' && typeof v === 'object' && v !== null && 'in' in v) {
      const list = (v as { in: AuditAction[] }).in;
      if (!list.includes(a.action)) return false;
    }
    if (k === 'created_at' && typeof v === 'object' && v !== null) {
      const range = v as { gte?: Date; lt?: Date };
      if (range.gte && a.created_at.getTime() < range.gte.getTime()) return false;
      if (range.lt && a.created_at.getTime() >= range.lt.getTime()) return false;
    }
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const auditLog = {
    findMany: vi.fn(
      async ({
        where,
        take,
        skip,
      }: {
        where?: Record<string, unknown>;
        include?: unknown;
        orderBy?: unknown;
        take?: number;
        skip?: number;
      }) => {
        const all = auditStore.filter((a) => matchesAudit(a, where));
        // newest-first ordering matches `orderBy: { created_at: 'desc' }`
        all.sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
        const sliced = all.slice(skip ?? 0, (skip ?? 0) + (take ?? all.length));
        // Resolve `include: { actor: { select: ... } }` — return the
        // matching user as `actor` or null.
        return sliced.map((a) => ({
          ...a,
          actor: a.actor_user_id ? (userStore.get(a.actor_user_id) ?? null) : null,
        }));
      }
    ),
    count: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      return auditStore.filter((a) => matchesAudit(a, where)).length;
    }),
    create: vi.fn(),
  };

  const user = {
    findMany: vi.fn(
      async ({
        where,
      }: {
        where?: { id?: { in: string[] }; role?: { in: string[] } };
        select?: unknown;
        orderBy?: unknown;
      } = {}) => {
        if (where?.id?.in) {
          const ids = new Set(where.id.in);
          return Array.from(userStore.values()).filter((u) => ids.has(u.id));
        }
        if (where?.role?.in) {
          const roles = new Set(where.role.in);
          return Array.from(userStore.values()).filter((u) => roles.has(u.role));
        }
        return Array.from(userStore.values());
      }
    ),
  };

  const inboundLoad = {
    findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } } = {}) => {
      if (!where?.id?.in) return Array.from(loadStore.values());
      const ids = new Set(where.id.in);
      return Array.from(loadStore.values()).filter((l) => ids.has(l.id));
    }),
  };

  return {
    prisma: {
      auditLog,
      user,
      inboundLoad,
    },
  };
});

beforeEach(() => {
  resetStores();
  mockSession = null;
});

// ── Helpers ────────────────────────────────────────────────────

function makeReq(url: string): Request {
  return new Request(url, { method: 'GET' });
}

interface AuditApiRow {
  id: string;
  created_at: string;
  action: AuditAction;
  table_name: string;
  row_id: string;
  actor_user: { id: string; name: string; role: string; email: string | null } | null;
  actor_label: string | null;
  ip: string | null;
  user_agent: string | null;
  before: unknown;
  after: unknown;
  row_exists: boolean | null;
}

interface AuditApiResponse {
  rows: AuditApiRow[];
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

// ── Tests ──────────────────────────────────────────────────────

describe('GET /api/admin/audit — role gate', () => {
  it('returns 401 when unauthenticated', async () => {
    const { GET } = await import('./route');
    mockSession = null;
    const res = await GET(makeReq('http://x/api/admin/audit'));
    expect(res.status).toBe(401);
  });

  it('returns 403 when manager role', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: 'mgr-1', role: 'manager' } };
    const res = await GET(makeReq('http://x/api/admin/audit'));
    expect(res.status).toBe(403);
  });

  it('returns 403 when operator role', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: 'op-1', role: 'operator' } };
    const res = await GET(makeReq('http://x/api/admin/audit'));
    expect(res.status).toBe(403);
  });

  it('returns 200 when admin role', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
    const res = await GET(makeReq('http://x/api/admin/audit'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.total_pages).toBe(1);
  });
});

describe('GET /api/admin/audit — list shape', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('serializes a row with full actor metadata', async () => {
    addAudit({
      table_name: 'users',
      row_id: 'admin-1',
      action: 'update',
      actor_user_id: 'admin-1',
      before: { name: 'Old' },
      after: { name: 'New' },
      ip: '10.0.0.1',
      user_agent: 'curl/8.5',
    });
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditApiResponse;
    expect(body.total).toBe(1);
    const r = body.rows[0]!;
    expect(r.action).toBe('update');
    expect(r.actor_user?.id).toBe('admin-1');
    expect(r.actor_user?.role).toBe('admin');
    expect(r.actor_user?.email).toBe('admin@example.com');
    expect(r.actor_label).toBeNull();
    expect(r.ip).toBe('10.0.0.1');
    expect(r.row_exists).toBe(true);
  });

  it('serializes a system-actor row with null actor_user', async () => {
    addAudit({
      table_name: 'inbound_loads',
      row_id: 'load-1',
      action: 'insert',
      actor_user_id: null,
      actor_label: 'system:mymrc-scrape',
    });
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    const body = (await res.json()) as AuditApiResponse;
    const r = body.rows[0]!;
    expect(r.actor_user).toBeNull();
    expect(r.actor_label).toBe('system:mymrc-scrape');
  });

  it('orders newest first', async () => {
    addAudit({
      id: 'a-old',
      table_name: 'users',
      row_id: 'admin-1',
      created_at: new Date('2026-05-01T00:00:00Z'),
    });
    addAudit({
      id: 'a-mid',
      table_name: 'users',
      row_id: 'admin-1',
      created_at: new Date('2026-05-03T00:00:00Z'),
    });
    addAudit({
      id: 'a-new',
      table_name: 'users',
      row_id: 'admin-1',
      created_at: new Date('2026-05-06T00:00:00Z'),
    });
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows.map((r) => r.id)).toEqual(['a-new', 'a-mid', 'a-old']);
  });

  it('marks row_exists=false when the referenced row is gone', async () => {
    addAudit({
      table_name: 'inbound_loads',
      row_id: 'load-2',
      action: 'soft_delete',
      actor_user_id: 'admin-1',
    });
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows[0]?.row_exists).toBe(false);
  });

  it('marks row_exists=null when the table is unlinkable', async () => {
    addAudit({
      table_name: 'opaque_table',
      row_id: 'whatever',
      action: 'insert',
      actor_user_id: 'admin-1',
    });
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows[0]?.row_exists).toBeNull();
  });
});

describe('GET /api/admin/audit — filter composition', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
    addAudit({
      id: 'a-admin-users-may-1',
      table_name: 'users',
      row_id: 'op-1',
      action: 'insert',
      actor_user_id: 'admin-1',
      created_at: new Date('2026-05-01T12:00:00Z'),
    });
    addAudit({
      id: 'a-admin-users-may-3',
      table_name: 'users',
      row_id: 'op-1',
      action: 'update',
      actor_user_id: 'admin-1',
      created_at: new Date('2026-05-03T12:00:00Z'),
    });
    addAudit({
      id: 'a-mgr-load-may-3',
      table_name: 'inbound_loads',
      row_id: 'load-1',
      action: 'soft_delete',
      actor_user_id: 'mgr-1',
      created_at: new Date('2026-05-03T12:00:00Z'),
    });
    addAudit({
      id: 'a-system-load-may-6',
      table_name: 'inbound_loads',
      row_id: 'load-1',
      action: 'restore',
      actor_user_id: null,
      actor_label: 'system:r2-purge',
      created_at: new Date('2026-05-06T12:00:00Z'),
    });
  });

  it('filters by actor', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?actor=admin-1'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.total).toBe(2);
    expect(body.rows.every((r) => r.actor_user?.id === 'admin-1')).toBe(true);
  });

  it('filters by table', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?table=inbound_loads'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.total).toBe(2);
    expect(body.rows.every((r) => r.table_name === 'inbound_loads')).toBe(true);
  });

  it('filters by date range (inclusive of from, inclusive of to day)', async () => {
    const { GET } = await import('./route');
    const res = await GET(
      makeReq('http://x/api/admin/audit?from=2026-05-03&to=2026-05-03')
    );
    const body = (await res.json()) as AuditApiResponse;
    // Two rows on 2026-05-03; the may-1 and may-6 rows are excluded.
    expect(body.rows.map((r) => r.id).sort()).toEqual([
      'a-admin-users-may-3',
      'a-mgr-load-may-3',
    ]);
  });

  it('filters by action multi-select', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?action=insert,restore'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows.map((r) => r.id).sort()).toEqual([
      'a-admin-users-may-1',
      'a-system-load-may-6',
    ]);
  });

  it('composes actor + table + action together', async () => {
    const { GET } = await import('./route');
    const res = await GET(
      makeReq('http://x/api/admin/audit?actor=admin-1&table=users&action=insert')
    );
    const body = (await res.json()) as AuditApiResponse;
    expect(body.rows.map((r) => r.id)).toEqual(['a-admin-users-may-1']);
  });

  it('rejects malformed date filter with 400', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?from=not-a-date'));
    expect(res.status).toBe(400);
  });

  it('drops unknown action tokens silently', async () => {
    const { GET } = await import('./route');
    // 'bogus' alone yields zero valid actions = no action filter
    const res = await GET(makeReq('http://x/api/admin/audit?action=bogus'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.total).toBe(4);
  });
});

describe('GET /api/admin/audit — pagination', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
    // 7 rows -> page_size 3 -> 3 pages (3 + 3 + 1)
    for (let i = 0; i < 7; i++) {
      addAudit({
        id: `aud-${i}`,
        table_name: 'users',
        row_id: 'admin-1',
        action: 'update',
        actor_user_id: 'admin-1',
        created_at: new Date(2026, 4, i + 1, 12, 0, 0),
      });
    }
  });

  it('reports total + total_pages correctly', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?per_page=3'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.total).toBe(7);
    expect(body.per_page).toBe(3);
    expect(body.total_pages).toBe(3);
    expect(body.rows.length).toBe(3);
  });

  it('skip/take is correct on page 2', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?per_page=3&page=2'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.page).toBe(2);
    expect(body.rows.length).toBe(3);
  });

  it('last page returns the remainder', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?per_page=3&page=3'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.page).toBe(3);
    expect(body.rows.length).toBe(1);
  });

  it('clamps per_page above 200 to 200', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit?per_page=999'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.per_page).toBe(200);
  });

  it('defaults to per_page=50 when not specified', async () => {
    const { GET } = await import('./route');
    const res = await GET(makeReq('http://x/api/admin/audit'));
    const body = (await res.json()) as AuditApiResponse;
    expect(body.per_page).toBe(50);
  });
});

describe('GET /api/admin/audit — append-only contract', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('does not export POST/PATCH/PUT/DELETE handlers', async () => {
    const mod = (await import('./route')) as Record<string, unknown>;
    expect(mod['POST']).toBeUndefined();
    expect(mod['PATCH']).toBeUndefined();
    expect(mod['PUT']).toBeUndefined();
    expect(mod['DELETE']).toBeUndefined();
  });
});
