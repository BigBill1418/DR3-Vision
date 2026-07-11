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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';

// T-330: mattress_count is Decimal(5,1) — Prisma returns a Decimal on read. The
// mock store mirrors that so the data layer's `.toNumber()` boundary works.
type Dec = Prisma.Decimal;
const toDec = (n: number): Dec => new Prisma.Decimal(n);

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
  period_start: Date;
  period_end: Date;
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
  bonus_pay_period_id: string;
  entry_date: Date;
  mattress_count: Dec;
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
  // T-203: periods are PRE-SEEDED (no auto-create). Seed Period 12 of 2026 for
  // Woodland (Tue May 26 → Mon Jun 8), the window covering every date these tests
  // exercise (Jun 1 / Jun 5). The daily-entry layer resolves THIS row by range.
  monthStore.set('p12', {
    id: 'p12',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(2026, 4, 26)),
    period_end: new Date(Date.UTC(2026, 5, 8)),
    state: 'draft',
  });
}

// 2026-07-11 — the on-save late-report hook is a fail-soft side effect; mock it
// to a spy so route tests stay deterministic and we can assert it fires on a
// successful save (the real behavior is unit-tested in daily-report-late.test.ts).
const maybeSendLateDailyReport = vi.fn<(...a: unknown[]) => Promise<string>>(
  async () => 'not_late',
);
vi.mock('@/lib/bonus/daily-report-late', () => ({
  maybeSendLateDailyReport: (...a: unknown[]) => maybeSendLateDailyReport(...a),
}));

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
    // T-203: daily-entry now resolves the SEEDED period by date-range (no create).
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
        // The Decimal(5,1) column coerces a written number to a Decimal (T-330).
        const coerce = (d: Partial<MockEntry>): Partial<MockEntry> =>
          'mattress_count' in d && typeof d.mattress_count === 'number'
            ? { ...d, mattress_count: toDec(d.mattress_count as unknown as number) }
            : d;
        const existing = entryStore.get(key);
        if (existing) {
          Object.assign(existing, coerce(update));
          return { ...existing };
        }
        const row: MockEntry = {
          id: `entry-${++idCounter}`,
          ...(coerce(create as Partial<MockEntry>) as Omit<MockEntry, 'id'>),
        };
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
  // ADR-0028: the route resolves the amendment approver's DISPLAY NAME on a
  // `requires_amendment` 409. The chain row makes Morena (ops) the counterpart
  // of Janette (facility) at Woodland; the user row supplies the display name.
  const bonusSignatureChain = {
    findUnique: vi.fn(async ({ where }: { where: { site_id: string } }) => {
      if (where.site_id !== WOODLAND) return null;
      return {
        facility_signer_user_id: 'janette',
        facility_override_actor_ids: '',
        ops_signer_user_id: 'morena',
        ops_override_actor_ids: '',
        auto_override_actor_user_id: 'bill',
      };
    }),
  };
  const userStore = new Map<string, { id: string; name: string }>([
    ['morena', { id: 'morena', name: 'Morena Ruiz' }],
    ['janette', { id: 'janette', name: 'Janette Cole' }],
  ]);
  const user = {
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) => userStore.get(where.id) ?? null,
    ),
  };
  const client = {
    bonusPayPeriod,
    bonusEmployee,
    bonusDailyEntry,
    processorBonusRule,
    site,
    auditLog,
    bonusSignatureChain,
    user,
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

function makeReq(body: unknown): Request {
  return new Request('http://x/api/bonus/entries', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const TODAY_ISO = '2026-06-05';

// Pin the clock so the route's appToday() (America/Los_Angeles) deterministically
// equals TODAY_ISO no matter when the suite runs. 2026-06-05T18:00:00Z = 11:00 AM
// PDT on 2026-06-05. Without this, route.ts's admin/back-date gate compares the
// posted TODAY_ISO against the REAL Pacific day and rejects it (403) once the wall
// clock rolls past 2026-06-05 — the time-bomb that turned these tests red on 6/6.
// The admin-back-dating describe re-pins to its own boundary instant (same Pacific
// day), so this outer hook is harmless there.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-05T18:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

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

  it('403 for Rick (Eugene mgr) requesting Woodland — site isolation', async () => {
    // ADR-0019.2: Rick has bonus access (Eugene) but not Woodland; ?site=woodland
    // is denied at the gate.
    const { POST } = await import('./route');
    mockSession = { user: { id: 'rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await POST(
      new Request('http://x/api/bonus/entries?site=woodland', {
        method: 'POST',
        body: JSON.stringify({ entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 1 }] }),
        headers: { 'Content-Type': 'application/json' },
      }),
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
    expect(maybeSendLateDailyReport).toHaveBeenCalledTimes(1);
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

describe('POST /api/bonus/entries — period lock', () => {
  it('returns 409 once the covering period is not draft', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    // Make the SEEDED period covering TODAY_ISO non-draft (a `skipped` period
    // would lock entries the same way — both are outside EDITABLE_STATES).
    monthStore.set('p12', {
      id: 'p12',
      site_id: WOODLAND,
      period_start: new Date(Date.UTC(2026, 4, 26)),
      period_end: new Date(Date.UTC(2026, 5, 8)),
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

  it('returns 409 (skipped period) — a skipped period blocks daily-entry writes', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    monthStore.set('p12', {
      id: 'p12',
      site_id: WOODLAND,
      period_start: new Date(Date.UTC(2026, 4, 26)),
      period_end: new Date(Date.UTC(2026, 5, 8)),
      state: 'skipped',
    });
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 5 }],
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { state?: string };
    expect(body.state).toBe('skipped');
    expect(entryStore.size).toBe(0);
  });

  it('returns 409 when no seeded period covers the date', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    monthStore.clear(); // no period covers any date
    const res = await POST(
      makeReq({
        entry_date: '2026-06-05',
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 5 }],
      }),
    );
    expect(res.status).toBe(409);
    expect(entryStore.size).toBe(0);
  });
});

// ── Admin-only back-dating + Pacific "today" default (TZ fix, 2026-06-06) ──
//
// FIX 2: only an admin may record against a day other than Pacific "today".
// FIX 1: an omitted entry_date must default to the PACIFIC calendar day of the
// run instant, never the server's UTC day. We pin the clock to the canonical
// boundary instant — 10:50 PM PDT on 2026-06-05 == 2026-06-06T05:50:00Z — so a
// UTC-derived default would (wrongly) be 2026-06-06. The entry-key the data
// layer writes is asserted to be the 2026-06-05 @db.Date.

describe('POST /api/bonus/entries — admin back-dating + Pacific default', () => {
  // 10:50 PM PDT Jun 5 == 05:50 UTC Jun 6 (the exact bug Bill hit).
  const BUG_INSTANT = new Date('2026-06-06T05:50:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BUG_INSTANT);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('non-admin manager (Janette) prior-day insert ROUTES TO AMENDMENT (409), not a direct write (ADR-0028)', async () => {
    // Pre-ADR-0028 this was a hard 403 ("entries may only be recorded for
    // today"). ADR-0028 relaxes the gate: a non-admin's prior-day change in a
    // draft period routes through the four-eyes amendment workflow. With no
    // existing entry the change is an INSERT amendment. Nothing is written
    // directly — the amendment must be approved first.
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: '2026-06-01', // prior day, in draft Period 12
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 10 }],
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      pending: Array<{ change_type: string }>;
    };
    expect(body.error).toBe('requires_amendment');
    expect(body.pending[0]!.change_type).toBe('insert');
    // Nothing was written directly — the amendment is not applied here.
    expect(entryStore.size).toBe(0);
  });

  it('admin (Bill) MAY back-date and the entry persists', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(
      makeReq({
        entry_date: '2026-06-01',
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 12 }],
      }),
    );
    expect(res.status).toBe(200);
    // Persisted against the back-dated calendar day, not today.
    expect(entryStore.has(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 1))))).toBe(true);
  });

  it('non-admin posting TODAY (Pacific) is allowed', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: '2026-06-05', // Pacific today at the pinned instant
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 8 }],
      }),
    );
    expect(res.status).toBe(200);
  });

  it('omitted entry_date defaults to the PACIFIC day (2026-06-05), not the UTC day (2026-06-06)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({ entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 9 }] }),
    );
    expect(res.status).toBe(200);
    // The write landed on the Pacific calendar day...
    expect(entryStore.has(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 5))))).toBe(true);
    // ...and NOT on the UTC day (the old bug).
    expect(entryStore.has(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 6))))).toBe(false);
  });
});

// ── ADR-0028 amendment routing (non-admin prior-day) ────────────
//
// The pre-ADR-0028 gate hard-403'd any non-admin non-today date. ADR-0028
// relaxes it: a non-admin may submit for a PRIOR day, which the data layer
// routes through the four-eyes amendment workflow (409 `requires_amendment`)
// rather than writing directly. FUTURE dates still 403. Admin keeps the direct
// back-date path. These run under the outer clock pin (Pacific 2026-06-05), so
// 2026-06-01 is a prior day inside draft Period 12.

describe('POST /api/bonus/entries — ADR-0028 amendment routing', () => {
  it('non-admin (Janette) prior day in draft → 409 requires_amendment with approverName, no write', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    // Seed an existing prior-day entry so the change is an UPDATE (count change).
    entryStore.set(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 1))), {
      id: 'entry-seed',
      bonus_employee_id: 'emp-amy',
      bonus_pay_period_id: 'p12',
      entry_date: new Date(Date.UTC(2026, 5, 1)),
      mattress_count: toDec(40),
      note: null,
      entered_by_user_id: 'janette',
    });
    const res = await POST(
      makeReq({
        entry_date: '2026-06-01', // prior day, in the draft period
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 55 }],
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      monthId: string;
      approverName: string | null;
      pending: Array<{
        bonus_employee_id: string;
        change_type: string;
        existing: { mattress_count: number } | null;
        proposed: { mattress_count: number };
      }>;
    };
    expect(body.error).toBe('requires_amendment');
    expect(body.monthId).toBe('p12');
    // Janette is the facility signer → counterpart approver is Morena (ops).
    expect(body.approverName).toBe('Morena Ruiz');
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]!.change_type).toBe('update');
    expect(body.pending[0]!.bonus_employee_id).toBe('emp-amy');
    expect(body.pending[0]!.existing?.mattress_count).toBe(40);
    expect(body.pending[0]!.proposed.mattress_count).toBe(55);
    // The original entry is UNTOUCHED — the amendment is not applied here.
    const stored = entryStore.get(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 1))));
    expect(stored?.mattress_count.toNumber()).toBe(40);
  });

  it('non-admin (Janette) FUTURE date → 403 (not amendment)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: '2026-06-30', // future relative to pinned Pacific 2026-06-05
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 10 }],
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/future/i);
    expect(entryStore.size).toBe(0);
  });

  it('admin (Bill) prior date → direct write (NOT amendment)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'bill', role: 'admin', primary_site_id: null } };
    const res = await POST(
      makeReq({
        entry_date: '2026-06-01', // prior day — admin back-dates directly
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 33 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ mattress_count: number }> };
    expect(body.entries[0]!.mattress_count).toBe(33);
    // Direct write landed on the prior calendar day.
    expect(entryStore.has(entryKey('emp-amy', new Date(Date.UTC(2026, 5, 1))))).toBe(true);
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

  // T-330 — one-decimal-place contract at the API boundary.
  it('200 on a one-decimal count (23.5) — persisted verbatim', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 23.5 }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ mattress_count: number }> };
    expect(body.entries[0]!.mattress_count).toBe(23.5);
  });

  it('422 on a two-decimal-place count (23.55)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: 23.55 }],
      }),
    );
    expect(res.status).toBe(422);
  });

  it('422 on a negative count (-3)', async () => {
    const { POST } = await import('./route');
    mockSession = { user: { id: 'janette', role: 'manager', primary_site_id: WOODLAND } };
    const res = await POST(
      makeReq({
        entry_date: TODAY_ISO,
        entries: [{ bonus_employee_id: 'emp-amy', mattress_count: -3 }],
      }),
    );
    expect(res.status).toBe(422);
  });
});
