// ADR-0066 §1.4 + §1.6 — AP configuration API integration tests.
//
// The fixture models PRODUCTION's awkward shape on purpose: Bill and Morena each
// have TWO live accounts — their manager/admin account with an `@svdp.us`
// address, and an OPERATOR PIN account created 2026-07-28 for the iPad rollout
// with NO EMAIL AT ALL and the SAME NAME. A name-keyed picker would offer those,
// the routing table would read as fully populated, and every notification would
// resolve to nobody: the exact defect ADR-0066 exists to fix, reintroduced
// through its own admin screen. `not selectable as a second approver` below is
// the regression lock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ── Test doubles ────────────────────────────────────────────────

let mockSession: { user: { id: string; role: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

interface MockUser {
  id: string;
  name: string;
  email: string | null;
  role: 'operator' | 'manager' | 'admin';
  is_active: boolean;
  deleted_at: Date | null;
}

interface MockRouting {
  id: string;
  first_approver_id: string;
  second_approver_id: string;
  fallback_approver_id: string | null;
  fallback_after_hours: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
}

interface MockPref {
  id: string;
  user_id: string;
  notify_new_invoice: boolean;
  notify_second_approval_request: boolean;
  notify_daily_digest: boolean;
  notify_decision_outcome: boolean;
  updated_at: Date;
  updated_by: string | null;
}

interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

const users: MockUser[] = [];
let routing: MockRouting[] = [];
let prefs: MockPref[] = [];
let roster: { user_id: string; active_until: Date | null }[] = [];
const auditRows: AuditRow[] = [];
/** Set to make the next `apApprovalRouting.upsert` throw — the DB CHECK path. */
let upsertThrows: Error | null = null;

const U = {
  bill: 'u-bill',
  billOp: 'u-bill-op',
  morena: 'u-morena',
  morenaOp: 'u-morena-op',
  janette: 'u-janette',
  rick: 'u-rick',
  shannon: 'u-shannon',
} as const;

function resetStores() {
  users.length = 0;
  users.push(
    {
      id: U.bill,
      name: 'Bill Barnard',
      email: 'bill.barnard@svdp.us',
      role: 'admin',
      is_active: true,
      deleted_at: null,
    },
    // The email-less operator PIN account. Same NAME as the admin above.
    {
      id: U.billOp,
      name: 'Bill Barnard',
      email: null,
      role: 'operator',
      is_active: true,
      deleted_at: null,
    },
    {
      id: U.morena,
      name: 'Morena Gomez',
      email: 'morena.gomez@svdp.us',
      role: 'manager',
      is_active: true,
      deleted_at: null,
    },
    {
      id: U.morenaOp,
      name: 'Morena Gomez',
      email: null,
      role: 'operator',
      is_active: true,
      deleted_at: null,
    },
    {
      id: U.janette,
      name: 'Janette Tomas',
      email: 'janette.tomas@svdp.us',
      role: 'manager',
      is_active: true,
      deleted_at: null,
    },
    {
      id: U.rick,
      name: 'Rick Albritton',
      email: 'rick.albritton@svdp.us',
      role: 'manager',
      is_active: true,
      deleted_at: null,
    },
    {
      id: U.shannon,
      name: 'Shannon Rockwell',
      email: 'shannon.rockwell@svdp.us',
      role: 'manager',
      is_active: true,
      deleted_at: null,
    },
  );
  const now = new Date('2026-07-29T12:00:00Z');
  routing = [
    {
      id: 'r-1',
      first_approver_id: U.janette,
      second_approver_id: U.morena,
      fallback_approver_id: null,
      fallback_after_hours: 24,
      active: true,
      created_at: now,
      updated_at: now,
      updated_by: 'system:adr-0066-seed',
    },
    {
      id: 'r-2',
      first_approver_id: U.morena,
      second_approver_id: U.janette,
      fallback_approver_id: null,
      fallback_after_hours: 24,
      active: true,
      created_at: now,
      updated_at: now,
      updated_by: 'system:adr-0066-seed',
    },
  ];
  prefs = [
    {
      id: 'p-1',
      user_id: U.shannon,
      notify_new_invoice: false,
      notify_second_approval_request: true,
      notify_daily_digest: false,
      notify_decision_outcome: false,
      updated_at: now,
      updated_by: 'system:adr-0066-seed',
    },
  ];
  // Rick + Janette + Morena are on the AP roster; Shannon is not (she is a
  // second approver only). That difference is what grades a missing routing row
  // as `error` vs `warning`.
  roster = [
    { user_id: U.morena, active_until: null },
    { user_id: U.janette, active_until: null },
    { user_id: U.rick, active_until: null },
  ];
  auditRows.length = 0;
  upsertThrows = null;
  mockSession = null;
}

type AnyRecord = Record<string, unknown>;

function matchUser(u: MockUser, where: AnyRecord): boolean {
  if ('deleted_at' in where && u.deleted_at !== where['deleted_at']) return false;
  const id = where['id'];
  if (typeof id === 'string' && u.id !== id) return false;
  if (id && typeof id === 'object' && Array.isArray((id as { in?: string[] }).in)) {
    if (!(id as { in: string[] }).in.includes(u.id)) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  let seq = 0;
  const userClient = {
    findMany: vi.fn(async ({ where }: { where?: AnyRecord } = {}) =>
      users.filter((u) => !where || matchUser(u, where)).map((u) => ({ ...u })),
    ),
    findFirst: vi.fn(async ({ where }: { where: AnyRecord }) => {
      const u = users.find((x) => matchUser(x, where));
      return u ? { ...u } : null;
    }),
  };

  const routingClient = {
    findMany: vi.fn(async () => routing.map((r) => ({ ...r }))),
    findUnique: vi.fn(async ({ where }: { where: { first_approver_id: string } }) => {
      const r = routing.find((x) => x.first_approver_id === where.first_approver_id);
      return r ? { ...r } : null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { first_approver_id: string };
        create: AnyRecord;
        update: AnyRecord;
      }) => {
        if (upsertThrows) throw upsertThrows;
        const existing = routing.find((x) => x.first_approver_id === where.first_approver_id);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return { ...existing };
        }
        const row: MockRouting = {
          id: `r-new-${++seq}`,
          first_approver_id: create['first_approver_id'] as string,
          second_approver_id: create['second_approver_id'] as string,
          fallback_approver_id: (create['fallback_approver_id'] as string | null) ?? null,
          fallback_after_hours: create['fallback_after_hours'] as number,
          active: create['active'] as boolean,
          created_at: new Date(),
          updated_at: new Date(),
          updated_by: (create['updated_by'] as string | null) ?? null,
        };
        routing.push(row);
        return { ...row };
      },
    ),
  };

  const prefClient = {
    findMany: vi.fn(async () => prefs.map((p) => ({ ...p }))),
    findUnique: vi.fn(async ({ where }: { where: { user_id: string } }) => {
      const p = prefs.find((x) => x.user_id === where.user_id);
      return p ? { ...p } : null;
    }),
    upsert: vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { user_id: string };
        create: AnyRecord;
        update: AnyRecord;
      }) => {
        const existing = prefs.find((x) => x.user_id === where.user_id);
        if (existing) {
          Object.assign(existing, update, { updated_at: new Date() });
          return { ...existing };
        }
        const row: MockPref = {
          id: `p-new-${++seq}`,
          user_id: create['user_id'] as string,
          notify_new_invoice: create['notify_new_invoice'] as boolean,
          notify_second_approval_request: create['notify_second_approval_request'] as boolean,
          notify_daily_digest: create['notify_daily_digest'] as boolean,
          notify_decision_outcome: create['notify_decision_outcome'] as boolean,
          updated_at: new Date(),
          updated_by: (create['updated_by'] as string | null) ?? null,
        };
        // The upsert `create` payload spreads the flipped column last, so honour
        // any key the caller set beyond the four defaults.
        for (const k of [
          'notify_new_invoice',
          'notify_second_approval_request',
          'notify_daily_digest',
          'notify_decision_outcome',
        ] as const) {
          if (k in create) row[k] = create[k] as boolean;
        }
        prefs.push(row);
        return { ...row };
      },
    ),
  };

  const approverClient = {
    findMany: vi.fn(async () => roster.map((r) => ({ user_id: r.user_id }))),
  };

  const auditLogClient = {
    create: vi.fn(async ({ data }: { data: AnyRecord }) => {
      auditRows.push({
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        before: data['before'],
        after: data['after'],
      });
      return { id: `audit-${auditRows.length}` };
    }),
  };

  const client = {
    user: userClient,
    apApprovalRouting: routingClient,
    apNotificationPref: prefClient,
    apApprover: approverClient,
    auditLog: auditLogClient,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client)),
  };
  return { prisma: client };
});

beforeEach(() => {
  resetStores();
});

// ── Helpers ─────────────────────────────────────────────────────

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

function patch(body: unknown): Request {
  return req('http://x/api/admin/ap/config', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ConfigShape {
  routing: {
    id: string;
    first_approver: { id: string };
    second_approver: { id: string; reachable: boolean };
  }[];
  prefs: { person: { id: string }; has_row: boolean; values: Record<string, boolean> }[];
  approvers: { id: string }[];
  selectable: { id: string; email: string | null }[];
  namesakes: { id: string }[];
  problems: { code: string; severity: string; subjectUserId: string | null }[];
}

async function getConfig(query = ''): Promise<ConfigShape> {
  const { GET } = await import('./route');
  const res = await GET(req(`http://x/api/admin/ap/config${query}`));
  expect(res.status).toBe(200);
  return ((await res.json()) as { config: ConfigShape }).config;
}

const asAdmin = () => {
  mockSession = { user: { id: U.bill, role: 'admin' } };
};

// ── Role gate ───────────────────────────────────────────────────

describe('admin gate — server-side, never trusting the page layer', () => {
  it('GET returns 401 when unauthenticated', async () => {
    const { GET } = await import('./route');
    mockSession = null;
    expect((await GET(req('http://x/api/admin/ap/config'))).status).toBe(401);
  });

  it('GET returns 403 for a manager', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: U.morena, role: 'manager' } };
    expect((await GET(req('http://x/api/admin/ap/config'))).status).toBe(403);
  });

  it('GET returns 403 for an operator', async () => {
    const { GET } = await import('./route');
    mockSession = { user: { id: U.morenaOp, role: 'operator' } };
    expect((await GET(req('http://x/api/admin/ap/config'))).status).toBe(403);
  });

  it('PATCH returns 401 when unauthenticated and writes nothing', async () => {
    const { PATCH } = await import('./route');
    mockSession = null;
    const res = await PATCH(
      patch({ action: 'set_pref', user_id: U.rick, event: 'new_invoice', value: false }),
    );
    expect(res.status).toBe(401);
    expect(auditRows).toHaveLength(0);
    expect(prefs.find((p) => p.user_id === U.rick)).toBeUndefined();
  });

  it('PATCH returns 403 for a manager and writes nothing', async () => {
    const { PATCH } = await import('./route');
    mockSession = { user: { id: U.morena, role: 'manager' } };
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.shannon,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(403);
    expect(auditRows).toHaveLength(0);
    expect(routing.find((r) => r.first_approver_id === U.rick)).toBeUndefined();
  });
});

// ── The email-less operator PIN accounts ────────────────────────

describe('reachability — the email-less operator PIN accounts', () => {
  it('are not offered as second approvers', async () => {
    asAdmin();
    const config = await getConfig();
    const ids = config.selectable.map((p) => p.id);
    expect(ids).not.toContain(U.billOp);
    expect(ids).not.toContain(U.morenaOp);
    // ...while their reachable namesakes ARE offered, so the picker is not
    // simply empty of those people.
    expect(ids).toContain(U.bill);
    expect(ids).toContain(U.morena);
    expect(config.selectable.every((p) => !!p.email)).toBe(true);
  });

  it('are disclosed as deliberately-excluded namesakes rather than hidden', async () => {
    asAdmin();
    const config = await getConfig();
    const ids = config.namesakes.map((p) => p.id);
    expect(ids).toContain(U.billOp);
    expect(ids).toContain(U.morenaOp);
  });

  it('are refused server-side even when named directly in the request', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.billOp,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/no email address/i);
    expect(routing.find((r) => r.first_approver_id === U.rick)).toBeUndefined();
    expect(auditRows).toHaveLength(0);
  });

  it('cannot be given notification preferences', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({ action: 'set_pref', user_id: U.morenaOp, event: 'new_invoice', value: true }),
    );
    expect(res.status).toBe(422);
    expect(prefs.find((p) => p.user_id === U.morenaOp)).toBeUndefined();
  });
});

// ── Self-approval ───────────────────────────────────────────────

describe('self-approval is impossible', () => {
  it('is refused before the write', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.rick,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/own second approver/i);
    expect(auditRows).toHaveLength(0);
  });

  it('maps the DB CHECK violation to a readable error, not a 500', async () => {
    asAdmin();
    // Simulate the storage-layer backstop firing (e.g. a future refactor that
    // skips the pre-check): Postgres raises the named constraint.
    upsertThrows = new Error(
      'new row for relation "ap_approval_routing" violates check constraint "ap_approval_routing_no_self_approval"',
    );
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.shannon,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/own second approver/i);
  });
});

// ── Totality warning ────────────────────────────────────────────

describe('the routing table must be TOTAL', () => {
  it('warns for every active approver with no routing row', async () => {
    asAdmin();
    const config = await getConfig();
    const missing = config.problems.filter((p) => p.code === 'missing_routing_row');
    const subjects = missing.map((p) => p.subjectUserId);
    // Rick, Shannon and Bill have no row in the fixture; Janette and Morena do.
    expect(subjects).toEqual(expect.arrayContaining([U.rick, U.shannon, U.bill]));
    expect(subjects).not.toContain(U.janette);
    expect(subjects).not.toContain(U.morena);
  });

  it('grades a roster member or admin as `error` and an off-roster approver as `warning`', async () => {
    asAdmin();
    const config = await getConfig();
    const bySubject = new Map(
      config.problems
        .filter((p) => p.code === 'missing_routing_row')
        .map((p) => [p.subjectUserId, p.severity]),
    );
    expect(bySubject.get(U.rick)).toBe('error'); // on the ap_approvers roster
    expect(bySubject.get(U.bill)).toBe('error'); // admin — always able to first-approve
    expect(bySubject.get(U.shannon)).toBe('warning'); // approver role, off the roster
  });

  it('clears the warning once the pair is configured', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.shannon,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(200);
    const config = await getConfig();
    const subjects = config.problems
      .filter((p) => p.code === 'missing_routing_row')
      .map((p) => p.subjectUserId);
    expect(subjects).not.toContain(U.rick);
  });

  it('reports a row that points at an unreachable second approver', async () => {
    asAdmin();
    // Deactivate Morena — Janette's row now routes to somebody unreachable.
    const morena = users.find((u) => u.id === U.morena);
    if (morena) morena.is_active = false;
    const config = await getConfig();
    const codes = config.problems.map((p) => p.code);
    expect(codes).toContain('unreachable_second_approver');
  });
});

// ── Audit ───────────────────────────────────────────────────────

describe('every mutation writes an audit row in the same transaction', () => {
  it('records an insert for a new routing pair', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.shannon,
        fallback_approver_id: U.bill,
        fallback_after_hours: 8,
        active: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    const [row] = auditRows;
    expect(row?.table_name).toBe('ap_approval_routing');
    expect(row?.action).toBe('insert');
    // Prisma's JSON-null sentinel — an insert has no prior state to record.
    expect(row?.before).toBe(Prisma.JsonNull);
    expect(row?.after).toMatchObject({
      first_approver_id: U.rick,
      second_approver_id: U.shannon,
      fallback_approver_id: U.bill,
      fallback_after_hours: 8,
    });
  });

  it('records an update with the BEFORE snapshot when a pair changes', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.janette,
        second_approver_id: U.rick,
        fallback_approver_id: null,
        fallback_after_hours: 24,
        active: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe('update');
    expect(auditRows[0]?.before).toMatchObject({ second_approver_id: U.morena });
    expect(auditRows[0]?.after).toMatchObject({ second_approver_id: U.rick });
  });

  it('records a pref flip', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'set_pref',
        user_id: U.shannon,
        event: 'second_approval_request',
        value: false,
      }),
    );
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.table_name).toBe('ap_notification_prefs');
    expect(auditRows[0]?.action).toBe('update');
    expect(auditRows[0]?.before).toMatchObject({ notify_second_approval_request: true });
    expect(auditRows[0]?.after).toMatchObject({ notify_second_approval_request: false });
  });
});

// ── Prefs semantics ─────────────────────────────────────────────

describe('notification preferences', () => {
  it('shows EFFECTIVE values for a user with no row, flagged as defaults', async () => {
    asAdmin();
    const config = await getConfig();
    const rick = config.prefs.find((p) => p.person.id === U.rick);
    expect(rick?.has_row).toBe(false);
    // A missing row means COLUMN DEFAULTS, never "notify nobody".
    expect(rick?.values['new_invoice']).toBe(true);
    expect(rick?.values['second_approval_request']).toBe(true);
    expect(rick?.values['daily_digest']).toBe(false);
    expect(rick?.values['decision_outcome']).toBe(false);
  });

  it('materialises a row from the DEFAULTS, not from all-false', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({ action: 'set_pref', user_id: U.rick, event: 'daily_digest', value: true }),
    );
    expect(res.status).toBe(200);
    const row = prefs.find((p) => p.user_id === U.rick);
    expect(row).toBeDefined();
    expect(row?.notify_daily_digest).toBe(true);
    // The other three must keep their defaults — writing one event must not
    // silently switch the rest off.
    expect(row?.notify_new_invoice).toBe(true);
    expect(row?.notify_second_approval_request).toBe(true);
    expect(row?.notify_decision_outcome).toBe(false);
  });

  it('refuses to enable decision_outcome — it has no send path', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({ action: 'set_pref', user_id: U.rick, event: 'decision_outcome', value: true }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/not wired/i);
    expect(prefs.find((p) => p.user_id === U.rick)).toBeUndefined();
    expect(auditRows).toHaveLength(0);
  });

  it('offers prefs only for approver-role accounts', async () => {
    asAdmin();
    const config = await getConfig();
    const ids = config.prefs.map((p) => p.person.id);
    expect(ids).not.toContain(U.billOp);
    expect(ids).not.toContain(U.morenaOp);
    expect(ids).toEqual(expect.arrayContaining([U.bill, U.morena, U.janette, U.rick, U.shannon]));
  });
});

// ── Payload validation ──────────────────────────────────────────

describe('payload validation', () => {
  it('rejects an out-of-range escalation clock', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    const res = await PATCH(
      patch({
        action: 'save_routing',
        first_approver_id: U.rick,
        second_approver_id: U.shannon,
        fallback_approver_id: null,
        fallback_after_hours: 0,
        active: true,
      }),
    );
    expect(res.status).toBe(422);
    expect(auditRows).toHaveLength(0);
  });

  it('rejects an unknown action', async () => {
    asAdmin();
    const { PATCH } = await import('./route');
    expect((await PATCH(patch({ action: 'drop_table' }))).status).toBe(422);
  });

  it('honours the routing status filter', async () => {
    asAdmin();
    const inactive = routing[0];
    if (inactive) inactive.active = false;
    expect((await getConfig()).routing.map((r) => r.id)).toEqual(['r-2']);
    expect((await getConfig('?status=inactive')).routing.map((r) => r.id)).toEqual(['r-1']);
    expect((await getConfig('?status=all')).routing.map((r) => r.id)).toEqual(['r-1', 'r-2']);
  });
});
