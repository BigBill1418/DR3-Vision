// ADR-0017 — admin Settings panel: API integration tests.
//
// These tests stand up the route handlers in-process and drive them
// with mocked Prisma + auth. They verify:
//   - role gate (admin-only; manager + operator + anon all fail)
//   - happy paths for create + reset_pin + deactivate
//   - validation rejections for missing email + duplicate email
//   - PII is never returned in the response body
//   - audit rows are written for every mutation

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Test doubles ────────────────────────────────────────────────
//
// `auth()` (from `@/lib/auth`) is the only entry point we mock for
// the role gate. The Prisma client is a thin in-memory store: just
// the methods our code paths call, returning shapes our code paths
// expect. The mock is reset between tests.

let mockSession: { user: { id: string; role: string; name?: string; email?: string } } | null =
  null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

interface MockUser {
  id: string;
  email: string | null;
  name: string;
  role: 'operator' | 'manager' | 'admin';
  locale: 'en' | 'es' | 'ur';
  primary_site_id: string | null;
  primary_site?: { code: string } | null;
  processor_role: string | null;
  pin_hash: string | null;
  pin_failed_attempts: number;
  pin_first_failed_at: Date | null;
  pin_locked_until: Date | null;
  is_active: boolean;
  all_sites: boolean;
  can_manage_rates: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface MockSite {
  id: string;
  code: string;
  name: string;
}

const usersStore = new Map<string, MockUser>();
const sitesStore = new Map<string, MockSite>();
interface AuditRow {
  action: string;
  row_id: string;
  before: unknown;
  after: unknown;
}
const auditRows: AuditRow[] = [];

function resetStores() {
  usersStore.clear();
  sitesStore.clear();
  auditRows.length = 0;
  const eu: MockSite = { id: 'site-eugene', code: 'eugene', name: 'Eugene' };
  const wo: MockSite = { id: 'site-woodland', code: 'woodland', name: 'Woodland' };
  sitesStore.set(eu.id, eu);
  sitesStore.set(wo.id, wo);
  // seed an admin actor
  insertUser({
    id: 'admin-1',
    name: 'Admin One',
    email: 'admin@example.com',
    role: 'admin',
    primary_site_id: eu.id,
  });
  // seed an existing operator at Eugene with a known pin hash for collision tests
  insertUser({
    id: 'op-existing',
    name: 'Existing Op',
    email: null,
    role: 'operator',
    primary_site_id: eu.id,
    pin_hash:
      // hash of '5683' precomputed below at test setup; here we
      // just stuff a placeholder, real hash inserted in beforeEach
      'placeholder',
  });
}

function insertUser(p: Partial<MockUser> & { id: string; name: string; role: MockUser['role'] }) {
  const now = new Date();
  const u: MockUser = {
    id: p.id,
    email: p.email ?? null,
    name: p.name,
    role: p.role,
    locale: p.locale ?? 'en',
    primary_site_id: p.primary_site_id ?? null,
    processor_role: p.processor_role ?? null,
    pin_hash: p.pin_hash ?? null,
    pin_failed_attempts: 0,
    pin_first_failed_at: null,
    pin_locked_until: null,
    is_active: p.is_active ?? true,
    all_sites: p.all_sites ?? false,
    can_manage_rates: p.can_manage_rates ?? false,
    last_login_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  usersStore.set(u.id, u);
  return u;
}

// Resolves include: { primary_site }
function withSite(u: MockUser): MockUser {
  if (!u.primary_site_id) return { ...u, primary_site: null };
  const s = sitesStore.get(u.primary_site_id);
  return { ...u, primary_site: s ? { code: s.code } : null };
}

function matchesWhere(u: MockUser, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'is_active' && u.is_active !== v) return false;
    if (k === 'deleted_at' && u.deleted_at !== v) return false;
    if (k === 'role' && u.role !== v) return false;
    if (k === 'primary_site_id') {
      if (typeof v === 'string' && u.primary_site_id !== v) return false;
      if (typeof v === 'object' && v !== null && 'not' in (v as Record<string, unknown>)) {
        const not = (v as { not: unknown }).not;
        if (u.primary_site_id === not) return false;
      }
    }
    if (k === 'id') {
      if (typeof v === 'object' && v !== null && 'not' in (v as Record<string, unknown>)) {
        const not = (v as { not: unknown }).not;
        if (u.id === not) return false;
      } else if (typeof v === 'string' && u.id !== v) return false;
    }
    if (k === 'pin_hash') {
      if (typeof v === 'object' && v !== null && 'not' in (v as Record<string, unknown>)) {
        const not = (v as { not: unknown }).not;
        if (not === null && u.pin_hash === null) return false;
      }
    }
    if (k === 'email') {
      if (typeof v === 'string' && u.email !== v) return false;
    }
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const userClient = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
      if (where.id) {
        const u = usersStore.get(where.id);
        return u ? withSite(u) : null;
      }
      if (where.email) {
        for (const u of usersStore.values()) {
          if (u.email === where.email) return withSite(u);
        }
        return null;
      }
      return null;
    }),
    findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const out: MockUser[] = [];
      for (const u of usersStore.values()) {
        if (!where || matchesWhere(u, where)) out.push(withSite(u));
      }
      return out;
    }),
    create: vi.fn(async ({ data }: { data: Partial<MockUser> }) => {
      const id = data.id ?? `user-${usersStore.size + 1}`;
      const u = insertUser({
        id,
        name: data.name ?? 'unnamed',
        role: (data.role ?? 'operator') as MockUser['role'],
        email: data.email ?? null,
        primary_site_id: data.primary_site_id ?? null,
        processor_role: data.processor_role ?? null,
        pin_hash: data.pin_hash ?? null,
        is_active: data.is_active ?? true,
        all_sites: data.all_sites ?? false,
        can_manage_rates: data.can_manage_rates ?? false,
      });
      return withSite(u);
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = usersStore.get(where.id);
        if (!u) throw new Error('not found');
        // primitive fields
        for (const k of [
          'name',
          'email',
          'role',
          'processor_role',
          'pin_hash',
          'is_active',
          'all_sites',
          'can_manage_rates',
          'deleted_at',
          'last_login_at',
          'pin_failed_attempts',
          'pin_first_failed_at',
          'pin_locked_until',
        ] as const) {
          if (k in data) (u as unknown as Record<string, unknown>)[k] = data[k];
        }
        if ('primary_site' in data) {
          const ps = data['primary_site'] as { connect?: { id?: string } } | undefined;
          if (ps?.connect?.id) u.primary_site_id = ps.connect.id;
        }
        if ('primary_site_id' in data) {
          u.primary_site_id = data['primary_site_id'] as string;
        }
        u.updated_at = new Date();
        return withSite(u);
      },
    ),
  };

  const siteClient = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string; code?: string } }) => {
      if (where.id) return sitesStore.get(where.id) ?? null;
      if (where.code) {
        for (const s of sitesStore.values()) if (s.code === where.code) return s;
        return null;
      }
      return null;
    }),
    findMany: vi.fn(async () => Array.from(sitesStore.values())),
  };

  const auditLogClient = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        action: data['action'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
        after: data['after'],
      });
      return { id: `audit-${auditRows.length}` };
    }),
  };

  return {
    prisma: {
      user: userClient,
      site: siteClient,
      auditLog: auditLogClient,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        return fn({
          user: userClient,
          site: siteClient,
          auditLog: auditLogClient,
        });
      }),
    },
  };
});

// Use the real argon2 hashing — `setPin()` calls into it. Tests
// intentionally exercise the whole path (Argon2id is fast enough).

beforeEach(async () => {
  resetStores();
  // Replace the placeholder PIN hash with a real argon2id hash of
  // '5683' so collision tests are realistic.
  const { hashPassword } = await import('@/lib/argon');
  const realHash = await hashPassword('5683');
  const op = usersStore.get('op-existing');
  if (op) op.pin_hash = realHash;
  mockSession = null;
});

// ── Helpers ─────────────────────────────────────────────────────

function makeReq(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

// DTO shape returned by the API. Mirrors AdminUserDto but kept here
// so the test file doesn't import the real type (and accidentally
// mark the response-shape contract as "internal-only").
interface UserResponseShape {
  id: string;
  email: string | null;
  name: string;
  role: 'operator' | 'manager' | 'admin';
  primary_site_id: string | null;
  primary_site_code: string | null;
  is_active: boolean;
  all_sites: boolean;
  can_manage_rates: boolean;
  has_pin: boolean;
  deleted_at: string | null;
}

// ── Tests ───────────────────────────────────────────────────────

describe('POST /api/admin/users — role gate', () => {
  it('returns 401 when unauthenticated', async () => {
    const { POST } = await import('./route');
    mockSession = null;
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when manager role', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'm', role: 'manager' } };
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'X',
          role: 'manager',
          email: 'x@example.com',
          primary_site_id: 'site-eugene',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when operator role', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'o', role: 'operator' } };
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/users — create operator', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('creates an operator with a valid PIN', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Operator Two',
          role: 'operator',
          email: '',
          primary_site_id: 'site-eugene',
          pin: '8429',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user).toBeDefined();
    expect(body.user.name).toBe('Operator Two');
    expect(body.user.role).toBe('operator');
    expect(body.user.has_pin).toBe(true);
    expect(body.user.is_active).toBe(true);

    // PII MUST NOT appear in the response body
    const json = JSON.stringify(body);
    expect(json).not.toContain('pin_hash');
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('argon2id');

    // audit row written: at least one insert + one PIN-set update
    const insertRow = auditRows.find((r) => r.action === 'insert');
    expect(insertRow).toBeDefined();
    // Prisma's JsonNull sentinel is a non-null object that serializes
    // to `null`; both forms are acceptable provided there are no real
    // before-fields to leak.
    const beforeJson = JSON.stringify(insertRow?.before);
    expect(beforeJson === 'null' || beforeJson === '{}').toBe(true);
    const afterJson = JSON.stringify(insertRow?.after);
    expect(afterJson).not.toContain('pin_hash');
    expect(afterJson).not.toContain('password_hash');
  });

  it('creates an operator when optional fields are explicit null (the exact payload UserCreateForm sends)', async () => {
    // Regression: the create form sends `email: null` and `processor_role: null`
    // for a non-Eugene operator (and `pin: null` for managers). `.optional()`
    // rejected explicit null → "Invalid request payload"; `.nullish()` accepts it.
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Operator Null-Fields',
          role: 'operator',
          email: null,
          primary_site_id: 'site-eugene',
          processor_role: null,
          all_sites: false,
          can_manage_rates: false,
          can_view_billing_verify: false,
          pin: '4417',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.role).toBe('operator');
    expect(body.user.has_pin).toBe(true);
    expect(body.user.email).toBeNull();
  });

  it('creates a manager when pin + processor_role are explicit null (as the form sends)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Manager Null-Fields',
          role: 'manager',
          email: 'mgr.nullfields@svdp.us',
          primary_site_id: 'site-eugene',
          processor_role: null,
          all_sites: false,
          can_manage_rates: false,
          can_view_billing_verify: false,
          pin: null,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.role).toBe('manager');
    expect(body.user.has_pin).toBe(false);
  });

  it('rejects an operator created with no PIN', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Operator Two',
          role: 'operator',
          primary_site_id: 'site-eugene',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(422);
  });

  it('rejects a PIN that collides within the same site', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Operator Two',
          role: 'operator',
          primary_site_id: 'site-eugene',
          pin: '5683', // matches op-existing
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('rejects a sequential PIN pattern', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Operator Two',
          role: 'operator',
          primary_site_id: 'site-eugene',
          pin: '1234',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(422);
  });
});

describe('POST /api/admin/users — create manager', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('creates a manager with email', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Manager X',
          role: 'manager',
          email: 'manager@example.com',
          primary_site_id: 'site-woodland',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.email).toBe('manager@example.com');
    expect(body.user.has_pin).toBe(false);
  });

  it('rejects a manager without email', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Manager X',
          role: 'manager',
          email: '',
          primary_site_id: 'site-woodland',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(422);
  });

  it('returns 409 on duplicate email', async () => {
    const { POST } = await import('./route');
    // first create succeeds
    const ok = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Manager X',
          role: 'manager',
          email: 'dup@example.com',
          primary_site_id: 'site-woodland',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(ok.status).toBe(201);
    // duplicate email
    const dup = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Manager Y',
          role: 'manager',
          email: 'dup@example.com',
          primary_site_id: 'site-eugene',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(dup.status).toBe(409);
  });
});

describe('all_sites flag (ADR-0024) — create + update', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('creates a manager with all_sites=true', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Kelsey',
          role: 'manager',
          email: 'kelsey@example.com',
          primary_site_id: 'site-eugene',
          all_sites: true,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.all_sites).toBe(true);
  });

  it('coerces all_sites to false when creating an operator (operators are single-site)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Op Two',
          role: 'operator',
          primary_site_id: 'site-eugene',
          pin: '8261',
          all_sites: true,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.all_sites).toBe(false);
  });

  it('toggles all_sites on an existing manager via update', async () => {
    insertUser({
      id: 'mgr-all',
      name: 'Mgr All',
      email: 'mgrall@example.com',
      role: 'manager',
      primary_site_id: 'site-eugene',
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/mgr-all', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'update', all_sites: true }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'mgr-all' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.all_sites).toBe(true);
  });

  it('clears all_sites when an all-sites manager is changed to admin', async () => {
    insertUser({
      id: 'mgr-promote',
      name: 'Mgr Promote',
      email: 'promote@example.com',
      role: 'manager',
      primary_site_id: 'site-eugene',
      all_sites: true,
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/mgr-promote', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'update', role: 'admin' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'mgr-promote' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.role).toBe('admin');
    expect(body.user.all_sites).toBe(false);
  });
});

describe('can_manage_rates flag (ADR-0040 D5) — create + update', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('creates a manager with can_manage_rates=true (Rick)', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Rick',
          role: 'manager',
          email: 'rick@example.com',
          primary_site_id: 'site-woodland',
          can_manage_rates: true,
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.can_manage_rates).toBe(true);
  });

  it('coerces can_manage_rates to false when creating an operator', async () => {
    const { POST } = await import('./route');
    const res = await POST(
      makeReq('http://x/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Op',
          role: 'operator',
          primary_site_id: 'site-woodland',
          can_manage_rates: true,
          pin: '1379',
        }),
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.can_manage_rates).toBe(false);
  });

  it('toggles can_manage_rates on an existing manager via update', async () => {
    insertUser({
      id: 'mgr-rates',
      name: 'Mgr Rates',
      email: 'mgrrates@example.com',
      role: 'manager',
      primary_site_id: 'site-woodland',
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/mgr-rates', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'update', can_manage_rates: true }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'mgr-rates' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.can_manage_rates).toBe(true);
  });

  it('clears can_manage_rates when a rate-manager is changed to admin', async () => {
    insertUser({
      id: 'mgr-to-admin',
      name: 'Mgr ToAdmin',
      email: 'mta@example.com',
      role: 'manager',
      primary_site_id: 'site-woodland',
      can_manage_rates: true,
    });
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/mgr-to-admin', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'update', role: 'admin' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'mgr-to-admin' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.can_manage_rates).toBe(false);
  });
});

describe('PATCH /api/admin/users/[id] — reset PIN + deactivate + reactivate', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('resets an operator PIN, audit row written, new PIN verifies', async () => {
    const { PATCH } = await import('./[id]/route');
    const { verifyPin } = await import('@/lib/pin-service');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/op-existing', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reset_pin', pin: '8429' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'op-existing' }) },
    );
    expect(res.status).toBe(200);

    // setPin() inside admin-users writes its own audit row. Note:
    // pin-service.ts intentionally emits the literal sentinel string
    // '<argon2id>' (NOT an actual hash) into the audit row to record
    // "PIN was set" without leaking the hash. We assert the *real*
    // hash-format prefix never appears.
    const updateRow = auditRows.find((r) => r.action === 'update' && r.row_id === 'op-existing');
    expect(updateRow).toBeDefined();
    const afterJson = JSON.stringify(updateRow?.after);
    expect(afterJson).not.toContain('$argon2id$');
    expect(afterJson).not.toContain('$v=19');

    // The new PIN now verifies for the operator
    const result = await verifyPin('op-existing', '8429');
    expect(result.ok).toBe(true);
  });

  it('refuses to reset the PIN of a manager', async () => {
    const { PATCH } = await import('./[id]/route');
    insertUser({
      id: 'mgr-1',
      name: 'Mgr',
      role: 'manager',
      email: 'mgr@example.com',
      primary_site_id: 'site-eugene',
    });
    const res = await PATCH(
      makeReq('http://x/api/admin/users/mgr-1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reset_pin', pin: '8429' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'mgr-1' }) },
    );
    expect(res.status).toBe(422);
  });

  it('deactivates a user, soft-delete fields set, audit soft_delete row written', async () => {
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/op-existing', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'deactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'op-existing' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.is_active).toBe(false);
    expect(body.user.deleted_at).toBeTruthy();

    const row = auditRows.find((r) => r.action === 'soft_delete' && r.row_id === 'op-existing');
    expect(row).toBeDefined();
  });

  it('refuses to self-deactivate', async () => {
    const { PATCH } = await import('./[id]/route');
    const res = await PATCH(
      makeReq('http://x/api/admin/users/admin-1', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'deactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'admin-1' }) },
    );
    expect(res.status).toBe(422);
  });

  it('reactivates a deactivated user, audit restore row written', async () => {
    const { PATCH } = await import('./[id]/route');
    const op = usersStore.get('op-existing')!;
    op.is_active = false;
    op.deleted_at = new Date();

    const res = await PATCH(
      makeReq('http://x/api/admin/users/op-existing', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'reactivate' }),
        headers: { 'Content-Type': 'application/json' },
      }),
      { params: Promise.resolve({ id: 'op-existing' }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: UserResponseShape };
    expect(body.user.is_active).toBe(true);
    expect(body.user.deleted_at).toBeNull();

    const row = auditRows.find((r) => r.action === 'restore' && r.row_id === 'op-existing');
    expect(row).toBeDefined();
  });
});

describe('GET /api/admin/users — list filtering', () => {
  beforeEach(() => {
    mockSession = { user: { id: 'admin-1', role: 'admin' } };
  });

  it('hides inactive users by default', async () => {
    const { GET } = await import('./route');
    // mark op-existing inactive
    const op = usersStore.get('op-existing')!;
    op.is_active = false;
    op.deleted_at = new Date();

    const res = await GET(makeReq('http://x/api/admin/users'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string }> };
    const ids = body.users.map((u) => u.id);
    expect(ids).not.toContain('op-existing');
    expect(ids).toContain('admin-1');
  });

  it('reveals inactive users with status=inactive', async () => {
    const { GET } = await import('./route');
    const op = usersStore.get('op-existing')!;
    op.is_active = false;
    op.deleted_at = new Date();

    const res = await GET(makeReq('http://x/api/admin/users?status=inactive'));
    const body = (await res.json()) as { users: Array<{ id: string }> };
    const ids = body.users.map((u) => u.id);
    expect(ids).toContain('op-existing');
    expect(ids).not.toContain('admin-1');
  });

  it('reveals all users with status=all', async () => {
    const { GET } = await import('./route');
    const op = usersStore.get('op-existing')!;
    op.is_active = false;
    op.deleted_at = new Date();

    const res = await GET(makeReq('http://x/api/admin/users?status=all'));
    const body = (await res.json()) as { users: Array<{ id: string }> };
    const ids = body.users.map((u) => u.id);
    expect(ids).toContain('op-existing');
    expect(ids).toContain('admin-1');
  });

  it('returns 403 to a manager', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: 'm', role: 'manager' } };
    const res = await GET(makeReq('http://x/api/admin/users'));
    expect(res.status).toBe(403);
  });
});
