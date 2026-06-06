// ADR-0019 §8 — Annual CSV export route: gate + download (T-118).
//
// Stands up the GET handler in-process with mocked auth + Prisma. Verifies:
//   - anonymous                              → 401
//   - operator                               → 403
//   - Eugene manager (Rick, primary=Eugene)  → 403
//   - Woodland manager (Janette)             → 200, CSV attachment with the right
//                                              columns + Content-Disposition

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

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const THIS_YEAR = new Date().getUTCFullYear();

interface MockMonth {
  id: string;
  site_id: string;
  period_start: Date;
}
interface MockEmployee {
  id: string;
  site_id: string;
  full_name: string;
  previous_names: unknown;
  is_active: boolean;
}
interface MockEntry {
  bonus_employee_id: string;
  bonus_pay_period_id: string;
  mattress_count: number;
}

const monthStore = new Map<string, MockMonth>();
const empStore = new Map<string, MockEmployee>();
const entries: MockEntry[] = [];

function inList(where: Record<string, unknown>, key: string, value: string): boolean {
  if (!(key in where)) return true;
  const w = where[key] as unknown;
  if (typeof w === 'string') return value === w;
  if (w && typeof w === 'object' && 'in' in (w as Record<string, unknown>)) {
    return (w as { in: string[] }).in.includes(value);
  }
  return true;
}

vi.mock('@/lib/prisma', () => {
  const site = {
    findUnique: vi.fn(async () => ({ id: WOODLAND, code: 'woodland', name: 'Woodland' })),
  };
  const bonusPayPeriod = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...monthStore.values()]
        .filter((m) => !('site_id' in where) || m.site_id === where['site_id'])
        .filter((m) => {
          if (!('period_start' in where)) return true;
          const range = where['period_start'] as { gte?: Date; lt?: Date };
          if (range.gte && m.period_start.getTime() < range.gte.getTime()) return false;
          if (range.lt && m.period_start.getTime() >= range.lt.getTime()) return false;
          return true;
        })
        .map((m) => ({ ...m }));
    }),
  };
  const bonusEmployee = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return [...empStore.values()]
        .filter((e) => inList(where, 'id', e.id))
        .filter((e) => !('site_id' in where) || e.site_id === where['site_id'])
        .map((e) => ({ ...e }));
    }),
  };
  const bonusDailyEntry = {
    findMany: vi.fn(async ({ where = {} }: { where?: Record<string, unknown> } = {}) => {
      return entries
        .filter((e) => inList(where, 'bonus_pay_period_id', e.bonus_pay_period_id))
        .map((e) => ({ ...e }));
    }),
  };
  const processorBonusRule = {
    findFirst: vi.fn(async () => ({
      id: 'rule-wo',
      site_id: WOODLAND,
      threshold_low: 50,
      rate_low: { toString: () => '0.5000' },
      threshold_high: 74,
      rate_high: { toString: () => '0.2500' },
      effective_date: new Date(Date.UTC(2000, 0, 1)),
      end_date: null,
    })),
  };
  return { prisma: { site, bonusPayPeriod, bonusEmployee, bonusDailyEntry, processorBonusRule } };
});

import { GET } from '@/app/api/bonus/annual/export/route';

function req(year = THIS_YEAR): Request {
  return new Request(`https://x/api/bonus/annual/export?year=${year}`);
}

beforeEach(() => {
  mockSession = null;
  monthStore.clear();
  empStore.clear();
  entries.length = 0;
});

function seed(): void {
  const may: MockMonth = {
    id: 'm-may',
    site_id: WOODLAND,
    period_start: new Date(Date.UTC(THIS_YEAR, 4, 1)),
  };
  monthStore.set(may.id, may);
  empStore.set('emp-amy', {
    id: 'emp-amy',
    site_id: WOODLAND,
    full_name: 'Amy',
    previous_names: null,
    is_active: true,
  });
  entries.push({ bonus_employee_id: 'emp-amy', bonus_pay_period_id: 'm-may', mattress_count: 60 });
}

describe('GET /api/bonus/annual/export', () => {
  it('401 for anonymous', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('403 for operator', async () => {
    mockSession = { user: { id: 'u-op', role: 'operator' } };
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('403 for the Eugene manager (Rick)', async () => {
    mockSession = { user: { id: 'u-rick', role: 'manager', primary_site_id: EUGENE } };
    const res = await GET(req());
    expect(res.status).toBe(403);
  });

  it('200 CSV attachment for the Woodland manager', async () => {
    seed();
    mockSession = { user: { id: 'u-jan', role: 'manager', primary_site_id: WOODLAND } };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="bonus-woodland-annual-${THIS_YEAR}.csv"`,
    );
    const body = await res.text();
    const lines = body.trim().split('\n');
    expect(lines[0]).toBe(
      'employee,previously_known_as,active,total_mattresses,days_qualified,total_bonus_usd',
    );
    // Amy keyed 60 mattresses → bonus = (60-50)*50 = 500 cents = $5.00.
    expect(lines[1]).toBe('Amy,,yes,60,1,5.00');
  });
});
