// ADR-0019 §4/§7 — Bonus daily-entry data-layer tests (T-105).
//
// DB-free: mocks `@/lib/prisma` with in-memory Maps + a $transaction that runs
// the callback against the same store (mirrors the canonical employees test).
// Drives the REAL `daily-entry.ts` functions. Covers the acceptance criteria:
//   - getDailyGrid pre-loads ACTIVE employees alphabetically with today's row
//   - upsert persists with correct entered_by_user_id (Morena AND Bill can key)
//   - audit row written per upsert, differentiating the actor
//   - writes blocked (month_locked) once the month leaves draft
//   - note field never changes bonus math
//   - active rule is resolved from processor_bonus_rules (never hardcoded)

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory stores ────────────────────────────────────────────
interface MockMonth {
  id: string;
  site_id: string;
  period_start: Date;
  period_end: Date;
  state: 'draft' | 'pending_signatures' | 'partially_signed' | 'signed' | 'paid' | 'amended';
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
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: number;
  note: string | null;
  entered_by_user_id: string;
  entered_at: Date;
}
interface MockRule {
  id: string;
  site_id: string;
  threshold_low: number;
  rate_low: { toString(): string };
  threshold_high: number;
  rate_high: { toString(): string };
  effective_date: Date;
  end_date: Date | null;
}
interface AuditRow {
  action: string;
  table_name: string;
  row_id: string;
  actor_user_id: string | null;
  before: unknown;
  after: unknown;
}

const monthStore = new Map<string, MockMonth>();
const empStore = new Map<string, MockEmployee>();
const entryStore = new Map<string, MockEntry>();
const ruleStore = new Map<string, MockRule>();
const auditRows: AuditRow[] = [];
let idCounter = 0;

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function entryKey(empId: string, date: Date): string {
  return `${empId}|${date.toISOString().slice(0, 10)}`;
}

function reset() {
  monthStore.clear();
  empStore.clear();
  entryStore.clear();
  ruleStore.clear();
  auditRows.length = 0;
  idCounter = 0;

  // Woodland rule (ADR-0019 §1): threshold_low=50 @ $0.50, threshold_high=74 @ $0.25.
  ruleStore.set('rule-wo', {
    id: 'rule-wo',
    site_id: WOODLAND,
    threshold_low: 50,
    rate_low: { toString: () => '0.5000' },
    threshold_high: 74,
    rate_high: { toString: () => '0.2500' },
    effective_date: new Date(Date.UTC(2026, 0, 1)),
    end_date: null,
  });

  // Active employees out of alphabetical order on purpose.
  empStore.set('emp-zane', {
    id: 'emp-zane',
    site_id: WOODLAND,
    full_name: 'Zane',
    is_active: true,
  });
  empStore.set('emp-amy', { id: 'emp-amy', site_id: WOODLAND, full_name: 'Amy', is_active: true });
  empStore.set('emp-bob', { id: 'emp-bob', site_id: WOODLAND, full_name: 'Bob', is_active: true });
  // Inactive — must NOT appear in the grid.
  empStore.set('emp-old', {
    id: 'emp-old',
    site_id: WOODLAND,
    full_name: 'Aaron',
    is_active: false,
  });
  // Another site's employee — must never be writable under Woodland scope.
  empStore.set('emp-eugene', {
    id: 'emp-eugene',
    site_id: EUGENE,
    full_name: 'Eve',
    is_active: true,
  });

  // T-203: periods are PRE-SEEDED (no auto-create). Seed Period 12 of 2026 for
  // Woodland (Tue May 26 → Mon Jun 8), the window covering TODAY (2026-06-05).
  // The daily-entry layer resolves THIS row by date-range.
  monthStore.set('p12-wo', {
    id: 'p12-wo',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(2026, 4, 26)),
    period_end: new Date(Date.UTC(2026, 5, 8)),
    state: 'draft',
  });
}

function matchesEmp(e: MockEmployee, where: Record<string, unknown>): boolean {
  if ('site_id' in where && e.site_id !== where['site_id']) return false;
  if ('is_active' in where && e.is_active !== where['is_active']) return false;
  if ('id' in where) {
    const idW = where['id'] as unknown;
    if (typeof idW === 'string' && e.id !== idW) return false;
    if (idW && typeof idW === 'object' && 'in' in (idW as Record<string, unknown>)) {
      const in_ = (idW as { in: string[] }).in;
      if (!in_.includes(e.id)) return false;
    }
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const bonusPayPeriod = {
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if ('id' in where) return monthStore.get(where['id'] as string) ?? null;
      if ('site_id_period_start' in where) {
        const k = where['site_id_period_start'] as { site_id: string; period_start: Date };
        for (const m of monthStore.values()) {
          if (m.site_id === k.site_id && m.period_start.getTime() === k.period_start.getTime())
            return { ...m };
        }
        return null;
      }
      return null;
    }),
    // T-203: daily-entry resolves the SEEDED period by date-range (no create).
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: {
          site_id: string;
          period_start?: { lte: Date };
          period_end?: { gte?: Date; equals?: Date };
        };
      }) => {
        for (const m of monthStore.values()) {
          if (m.site_id !== where.site_id) continue;
          if (
            where.period_start?.lte &&
            !(m.period_start.getTime() <= where.period_start.lte.getTime())
          )
            continue;
          if (where.period_end?.gte && !(m.period_end.getTime() >= where.period_end.gte.getTime()))
            continue;
          return { ...m };
        }
        return null;
      },
    ),
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
    findMany: vi.fn(
      async ({
        where,
        orderBy,
      }: {
        where?: Record<string, unknown>;
        orderBy?: { full_name?: 'asc' | 'desc' };
      } = {}) => {
        let out = [...empStore.values()].filter((e) => !where || matchesEmp(e, where));
        if (orderBy?.full_name === 'asc') {
          out = out.sort((a, b) => a.full_name.localeCompare(b.full_name));
        }
        return out.map((e) => ({ ...e }));
      },
    ),
  };

  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const out: MockEntry[] = [];
      for (const e of entryStore.values()) {
        if (
          'bonus_pay_period_id' in where &&
          e.bonus_pay_period_id !== where['bonus_pay_period_id']
        )
          continue;
        if (
          'entry_date' in where &&
          e.entry_date.getTime() !== (where['entry_date'] as Date).getTime()
        )
          continue;
        out.push({ ...e });
      }
      return out;
    }),
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
        create: Omit<MockEntry, 'id' | 'entered_at'>;
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
        const row: MockEntry = {
          id: `entry-${++idCounter}`,
          entered_at: new Date(),
          ...create,
        };
        entryStore.set(key, row);
        return { ...row };
      },
    ),
  };

  const processorBonusRule = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const siteId = where['site_id'];
      const eff = (where['effective_date'] as { lte: Date }).lte;
      const candidates = [...ruleStore.values()].filter((r) => {
        if (r.site_id !== siteId) return false;
        if (r.effective_date.getTime() > eff.getTime()) return false;
        if (r.end_date && r.end_date.getTime() < eff.getTime()) return false;
        return true;
      });
      candidates.sort((a, b) => b.effective_date.getTime() - a.effective_date.getTime());
      return candidates[0] ? { ...candidates[0] } : null;
    }),
  };

  const auditLog = {
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

  const client = {
    bonusPayPeriod,
    bonusEmployee,
    bonusDailyEntry,
    processorBonusRule,
    auditLog,
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
});

function actor(id: string) {
  return { actorUserId: id, ip: '127.0.0.1', userAgent: 'vitest' };
}

const TODAY = new Date(Date.UTC(2026, 5, 5)); // 2026-06-05

// ── Tests ───────────────────────────────────────────────────────

describe('resolveActiveRule', () => {
  it('returns the Woodland rule effective today (never hardcoded)', async () => {
    const { resolveActiveRule } = await import('./daily-entry');
    const rule = await resolveActiveRule(WOODLAND, TODAY);
    expect(rule.threshold_low).toBe(50);
    expect(rule.rate_low).toBe('0.5000');
    expect(rule.threshold_high).toBe(74);
  });

  it('throws NoActiveRuleError when no rule covers the date', async () => {
    const { resolveActiveRule, NoActiveRuleError } = await import('./daily-entry');
    await expect(resolveActiveRule('site-nope', TODAY)).rejects.toBeInstanceOf(NoActiveRuleError);
  });
});

describe('getDailyGrid', () => {
  it('resolves the seeded draft period and lists ACTIVE employees alphabetically', async () => {
    const { getDailyGrid } = await import('./daily-entry');
    const grid = await getDailyGrid(WOODLAND, TODAY);

    expect(grid.editable).toBe(true);
    expect(grid.monthState).toBe('draft');
    expect(grid.rows.map((r) => r.full_name)).toEqual(['Amy', 'Bob', 'Zane']);
    // Inactive Aaron + Eugene's Eve are excluded.
    expect(grid.rows.find((r) => r.full_name === 'Aaron')).toBeUndefined();
    expect(grid.rows.find((r) => r.full_name === 'Eve')).toBeUndefined();
    // No counts keyed yet.
    expect(grid.rows.every((r) => r.mattress_count === null && r.bonus_cents === 0)).toBe(true);
    expect(grid.totalCents).toBe(0);
  });

  it('pre-loads an existing entry and computes its bonus via the rule', async () => {
    const { upsertDailyEntries, getDailyGrid } = await import('./daily-entry');
    await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 74 }],
      actor('user-janette'),
    );
    const grid = await getDailyGrid(WOODLAND, TODAY);
    const amy = grid.rows.find((r) => r.full_name === 'Amy')!;
    // 74 mattresses: (74-50)*$0.50 = $12.00 = 1200 cents.
    expect(amy.mattress_count).toBe(74);
    expect(amy.bonus_cents).toBe(1200);
    expect(grid.totalCents).toBe(1200);
  });
});

describe('upsertDailyEntries — persistence + actor stamping', () => {
  it('persists entries with entered_by_user_id from the actor (Morena keys)', async () => {
    const { upsertDailyEntries } = await import('./daily-entry');
    const res = await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 60 }],
      actor('user-morena'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries[0]!.entered_by_user_id).toBe('user-morena');
    expect(res.entries[0]!.mattress_count).toBe(60);

    const audit = auditRows.find((r) => r.table_name === 'bonus_daily_entries');
    expect(audit).toBeDefined();
    expect(audit!.action).toBe('insert');
    expect(audit!.actor_user_id).toBe('user-morena');
  });

  it('Bill keying the same row re-stamps entered_by_user_id and audits as update', async () => {
    const { upsertDailyEntries } = await import('./daily-entry');
    await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 60 }],
      actor('user-morena'),
    );
    const res = await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 80 }],
      actor('user-bill'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries[0]!.entered_by_user_id).toBe('user-bill');
    expect(res.entries[0]!.mattress_count).toBe(80);

    // Audit differentiates: one insert (Morena) + one update (Bill).
    const rows = auditRows.filter((r) => r.table_name === 'bonus_daily_entries');
    expect(rows.map((r) => `${r.action}:${r.actor_user_id}`)).toEqual([
      'insert:user-morena',
      'update:user-bill',
    ]);
  });
});

describe('upsertDailyEntries — month lock (ADR-0019 §7)', () => {
  it('blocks writes once the month is not draft (409 month_locked)', async () => {
    const { getDailyGrid, upsertDailyEntries } = await import('./daily-entry');
    // Materialize the draft month, then flip it to pending_signatures.
    const grid = await getDailyGrid(WOODLAND, TODAY);
    const m = monthStore.get(grid.monthId)!;
    m.state = 'pending_signatures';

    const res = await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 60 }],
      actor('user-janette'),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('month_locked');
    // No entry persisted, no audit row written.
    expect(entryStore.size).toBe(0);
    expect(auditRows.filter((r) => r.table_name === 'bonus_daily_entries').length).toBe(0);
  });
});

describe('upsertDailyEntries — note field does not affect math', () => {
  it('same count with vs without a note yields identical bonus', async () => {
    const { upsertDailyEntries, getDailyGrid } = await import('./daily-entry');
    await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 74, note: 'covered a double shift' }],
      actor('user-janette'),
    );
    const grid = await getDailyGrid(WOODLAND, TODAY);
    const amy = grid.rows.find((r) => r.full_name === 'Amy')!;
    expect(amy.note).toBe('covered a double shift');
    expect(amy.bonus_cents).toBe(1200); // identical to the no-note 74 case above
  });
});

describe('upsertDailyEntries — validation + site scope', () => {
  it('rejects a count out of range', async () => {
    const { upsertDailyEntries } = await import('./daily-entry');
    const res = await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-amy', mattress_count: 1000 }],
      actor('user-janette'),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('count_out_of_range');
  });

  it("refuses to write another site's employee under Woodland scope", async () => {
    const { upsertDailyEntries } = await import('./daily-entry');
    const res = await upsertDailyEntries(
      WOODLAND,
      TODAY,
      [{ bonus_employee_id: 'emp-eugene', mattress_count: 60 }],
      actor('user-janette'),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('employee_not_in_site');
  });
});
