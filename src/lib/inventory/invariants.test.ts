import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

// ADR-0131 Amendment 2 — the suite speaks only for sites ONBOARDED to Loads &
// Inventory (`loads_inventory` UI surface = `live`). These tests pin the scope,
// not the arithmetic: the arithmetic is covered by the running-balance suites.

const siteFindMany = vi.fn();
const siteHolidayFindMany = vi.fn(async () => [] as unknown[]);
const snapshotFindFirst = vi.fn();
const snapshotCount = vi.fn(async () => 0);
const isUiSurfaceLive = vi.fn();
const onHand = vi.fn();
const exceptionFindFirst = vi.fn(async (): Promise<unknown> => null);

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findMany: (...a: unknown[]) => siteFindMany(...a) },
    siteHoliday: { findMany: (...a: unknown[]) => siteHolidayFindMany(...(a as [])) },
    siteInventorySnapshot: {
      findFirst: (...a: unknown[]) => snapshotFindFirst(...a),
      findMany: async () => [],
      count: (...a: unknown[]) => snapshotCount(...(a as [])),
    },
    inventoryException: { findFirst: (...a: unknown[]) => exceptionFindFirst(...(a as [])) },
  },
}));
vi.mock('@/lib/notify/rollout', async (orig) => ({
  ...(await orig<typeof import('@/lib/notify/rollout')>()),
  isUiSurfaceLive: (...a: unknown[]) => isUiSurfaceLive(...a),
}));
vi.mock('@/lib/inventory/running-balance', async (orig) => ({
  ...(await orig<typeof import('@/lib/inventory/running-balance')>()),
  onHand: (...a: unknown[]) => onHand(...a),
}));

import { INVENTORY_INVARIANTS } from './invariants';

const EUGENE = {
  id: 'site-e',
  code: 'eugene',
  max_units_indoor: null,
  max_units_total_on_site: 6000,
};
const WOODLAND = {
  id: 'site-w',
  code: 'woodland',
  max_units_indoor: 3500,
  max_units_total_on_site: null,
};

const byId = (id: string) => INVENTORY_INVARIANTS.find((i) => i.id === id)!;
const ctx = { now: new Date('2026-09-16T09:30:00Z') }; // the 02:30 PT sweep tick

/** Every inventory invariant that iterates SITES rather than rows. */
const SITE_SCOPED = [
  'INV-ANCHOR-FRESH',
  'INV-ONHAND-COMPUTABLE',
  'INV-POOL-NON-NEGATIVE',
  'INV-FLOOR-WITHIN-CAPACITY',
] as const;

function balance(program: number, nonProgram: number) {
  return {
    program: new Prisma.Decimal(program),
    nonProgram: new Prisma.Decimal(nonProgram),
    total: new Prisma.Decimal(program + nonProgram),
    anchorPool: 'measured' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  siteFindMany.mockResolvedValue([EUGENE, WOODLAND]);
  siteHolidayFindMany.mockResolvedValue([]);
  snapshotCount.mockResolvedValue(0);
  // A fresh Woodland anchor and a healthy floor: nothing here is a violation, so
  // any finding below is the SCOPE speaking, never the data.
  snapshotFindFirst.mockResolvedValue({ snapshot_at: new Date('2026-09-14T07:00:00Z') });
  onHand.mockResolvedValue(balance(128, 757));
  // Production, 2026-09-15: Woodland live, Eugene flipped back to pilot.
  isUiSurfaceLive.mockImplementation(async (_c: string, siteId: string) => siteId === 'site-w');
});

describe('a site in `pilot` is not examined at all', () => {
  it.each(SITE_SCOPED)('%s never names eugene, and counts only the live site', async (id) => {
    const out = await byId(id).check(ctx);
    expect(out.subjectsChecked).toBe(1);
    expect(JSON.stringify(out.violations)).not.toContain('eugene');
  });

  it('INV-ANCHOR-FRESH no longer reports Eugene as never-anchored', async () => {
    // The 02:30 page of 2026-09-14: "eugene: no non-voided physical count has EVER
    // been recorded". True, and about a site nobody has ever used.
    snapshotFindFirst.mockImplementation(async (args: { where: { site_id: string } }) =>
      args.where.site_id === 'site-w' ? { snapshot_at: new Date('2026-09-14T07:00:00Z') } : null,
    );
    const out = await byId('INV-ANCHOR-FRESH').check(ctx);
    expect(out.status).toBe('ok');
    expect(snapshotFindFirst).toHaveBeenCalledTimes(1);
    expect(snapshotFindFirst.mock.calls[0]![0].where.site_id).toBe('site-w');
  });
});

describe('a site flipped LIVE re-enters the suite with no code change', () => {
  it('INV-ANCHOR-FRESH demands a first count from a newly-live site', async () => {
    // The re-entry promise made in ADR-0131 Amendment 2, made falsifiable. Flip
    // Eugene live and the suite immediately asks for the count it has never had.
    isUiSurfaceLive.mockResolvedValue(true);
    snapshotFindFirst.mockImplementation(async (args: { where: { site_id: string } }) =>
      args.where.site_id === 'site-w' ? { snapshot_at: new Date('2026-09-14T07:00:00Z') } : null,
    );
    const out = await byId('INV-ANCHOR-FRESH').check(ctx);
    expect(out.status).toBe('violated');
    expect(out.subjectsChecked).toBe(2);
    expect(out.violations.map((v) => v.subject)).toEqual(['eugene']);
    expect(out.violations[0]!.detail).toContain('EVER');
  });

  it.each(SITE_SCOPED)('%s examines BOTH sites when both are live', async (id) => {
    isUiSurfaceLive.mockResolvedValue(true);
    const out = await byId(id).check(ctx);
    expect(out.subjectsChecked).toBe(2);
  });
});

describe('zero onboarded sites is indeterminate, never a green', () => {
  it.each(SITE_SCOPED)('%s refuses to report `ok` over nothing', async (id) => {
    isUiSurfaceLive.mockResolvedValue(false);
    const out = await byId(id).check(ctx);
    expect(out.status).toBe('indeterminate');
    expect(out.status).not.toBe('ok');
    expect(out.subjectsChecked).toBe(0);
    expect(out.note).toMatch(/loads_inventory/);
  });

  it.each(SITE_SCOPED)('%s issues NO database read once the scope is empty', async (id) => {
    isUiSurfaceLive.mockResolvedValue(false);
    await byId(id).check(ctx);
    expect(onHand).not.toHaveBeenCalled();
    expect(snapshotFindFirst).not.toHaveBeenCalled();
  });
});

describe('the pinned assumption says what the invariant now actually asserts', () => {
  it('INV-ANCHOR-FRESH no longer claims to speak for "every active site"', async () => {
    // ADR-0131 D3: `assumption` is what the RECORD claims. Narrowing the code and
    // leaving the sentence alone is how an invariant ends up pinning something
    // nobody wrote down.
    const inv = byId('INV-ANCHOR-FRESH');
    expect(inv.assumption).toMatch(/loads_inventory|onboard/i);
    expect(inv.assumption).not.toMatch(/Every active site/);
    expect(inv.title).toMatch(/onboarded/i);
  });
});

describe('the row-scanning invariants stay global, deliberately', () => {
  it.each(['INV-ANCHOR-POOLS-SUM', 'INV-ANCHOR-UNIQUE'])(
    '%s reads snapshot ROWS and is not site-scoped',
    async (id) => {
      // A wrong snapshot row is wrong wherever it sits, and a pilot site with a
      // stray count is exactly the case worth seeing. These never called `sites()`.
      isUiSurfaceLive.mockResolvedValue(false);
      const out = await byId(id).check(ctx);
      expect(out.status).not.toBe('indeterminate');
      expect(isUiSurfaceLive).not.toHaveBeenCalled();
    },
  );
});

// ── ADR-0143 D5 / RC4 — test T4: ONE remedy, and the exception owns the page ──
describe('INV-POOL-NON-NEGATIVE (ADR-0143)', () => {
  it('Woodland -247 with NO exception: violated, and the remedy IS the tile remedy (same function)', async () => {
    const { negativeFloorCopy } = await import('./negative-floor');
    onHand.mockResolvedValue(balance(-247, 644));
    exceptionFindFirst.mockResolvedValue(null);
    const out = await byId('INV-POOL-NON-NEGATIVE').check({
      now: ctx.now,
    }); /* fresh ctx: the balance is memoised per run */
    expect(out.status).toBe('violated');
    const detail = out.violations[0]!.detail;
    expect(detail).toContain(negativeFloorCopy({ kind: 'pool-split', pool: 'program' }).remedy);
    expect(detail).toContain('NO inventory exception recorded');
    expect(detail).not.toMatch(/do not take a new physical count/i);
  });

  it('Woodland -247 WITH an open exception: not a finding here (the exception pages), named in the note', async () => {
    onHand.mockResolvedValue(balance(-247, 644));
    exceptionFindFirst.mockResolvedValue({
      id: 'ex-12345678-aaaa',
      first_negative_day: new Date('2026-09-17T00:00:00Z'),
    });
    const out = await byId('INV-POOL-NON-NEGATIVE').check({
      now: ctx.now,
    }); /* fresh ctx: the balance is memoised per run */
    expect(out.status).toBe('ok');
    expect(out.subjectsChecked).toBe(1);
    expect(out.note).toContain(
      'woodland program: inventory exception ex-12345 open since 2026-09-17',
    );
  });

  it('the static remedy no longer contradicts the screen (RC4)', () => {
    const inv = byId('INV-POOL-NON-NEGATIVE');
    expect(inv.remedy).not.toMatch(/do not take a new physical count/i);
    expect(inv.remedy).toContain('negativeFloorCopy().remedy');
  });
});
