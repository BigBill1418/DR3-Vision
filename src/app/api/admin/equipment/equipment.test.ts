// ADR-0063 — admin equipment master: API integration tests.
//
// Stands the route handlers up in-process against mocked Prisma + auth. What
// these lock down:
//   - the admin-only gate on EVERY handler (the API must never lean on the
//     page-layer `checkAdmin()`)
//   - the never-hard-delete invariant (no DELETE handler exists at all)
//   - `(site_id, display_name)` uniqueness — both the friendly pre-check and
//     the P2002 race backstop
//   - that `site_id` IS movable, even on an asset an AP approval cites — the
//     lock this file originally asserted was reversed by ADR-0046 Amendment 7
//     (ADR-0063 D4); a regression here would re-break the C-28 correction path
//   - an audit row lands for every mutation, inside the same transaction

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Test doubles ────────────────────────────────────────────────

let mockSession: { user: { id: string; role: string } } | null = null;

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(async () => mockSession),
}));

type Category = 'vehicle' | 'forklift' | 'baler' | 'terex' | 'other';

interface MockEquipment {
  id: string;
  site_id: string;
  display_name: string;
  category: Category;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface MockSite {
  id: string;
  code: string;
  name: string;
}

interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  before: unknown;
  after: unknown;
}

const equipmentStore = new Map<string, MockEquipment>();
const sitesStore = new Map<string, MockSite>();
/** equipment_id -> number of ap_equipment_links rows citing it. */
const linkStore = new Map<string, number>();
const auditRows: AuditRow[] = [];
/** When set, the next equipment.create throws this (P2002 race simulation). */
let createThrows: unknown = null;

const EUGENE = 'site-eugene';
const WOODLAND = 'site-woodland';

function insertEquipment(p: Partial<MockEquipment> & { id: string; display_name: string }) {
  const now = new Date('2026-07-28T12:00:00Z');
  const e: MockEquipment = {
    id: p.id,
    site_id: p.site_id ?? EUGENE,
    display_name: p.display_name,
    category: p.category ?? 'vehicle',
    is_active: p.is_active ?? true,
    created_at: p.created_at ?? now,
    updated_at: p.updated_at ?? now,
  };
  equipmentStore.set(e.id, e);
  return e;
}

function resetStores() {
  equipmentStore.clear();
  sitesStore.clear();
  linkStore.clear();
  auditRows.length = 0;
  createThrows = null;
  sitesStore.set(EUGENE, { id: EUGENE, code: 'eugene', name: 'DR3 Eugene' });
  sitesStore.set(WOODLAND, { id: WOODLAND, code: 'woodland', name: 'DR3 Woodland' });

  insertEquipment({ id: 'eq-1', display_name: 'EQ43 — Terex Shear', category: 'terex' });
  insertEquipment({ id: 'eq-2', display_name: 'F60 — Hyster Forklift', category: 'forklift' });
  insertEquipment({
    id: 'eq-3',
    display_name: 'EQ88 — Great Dane Trailer',
    site_id: WOODLAND,
    category: 'vehicle',
  });
  insertEquipment({
    id: 'eq-dead',
    display_name: 'EQ12 — Scrapped Tractor',
    is_active: false,
  });
  // eq-1 is cited by two AP approvals — the "cited asset stays editable" fixture.
  linkStore.set('eq-1', 2);
}

function matchesWhere(e: MockEquipment, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'site_id' && e.site_id !== v) return false;
    if (k === 'category' && e.category !== v) return false;
    if (k === 'is_active' && e.is_active !== v) return false;
    if (k === 'display_name') {
      if (typeof v === 'string') {
        if (e.display_name !== v) return false;
      } else if (typeof v === 'object' && v !== null && 'contains' in v) {
        const { contains, mode } = v as { contains: string; mode?: string };
        const hay = mode === 'insensitive' ? e.display_name.toLowerCase() : e.display_name;
        const needle = mode === 'insensitive' ? contains.toLowerCase() : contains;
        if (!hay.includes(needle)) return false;
      }
    }
    if (k === 'id') {
      if (typeof v === 'object' && v !== null && 'not' in v) {
        if (e.id === (v as { not: unknown }).not) return false;
      } else if (typeof v === 'string' && e.id !== v) return false;
    }
  }
  return true;
}

function findAll(where: Record<string, unknown> | undefined): MockEquipment[] {
  const out: MockEquipment[] = [];
  for (const e of equipmentStore.values()) if (!where || matchesWhere(e, where)) out.push({ ...e });
  return out;
}

vi.mock('@/lib/prisma', () => {
  const equipmentClient = {
    findMany: vi.fn(
      async ({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) => {
        const rows = findAll(where);
        if (orderBy) rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
        return rows;
      },
    ),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      const e = equipmentStore.get(where.id);
      return e ? { ...e } : null;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return findAll(where)[0] ?? null;
    }),
    create: vi.fn(async ({ data }: { data: Partial<MockEquipment> }) => {
      if (createThrows) {
        const t = createThrows;
        createThrows = null;
        throw t;
      }
      return insertEquipment({
        id: `eq-new-${equipmentStore.size + 1}`,
        site_id: data.site_id ?? EUGENE,
        display_name: data.display_name ?? '',
        category: data.category ?? 'vehicle',
        is_active: data.is_active ?? true,
      });
    }),
    update: vi.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = equipmentStore.get(where.id);
        if (!e) throw new Error('not found');
        for (const k of ['site_id', 'display_name', 'category', 'is_active'] as const) {
          if (k in data) (e as unknown as Record<string, unknown>)[k] = data[k];
        }
        e.updated_at = new Date();
        return { ...e };
      },
    ),
  };

  const linkClient = {
    count: vi.fn(async ({ where }: { where: { equipment_id: string } }) => {
      return linkStore.get(where.equipment_id) ?? 0;
    }),
    groupBy: vi.fn(async ({ where }: { where: { equipment_id: { in: string[] } } }) => {
      return where.equipment_id.in
        .filter((id) => (linkStore.get(id) ?? 0) > 0)
        .map((id) => ({ equipment_id: id, _count: { _all: linkStore.get(id) ?? 0 } }));
    }),
  };

  const siteClient = {
    findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
      where.id ? (sitesStore.get(where.id) ?? null) : null,
    ),
    findMany: vi.fn(async () => Array.from(sitesStore.values())),
  };

  const auditLogClient = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
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

  return {
    prisma: {
      equipment: equipmentClient,
      apEquipmentLink: linkClient,
      site: siteClient,
      auditLog: auditLogClient,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          equipment: equipmentClient,
          apEquipmentLink: linkClient,
          site: siteClient,
          auditLog: auditLogClient,
        }),
      ),
    },
  };
});

beforeEach(() => {
  resetStores();
  mockSession = null;
});

// ── Helpers ─────────────────────────────────────────────────────

function post(body: unknown): Request {
  return new Request('http://x/api/admin/equipment', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function patchReq(body: unknown): Request {
  return new Request('http://x/api/admin/equipment/eq-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const asAdmin = () => {
  mockSession = { user: { id: 'admin-1', role: 'admin' } };
};

interface EquipmentBody {
  equipment: {
    id: string;
    site_id: string;
    site_code: string | null;
    display_name: string;
    category: Category;
    is_active: boolean;
    link_count: number;
  };
}

// ── Gate ────────────────────────────────────────────────────────

describe('admin gate', () => {
  it.each([
    ['anonymous', null, 401],
    ['operator', { user: { id: 'o', role: 'operator' } }, 403],
    ['manager', { user: { id: 'm', role: 'manager' } }, 403],
  ] as const)('POST rejects %s with %s', async (_label, session, status) => {
    const { POST } = await import('./route');
    mockSession = session;
    const res = await POST(post({ site_id: EUGENE, display_name: 'X', category: 'other' }));
    expect(res.status).toBe(status);
  });

  it.each([
    ['anonymous', null, 401],
    ['manager', { user: { id: 'm', role: 'manager' } }, 403],
  ] as const)('GET rejects %s with %s', async (_label, session, status) => {
    const { GET } = await import('./route');
    mockSession = session;
    const res = await GET(new Request('http://x/api/admin/equipment'));
    expect(res.status).toBe(status);
  });

  it.each([
    ['anonymous', null, 401],
    ['manager', { user: { id: 'm', role: 'manager' } }, 403],
  ] as const)('PATCH rejects %s with %s', async (_label, session, status) => {
    const { PATCH } = await import('./[id]/route');
    mockSession = session;
    const res = await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));
    expect(res.status).toBe(status);
  });

  it('a rejected PATCH mutates nothing and writes no audit row', async () => {
    const { PATCH } = await import('./[id]/route');
    mockSession = { user: { id: 'm', role: 'manager' } };
    await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));
    expect(equipmentStore.get('eq-1')?.is_active).toBe(true);
    expect(auditRows).toHaveLength(0);
  });
});

// ── Never hard-delete ───────────────────────────────────────────

describe('never hard-delete (ap_equipment_links is onDelete: Restrict)', () => {
  it('exposes no DELETE handler on the collection route', async () => {
    const mod = await import('./route');
    expect('DELETE' in mod).toBe(false);
  });

  it('exposes no DELETE handler on the per-asset route', async () => {
    // The users route ships DELETE as a deactivate alias; equipment must not,
    // so no client can form a request that even looks like a delete.
    const mod = await import('./[id]/route');
    expect('DELETE' in mod).toBe(false);
  });

  it('rejects a delete-shaped PATCH action', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'delete' }), idParams('eq-1'));
    expect(res.status).toBe(422);
    expect(equipmentStore.has('eq-1')).toBe(true);
  });
});

// ── Create ──────────────────────────────────────────────────────

describe('POST /api/admin/equipment', () => {
  it('creates and returns the DTO with the resolved site code', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: WOODLAND, display_name: 'EQ90 — Volvo Tractor', category: 'vehicle' }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as EquipmentBody;
    expect(body.equipment.display_name).toBe('EQ90 — Volvo Tractor');
    expect(body.equipment.site_code).toBe('woodland');
    expect(body.equipment.is_active).toBe(true);
    expect(body.equipment.link_count).toBe(0);
  });

  it('writes an insert audit row against table_name=equipment', async () => {
    const { POST } = await import('./route');
    asAdmin();
    await POST(post({ site_id: EUGENE, display_name: 'EQ91 — Ford F-350', category: 'vehicle' }));
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row?.action).toBe('insert');
    expect(row?.table_name).toBe('equipment');
    expect(row?.before).toBeDefined();
    expect(row?.after).toMatchObject({ display_name: 'EQ91 — Ford F-350' });
  });

  it('normalises the stored name (trim + collapse internal whitespace)', async () => {
    // Without this, "EQ43  — Shear" and "EQ43 — Shear" are distinct to Postgres
    // but identical to a human, and the seed script's (site_id, display_name)
    // idempotency key stops meaning anything.
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({
        site_id: EUGENE,
        display_name: '  EQ92   —   Wabash   Trailer ',
        category: 'vehicle',
      }),
    );
    const body = (await res.json()) as EquipmentBody;
    expect(body.equipment.display_name).toBe('EQ92 — Wabash Trailer');
  });

  it('rejects a duplicate name within the same site with 409', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: EUGENE, display_name: 'EQ43 — Terex Shear', category: 'terex' }),
    );
    expect(res.status).toBe(409);
    expect(auditRows).toHaveLength(0);
  });

  it('rejects a duplicate that differs only by whitespace', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: EUGENE, display_name: 'EQ43  —  Terex Shear ', category: 'terex' }),
    );
    expect(res.status).toBe(409);
  });

  it('rejects a duplicate of a DEACTIVATED row — reactivate instead of re-create', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: EUGENE, display_name: 'EQ12 — Scrapped Tractor', category: 'vehicle' }),
    );
    expect(res.status).toBe(409);
  });

  it('ALLOWS the same name at the OTHER site — uniqueness is per-site', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: WOODLAND, display_name: 'EQ43 — Terex Shear', category: 'terex' }),
    );
    expect(res.status).toBe(201);
  });

  it('maps a P2002 unique violation to 409 — the check-then-act race backstop', async () => {
    // The app-level pre-check cannot see a row a concurrent request is mid-way
    // through inserting; the DB index is the real guarantee and must surface as
    // the same readable conflict, never a 500.
    const { POST } = await import('./route');
    asAdmin();
    createThrows = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    const res = await POST(
      post({ site_id: EUGENE, display_name: 'EQ93 — Racy Trailer', category: 'vehicle' }),
    );
    expect(res.status).toBe(409);
  });

  it('rejects an unknown site with 422', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(
      post({ site_id: 'site-nowhere', display_name: 'EQ94', category: 'other' }),
    );
    expect(res.status).toBe(422);
  });

  it('rejects an unknown category with 422', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(post({ site_id: EUGENE, display_name: 'EQ95', category: 'spaceship' }));
    expect(res.status).toBe(422);
  });

  it('rejects a whitespace-only name', async () => {
    const { POST } = await import('./route');
    asAdmin();
    const res = await POST(post({ site_id: EUGENE, display_name: '   ', category: 'other' }));
    expect(res.status).toBe(422);
    expect(auditRows).toHaveLength(0);
  });
});

// ── List ────────────────────────────────────────────────────────

describe('GET /api/admin/equipment', () => {
  async function list(qs: string) {
    const { GET } = await import('./route');
    asAdmin();
    const res = await GET(new Request(`http://x/api/admin/equipment${qs}`));
    expect(res.status).toBe(200);
    return ((await res.json()) as { equipment: EquipmentBody['equipment'][] }).equipment;
  }

  it('defaults to active only', async () => {
    const rows = await list('');
    expect(rows.map((r) => r.id)).not.toContain('eq-dead');
    expect(rows).toHaveLength(3);
  });

  it('status=inactive returns only deactivated rows', async () => {
    const rows = await list('?status=inactive');
    expect(rows.map((r) => r.id)).toEqual(['eq-dead']);
  });

  it('status=all returns everything', async () => {
    expect(await list('?status=all')).toHaveLength(4);
  });

  it('filters by site', async () => {
    const rows = await list(`?site=${WOODLAND}`);
    expect(rows.map((r) => r.id)).toEqual(['eq-3']);
  });

  it('filters by category', async () => {
    const rows = await list('?category=forklift');
    expect(rows.map((r) => r.id)).toEqual(['eq-2']);
  });

  it('searches display_name case-insensitively', async () => {
    const rows = await list('?q=terex');
    expect(rows.map((r) => r.id)).toEqual(['eq-1']);
  });

  it('composes search with the site filter', async () => {
    expect(await list(`?q=terex&site=${WOODLAND}`)).toHaveLength(0);
  });

  it('reports the AP link count so the admin can see what is cited', async () => {
    const rows = await list('');
    expect(rows.find((r) => r.id === 'eq-1')?.link_count).toBe(2);
    expect(rows.find((r) => r.id === 'eq-2')?.link_count).toBe(0);
  });
});

// ── Update ──────────────────────────────────────────────────────

describe('PATCH { action: update }', () => {
  it('renames and writes an update audit row with before/after', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(
      patchReq({ action: 'update', display_name: 'EQ43 — Terex TXS Shear' }),
      idParams('eq-1'),
    );
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-1')?.display_name).toBe('EQ43 — Terex TXS Shear');
    const row = auditRows[0];
    expect(row?.action).toBe('update');
    expect(row?.before).toMatchObject({ display_name: 'EQ43 — Terex Shear' });
    expect(row?.after).toMatchObject({ display_name: 'EQ43 — Terex TXS Shear' });
  });

  it('allows a rename even on a linked asset — a typo must be fixable', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    // eq-1 has 2 AP links.
    const res = await PATCH(
      patchReq({ action: 'update', display_name: 'EQ43 — Terex Shear (Woodland yard)' }),
      idParams('eq-1'),
    );
    expect(res.status).toBe(200);
  });

  it('changes category', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'update', category: 'baler' }), idParams('eq-2'));
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-2')?.category).toBe('baler');
  });

  it('moves an UNLINKED asset to the other site', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(
      patchReq({ action: 'update', site_id: WOODLAND }),
      idParams('eq-2'), // no AP links
    );
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-2')?.site_id).toBe(WOODLAND);
  });

  it('ALSO moves an asset cited by an AP approval — site is NOT locked (ADR-0063 D4)', async () => {
    // This file originally asserted the opposite. ADR-0046 Amendment 7 made the
    // approver's picker fleet-wide, so `site_id` no longer decides who can pick
    // the asset — and the coarse C-28 seed data is exactly what this screen
    // exists to correct. Locking it would have made the MOST-cited assets the
    // ones nobody could fix.
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    expect(linkStore.get('eq-1')).toBe(2);
    const res = await PATCH(patchReq({ action: 'update', site_id: WOODLAND }), idParams('eq-1'));
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-1')?.site_id).toBe(WOODLAND);
    // the move is audited like any other edit
    expect(auditRows[0]?.action).toBe('update');
    expect(auditRows[0]?.before).toMatchObject({ site_id: EUGENE });
    expect(auditRows[0]?.after).toMatchObject({ site_id: WOODLAND });
  });

  it('a cross-site move still obeys per-site name uniqueness', async () => {
    // The one thing that DOES still constrain a transfer.
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    insertEquipment({ id: 'eq-clash', display_name: 'EQ43 — Terex Shear', site_id: WOODLAND });
    const res = await PATCH(patchReq({ action: 'update', site_id: WOODLAND }), idParams('eq-1'));
    expect(res.status).toBe(409);
    expect(equipmentStore.get('eq-1')?.site_id).toBe(EUGENE);
  });

  it('rejects a rename that collides with a peer at the same site', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(
      patchReq({ action: 'update', display_name: 'F60 — Hyster Forklift' }),
      idParams('eq-1'),
    );
    expect(res.status).toBe(409);
    expect(equipmentStore.get('eq-1')?.display_name).toBe('EQ43 — Terex Shear');
  });

  it('a no-op rename to its OWN name is not a self-collision', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(
      patchReq({ action: 'update', display_name: 'EQ43 — Terex Shear' }),
      idParams('eq-1'),
    );
    expect(res.status).toBe(200);
  });

  it('404s an unknown id', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'update', category: 'other' }), idParams('nope'));
    expect(res.status).toBe(404);
  });
});

// ── Deactivate / reactivate ─────────────────────────────────────

describe('PATCH { action: deactivate | reactivate }', () => {
  // Post ADR-0046 Amendment 7 the AP picker filters on `is_active` and NOTHING
  // else, so this pair is the only mechanism that adds or removes an option on
  // a financial-approval surface. These cases pin that weight.

  it('deactivate is what actually removes the asset from the fleet-wide picker', async () => {
    // Mirrors `listSiteEquipment()`'s post-Amendment-7 predicate exactly:
    // `where: { is_active: true }` with no site term.
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const pickerBefore = findAll({ is_active: true }).map((e) => e.id);
    expect(pickerBefore).toContain('eq-1');

    await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));

    const pickerAfter = findAll({ is_active: true }).map((e) => e.id);
    expect(pickerAfter).not.toContain('eq-1');
    // and it leaves BOTH sites' approvers without it, because the picker is
    // fleet-wide — this is not a per-site removal.
    expect(findAll({ is_active: true, site_id: EUGENE }).map((e) => e.id)).not.toContain('eq-1');
    expect(findAll({ is_active: true, site_id: WOODLAND }).map((e) => e.id)).not.toContain('eq-1');
  });

  it('reactivate puts a scrapped asset back in front of approvers', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    expect(findAll({ is_active: true }).map((e) => e.id)).not.toContain('eq-dead');
    await PATCH(patchReq({ action: 'reactivate' }), idParams('eq-dead'));
    expect(findAll({ is_active: true }).map((e) => e.id)).toContain('eq-dead');
  });

  it('a no-op flip is still audited — the assertion itself is the fact', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    // eq-2 is already active; reactivating is a no-op state-wise.
    const res = await PATCH(patchReq({ action: 'reactivate' }), idParams('eq-2'));
    expect(res.status).toBe(200);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe('restore');
  });

  it('deactivate flips is_active and audits as soft_delete', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-1')?.is_active).toBe(false);
    expect(auditRows[0]?.action).toBe('soft_delete');
    expect(auditRows[0]?.table_name).toBe('equipment');
  });

  it('deactivate KEEPS the row and its AP links — it is not a delete', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));
    expect(equipmentStore.has('eq-1')).toBe(true);
    expect(linkStore.get('eq-1')).toBe(2);
  });

  it('deactivate works on a linked asset — linkage never blocks removal', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'deactivate' }), idParams('eq-1'));
    expect(res.status).toBe(200);
  });

  it('reactivate flips it back and audits as restore', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'reactivate' }), idParams('eq-dead'));
    expect(res.status).toBe(200);
    expect(equipmentStore.get('eq-dead')?.is_active).toBe(true);
    expect(auditRows[0]?.action).toBe('restore');
  });

  it('404s an unknown id', async () => {
    const { PATCH } = await import('./[id]/route');
    asAdmin();
    const res = await PATCH(patchReq({ action: 'deactivate' }), idParams('nope'));
    expect(res.status).toBe(404);
    expect(auditRows).toHaveLength(0);
  });
});
