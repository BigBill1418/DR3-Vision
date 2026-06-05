// ADR-0019 §9 — Bonus employee data-layer unit tests.
//
// Drives the REAL data-layer functions against an in-memory Prisma mock
// (the canonical pattern from src/app/api/admin/users/users.test.ts). Verifies:
//   - create writes the row + an insert audit row (table_name bonus_employees)
//   - all queries are Woodland site-scoped (a same-name employee at another
//     site does NOT collide)
//   - deactivate soft-deletes + writes soft_delete audit, captures before/after
//   - rename appends previous name + timestamp and audits before/after (§9b)
//   - re-adding a deactivated name returns the rehire_candidate signal (§9a)
//   - reactivate clears the soft-delete + writes a restore audit row

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  previous_names: unknown;
  is_active: boolean;
  user_id: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  actor_user_id: string | null;
  before: unknown;
  after: unknown;
}

const empStore = new Map<string, MockEmployee>();
const auditRows: AuditRow[] = [];
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function resetStores() {
  empStore.clear();
  auditRows.length = 0;
  idCounter = 0;
}

function insertEmp(
  p: Partial<MockEmployee> & { full_name: string; site_id: string },
): MockEmployee {
  const now = new Date();
  const e: MockEmployee = {
    id: p.id ?? `emp-${++idCounter}`,
    site_id: p.site_id,
    full_name: p.full_name,
    previous_names: p.previous_names ?? [],
    is_active: p.is_active ?? true,
    user_id: p.user_id ?? null,
    notes: p.notes ?? null,
    created_at: p.created_at ?? now,
    updated_at: p.updated_at ?? now,
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
  }
  return true;
}

function applyOrderBy(
  rows: MockEmployee[],
  orderBy: Array<Record<string, 'asc' | 'desc'>> | undefined,
): MockEmployee[] {
  if (!orderBy) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const clause of orderBy) {
      const [field, dir] = Object.entries(clause)[0] as [keyof MockEmployee, 'asc' | 'desc'];
      const av = a[field];
      const bv = b[field];
      let cmp = 0;
      if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = av === bv ? 0 : av ? 1 : -1;
      else cmp = String(av).localeCompare(String(bv));
      if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return sorted;
}

vi.mock('@/lib/prisma', () => {
  const bonusEmployeeClient = {
    findMany: vi.fn(
      async ({
        where,
        orderBy,
      }: {
        where?: Record<string, unknown>;
        orderBy?: Array<Record<string, 'asc' | 'desc'>>;
      } = {}) => {
        const out: MockEmployee[] = [];
        for (const e of empStore.values()) {
          if (!where || matchesWhere(e, where)) out.push(e);
        }
        return applyOrderBy(out, orderBy).map((e) => ({ ...e }));
      },
    ),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      for (const e of empStore.values()) {
        if (matchesWhere(e, where)) return { ...e };
      }
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Partial<MockEmployee> }) => {
      const e = insertEmp({
        site_id: data.site_id as string,
        full_name: data.full_name as string,
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

  const auditLogClient = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRows.push({
        action: data['action'] as string,
        table_name: data['table_name'] as string,
        row_id: data['row_id'] as string,
        actor_user_id: (data['actor_user_id'] as string | null) ?? null,
        before: data['before'],
        after: data['after'],
      });
      return { id: `audit-${auditRows.length}` };
    }),
  };

  return {
    prisma: {
      bonusEmployee: bonusEmployeeClient,
      auditLog: auditLogClient,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ bonusEmployee: bonusEmployeeClient, auditLog: auditLogClient }),
      ),
    },
  };
});

const ACTOR = { actorUserId: 'janette-1', ip: '10.0.0.1', userAgent: 'vitest' };

beforeEach(() => {
  resetStores();
});

describe('createEmployee', () => {
  it('creates an employee and writes an insert audit row for bonus_employees', async () => {
    const { createEmployee } = await import('./employees');
    const r = await createEmployee(WOODLAND, { full_name: '  Maria Lopez  ' }, ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.full_name).toBe('Maria Lopez'); // trimmed
    expect(r.employee.site_id).toBe(WOODLAND);
    expect(r.employee.is_active).toBe(true);
    expect(r.employee.previous_names).toEqual([]);

    const row = auditRows.find((a) => a.action === 'insert' && a.row_id === r.employee.id);
    expect(row).toBeDefined();
    expect(row?.table_name).toBe('bonus_employees');
    expect(row?.actor_user_id).toBe('janette-1');
    const afterJson = JSON.stringify(row?.after);
    expect(afterJson).toContain('Maria Lopez');
  });

  it('rejects an empty name', async () => {
    const { createEmployee } = await import('./employees');
    const r = await createEmployee(WOODLAND, { full_name: '   ' }, ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('name_required');
  });

  it('rejects a name already held by an ACTIVE employee at the site', async () => {
    insertEmp({ id: 'e-active', site_id: WOODLAND, full_name: 'Dup Name', is_active: true });
    const { createEmployee } = await import('./employees');
    const r = await createEmployee(WOODLAND, { full_name: 'dup name' }, ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('name_taken');
  });

  it('is site-scoped: a same-name employee at Eugene does NOT block a Woodland create', async () => {
    insertEmp({ id: 'e-eugene', site_id: EUGENE, full_name: 'Cross Site', is_active: true });
    const { createEmployee } = await import('./employees');
    const r = await createEmployee(WOODLAND, { full_name: 'Cross Site' }, ACTOR);
    expect(r.ok).toBe(true);
  });
});

describe('deactivateEmployee', () => {
  it('soft-deletes and writes a soft_delete audit row with before/after', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Jane Doe', is_active: true });
    const { deactivateEmployee } = await import('./employees');
    const r = await deactivateEmployee(WOODLAND, 'e1', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.is_active).toBe(false);
    expect(r.employee.deleted_at).toBeTruthy();

    const row = auditRows.find((a) => a.action === 'soft_delete' && a.row_id === 'e1');
    expect(row).toBeDefined();
    expect(row?.table_name).toBe('bonus_employees');
    expect((row?.before as { is_active: boolean }).is_active).toBe(true);
    expect((row?.after as { is_active: boolean }).is_active).toBe(false);
  });

  it('refuses to deactivate a row at another site (not_found)', async () => {
    insertEmp({ id: 'e-eu', site_id: EUGENE, full_name: 'Other', is_active: true });
    const { deactivateEmployee } = await import('./employees');
    const r = await deactivateEmployee(WOODLAND, 'e-eu', ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });
});

describe('renameEmployee (ADR-0019 §9b)', () => {
  it('updates full_name, appends the old name + timestamp to previous_names, audits before/after', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Old Name', is_active: true });
    const { renameEmployee } = await import('./employees');
    const r = await renameEmployee(WOODLAND, 'e1', '  New Name  ', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.full_name).toBe('New Name');
    expect(r.employee.previous_names).toHaveLength(1);
    expect(r.employee.previous_names[0]?.name).toBe('Old Name');
    expect(typeof r.employee.previous_names[0]?.changed_at).toBe('string');
    // ISO timestamp parses
    expect(Number.isNaN(Date.parse(r.employee.previous_names[0]!.changed_at))).toBe(false);

    const row = auditRows.find((a) => a.action === 'update' && a.row_id === 'e1');
    expect(row).toBeDefined();
    expect((row?.before as { full_name: string }).full_name).toBe('Old Name');
    expect((row?.after as { full_name: string }).full_name).toBe('New Name');
  });

  it('accumulates multiple renames in previous_names order', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'First', is_active: true });
    const { renameEmployee } = await import('./employees');
    await renameEmployee(WOODLAND, 'e1', 'Second', ACTOR);
    const r = await renameEmployee(WOODLAND, 'e1', 'Third', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.full_name).toBe('Third');
    expect(r.employee.previous_names.map((p) => p.name)).toEqual(['First', 'Second']);
  });

  it('no-op rename to the same name writes nothing', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Same', is_active: true });
    const { renameEmployee } = await import('./employees');
    const r = await renameEmployee(WOODLAND, 'e1', 'Same', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.previous_names).toEqual([]);
    expect(auditRows.find((a) => a.action === 'update')).toBeUndefined();
  });

  it('rejects rename to a name held by another active employee', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Alpha', is_active: true });
    insertEmp({ id: 'e2', site_id: WOODLAND, full_name: 'Beta', is_active: true });
    const { renameEmployee } = await import('./employees');
    const r = await renameEmployee(WOODLAND, 'e1', 'Beta', ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('name_taken');
  });
});

describe('rehire path (ADR-0019 §9a)', () => {
  it('re-adding a deactivated name returns rehire_candidate with the existing row', async () => {
    insertEmp({
      id: 'e-gone',
      site_id: WOODLAND,
      full_name: 'Rehire Me',
      is_active: false,
      deleted_at: new Date('2026-04-01T00:00:00Z'),
    });
    const { createEmployee } = await import('./employees');
    const r = await createEmployee(WOODLAND, { full_name: 'rehire me' }, ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('rehire_candidate');
    if (r.reason !== 'rehire_candidate') return;
    expect(r.employee.id).toBe('e-gone');
    expect(r.employee.deleted_at).toBeTruthy();
    // No new employee row was created.
    expect(empStore.size).toBe(1);
  });

  it('reactivateEmployee clears the soft-delete and writes a restore audit row', async () => {
    insertEmp({
      id: 'e-gone',
      site_id: WOODLAND,
      full_name: 'Rehire Me',
      is_active: false,
      deleted_at: new Date('2026-04-01T00:00:00Z'),
    });
    const { reactivateEmployee } = await import('./employees');
    const r = await reactivateEmployee(WOODLAND, 'e-gone', ACTOR);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.employee.is_active).toBe(true);
    expect(r.employee.deleted_at).toBeNull();

    const row = auditRows.find((a) => a.action === 'restore' && a.row_id === 'e-gone');
    expect(row).toBeDefined();
    expect(row?.table_name).toBe('bonus_employees');
  });

  it('reactivate refuses an already-active row', async () => {
    insertEmp({ id: 'e1', site_id: WOODLAND, full_name: 'Active', is_active: true });
    const { reactivateEmployee } = await import('./employees');
    const r = await reactivateEmployee(WOODLAND, 'e1', ACTOR);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('already_active');
  });
});

describe('listEmployees', () => {
  beforeEach(() => {
    insertEmp({ id: 'a', site_id: WOODLAND, full_name: 'Bravo', is_active: true });
    insertEmp({ id: 'b', site_id: WOODLAND, full_name: 'Alpha', is_active: true });
    insertEmp({ id: 'c', site_id: WOODLAND, full_name: 'Charlie', is_active: false });
    insertEmp({ id: 'd', site_id: EUGENE, full_name: 'Eugene Guy', is_active: true });
  });

  it('returns only active Woodland rows by default, sorted by name', async () => {
    const { listEmployees } = await import('./employees');
    const rows = await listEmployees(WOODLAND);
    expect(rows.map((r) => r.full_name)).toEqual(['Alpha', 'Bravo']);
  });

  it('status=inactive returns only inactive Woodland rows', async () => {
    const { listEmployees } = await import('./employees');
    const rows = await listEmployees(WOODLAND, { status: 'inactive' });
    expect(rows.map((r) => r.id)).toEqual(['c']);
  });

  it('status=all returns active + inactive, still site-scoped', async () => {
    const { listEmployees } = await import('./employees');
    const rows = await listEmployees(WOODLAND, { status: 'all' });
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(rows.find((r) => r.id === 'd')).toBeUndefined();
  });

  it('sort=status puts active rows first then by name', async () => {
    const { listEmployees } = await import('./employees');
    const rows = await listEmployees(WOODLAND, { status: 'all', sort: 'status' });
    expect(rows.map((r) => r.full_name)).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(rows[rows.length - 1]?.is_active).toBe(false);
  });
});
