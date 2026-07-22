// ADR-0037 Phase 4 (spec §4) — EOD inventory snapshot tests.
//
// The three states the spec names are the load-bearing behavior: HEALTHY (fresh
// `measured` anchor → figures), STALE (missing/legacy/old anchor → warning band,
// NEVER figures presented as fact), ZERO (pre-backfill, empty tables → graceful).
//
// `onHand` is mocked (it is separately and exhaustively tested in
// running-balance.test.ts) so these tests drive the gate, the delta, the split,
// and the anchor-age math — not the inventory equation, which this module
// deliberately does not re-implement.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const D = Prisma.Decimal;

interface AnchorRow {
  id: string;
  snapshot_at: Date;
  pool_attribution: string;
}

const store = {
  anchor: null as AnchorRow | null,
  audit: null as null | { actor_label: string | null; actor: { name: string } | null },
  // Balance by asOf epoch — the module reads end-of-report-day and end-of-prior-day.
  balances: new Map<number, { program: number; nonProgram: number }>(),
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: {
      findFirst: async ({ where }: { where: { snapshot_at: { lte: Date } } }) => {
        if (!store.anchor) return null;
        return store.anchor.snapshot_at.getTime() <= where.snapshot_at.lte.getTime()
          ? { ...store.anchor }
          : null;
      },
    },
    auditLog: {
      findFirst: async () => store.audit,
    },
  },
}));

vi.mock('@/lib/inventory/running-balance', () => ({
  onHand: async (_siteId: string, asOf: Date) => {
    const b = store.balances.get(asOf.getTime()) ?? { program: 0, nonProgram: 0 };
    const program = new D(b.program);
    const nonProgram = new D(b.nonProgram);
    return { program, nonProgram, total: program.plus(nonProgram) };
  },
}));

import {
  getEodInventorySnapshot,
  classifyEodInventory,
  eodInventoryStaleDays,
  endOfReportDay,
  daysSinceAnchor,
  DEFAULT_EOD_INVENTORY_STALE_DAYS,
} from '@/lib/loads/eod-inventory';

const SITE = 'site-woodland';
const REPORT_DATE = new Date(Date.UTC(2026, 6, 22)); // 2026-07-22 @db.Date key
const END_TODAY = endOfReportDay(REPORT_DATE).getTime();
const END_YESTERDAY = endOfReportDay(new Date(REPORT_DATE.getTime() - 86_400_000)).getTime();

/** A count taken at 10:00 PT on the given Pacific calendar day. */
function countedAt(y: number, m1: number, d: number): Date {
  return new Date(Date.UTC(y, m1 - 1, d, 17, 0, 0)); // 17:00Z = 10:00 PDT
}

beforeEach(() => {
  store.anchor = null;
  store.audit = null;
  store.balances = new Map();
  delete process.env['EOD_INVENTORY_STALE_DAYS'];
});

describe('eodInventoryStaleDays', () => {
  it('defaults to 14 and honours a valid override', () => {
    expect(eodInventoryStaleDays({})).toBe(DEFAULT_EOD_INVENTORY_STALE_DAYS);
    expect(DEFAULT_EOD_INVENTORY_STALE_DAYS).toBe(14);
    expect(eodInventoryStaleDays({ EOD_INVENTORY_STALE_DAYS: '3' })).toBe(3);
  });

  it('falls back to the default on junk rather than widening the window', () => {
    for (const raw of ['', '  ', 'soon', '0', '-5', '7.5', 'Infinity']) {
      expect(eodInventoryStaleDays({ EOD_INVENTORY_STALE_DAYS: raw })).toBe(
        DEFAULT_EOD_INVENTORY_STALE_DAYS,
      );
    }
  });
});

describe('daysSinceAnchor', () => {
  it('counts whole Pacific calendar days to the report day', () => {
    expect(daysSinceAnchor(countedAt(2026, 7, 22), REPORT_DATE)).toBe(0);
    expect(daysSinceAnchor(countedAt(2026, 7, 21), REPORT_DATE)).toBe(1);
    expect(daysSinceAnchor(countedAt(2026, 6, 30), REPORT_DATE)).toBe(22);
  });

  it('reads a `${date}T00:00:00Z` day-key snapshot_at as its own count day (the API write shape)', () => {
    // The manager API writes snapshot_at as `${countedAt}T00:00:00Z` — a @db.Date key,
    // NOT a true instant. A same-day count is 0 days ago; it must NOT be re-shifted back a
    // Pacific day (which read as "1 day ago" and tripped the stale band a day early). Finding 4.
    expect(daysSinceAnchor(new Date('2026-07-22T00:00:00Z'), REPORT_DATE)).toBe(0);
    expect(daysSinceAnchor(new Date('2026-07-21T00:00:00Z'), REPORT_DATE)).toBe(1);
    expect(daysSinceAnchor(new Date('2026-06-30T00:00:00Z'), REPORT_DATE)).toBe(22);
  });
});

describe('classifyEodInventory (the freshness gate)', () => {
  const base = { totalOnHand: 100, priorTotal: 90, staleDays: 14 };

  it('is healthy only for a measured anchor inside the window', () => {
    expect(
      classifyEodInventory({ ...base, anchor: { poolAttribution: 'measured', daysSince: 0 } }),
    ).toBe('healthy');
    expect(
      classifyEodInventory({ ...base, anchor: { poolAttribution: 'measured', daysSince: 14 } }),
    ).toBe('healthy');
  });

  it('is stale one day past the window, and for a legacy (unsplit) anchor', () => {
    expect(
      classifyEodInventory({ ...base, anchor: { poolAttribution: 'measured', daysSince: 15 } }),
    ).toBe('stale');
    expect(
      classifyEodInventory({ ...base, anchor: { poolAttribution: 'legacy', daysSince: 0 } }),
    ).toBe('stale');
  });

  it('is stale (not zero) when there is movement but no anchor at all', () => {
    expect(classifyEodInventory({ ...base, anchor: null })).toBe('stale');
  });

  it('is zero only when there is no anchor and no movement either day', () => {
    expect(
      classifyEodInventory({ anchor: null, totalOnHand: 0, priorTotal: 0, staleDays: 14 }),
    ).toBe('zero');
  });
});

describe('getEodInventorySnapshot', () => {
  it('HEALTHY — figures, delta, split, count date and counter', async () => {
    store.anchor = {
      id: 'snap-1',
      snapshot_at: countedAt(2026, 7, 22),
      pool_attribution: 'measured',
    };
    store.audit = { actor_label: null, actor: { name: 'Morena' } };
    store.balances.set(END_TODAY, { program: 3748, nonProgram: 229 });
    store.balances.set(END_YESTERDAY, { program: 3870, nonProgram: 249 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);

    expect(eod.state).toBe('healthy');
    expect(eod.programOnHand).toBe(3748);
    expect(eod.nonProgramOnHand).toBe(229);
    expect(eod.totalOnHand).toBe(3977);
    expect(eod.deltaFromYesterday).toBe(-142);
    expect(eod.programDelta).toBe(-122);
    expect(eod.nonProgramDelta).toBe(-20);
    expect(eod.programPct).toBe(94.2);
    expect(eod.nonProgramPct).toBe(5.8);
    expect(eod.anchor?.daysSince).toBe(0);
    expect(eod.anchor?.counter).toBe('Morena');
    expect(eod.staleDays).toBe(14);
  });

  it('HEALTHY — a same-day count stored as `${date}T00:00:00Z` reads as 0 days, not stale', async () => {
    // Regression (finding 4): the manager API writes snapshot_at at UTC midnight of the
    // count day. It must age from its own day (0), not one Pacific day earlier (which
    // read as 1-day-ago and tripped the stale band a day early at the window boundary).
    store.anchor = {
      id: 'snap-apishape',
      snapshot_at: new Date('2026-07-22T00:00:00Z'),
      pool_attribution: 'measured',
    };
    store.balances.set(END_TODAY, { program: 3748, nonProgram: 229 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('healthy');
    expect(eod.anchor?.daysSince).toBe(0);
  });

  it('HEALTHY — falls back to the audit actor_label when no user is attached', async () => {
    store.anchor = {
      id: 'snap-1',
      snapshot_at: countedAt(2026, 7, 20),
      pool_attribution: 'measured',
    };
    store.audit = { actor_label: 'system:inventory-reconcile', actor: null };
    store.balances.set(END_TODAY, { program: 10, nonProgram: 0 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('healthy');
    expect(eod.anchor?.counter).toBe('system:inventory-reconcile');
  });

  it('STALE — anchor older than the window keeps its date + age and refuses healthy', async () => {
    store.anchor = {
      id: 'snap-old',
      snapshot_at: countedAt(2026, 6, 30),
      pool_attribution: 'measured',
    };
    store.balances.set(END_TODAY, { program: 3748, nonProgram: 229 });
    store.balances.set(END_YESTERDAY, { program: 3870, nonProgram: 249 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('stale');
    expect(eod.anchor?.daysSince).toBe(22);
    expect(eod.anchor?.countedAt).toEqual(countedAt(2026, 6, 30));
  });

  it('STALE — a configured shorter window tightens the gate', async () => {
    process.env['EOD_INVENTORY_STALE_DAYS'] = '2';
    store.anchor = {
      id: 'snap-3d',
      snapshot_at: countedAt(2026, 7, 19),
      pool_attribution: 'measured',
    };
    store.balances.set(END_TODAY, { program: 100, nonProgram: 0 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('stale');
    expect(eod.staleDays).toBe(2);
  });

  it('STALE — an anchor dated AFTER the report day is not visible to it', async () => {
    store.anchor = {
      id: 'snap-future',
      snapshot_at: countedAt(2026, 7, 25),
      pool_attribution: 'measured',
    };
    store.balances.set(END_TODAY, { program: 500, nonProgram: 0 });

    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('stale');
    expect(eod.anchor).toBeNull();
  });

  it('ZERO — empty operational tables render gracefully, no anchor, no delta', async () => {
    const eod = await getEodInventorySnapshot(SITE, REPORT_DATE);
    expect(eod.state).toBe('zero');
    expect(eod.totalOnHand).toBe(0);
    expect(eod.deltaFromYesterday).toBe(0);
    expect(eod.programPct).toBeNull();
    expect(eod.nonProgramPct).toBeNull();
    expect(eod.anchor).toBeNull();
  });
});
