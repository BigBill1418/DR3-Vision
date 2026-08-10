// ADR-0042 §7-b (amended 2026-07-18) — the June-2026-Woodland acceptance fixture:
// the pre-filled inventory MUST reproduce the CORRECTED close 3,977 (3,748 program
// + 229 non-program). ADR-0037's amendment corrected the buggy 4,062 (the workbook
// grid double-counted DAY23's NP row); this fixture is updated to the corrected
// number and now cross-validates the D6 running balance (`onHand`) against the
// §2.3 workbook close (`computeInventoryClose`) using the SAME authoritative
// Processed-ledger totals. Plus headcount-pre-fill provenance + month-boundary math.
//
// FIXTURE MATH (documented per the ADR): the pre-filled inventory is the ONE
// pool-aware running balance (ADR-0037 D6) as of the cover month's last day —
//   End = Start + Inbound + Dropoffs − Stripped − WholeUnitsSold − Landfilled
// We reproduce the corrected June by anchoring a PHYSICAL snapshot at the month
// open (the Processed!D5 program opening) and letting June's Processed-ledger
// totals net to the pool state:
//
//   anchor (2026-06-01, program open, D5):        1423
//   + verified inbound program (Processed!F40):  +19451
//   + verified inbound non-program (G40):        +  229  → non-program pool
//   + consumer drop-offs (CIP pool):             +    0
//   − stripped program (Processed!D40):          −17126
//   − stripped non-program (E40):                −    0
//   − whole units sold / landfilled:             −    0
//   ────────────────────────────────────────────────────
//   program = 1423 + 19451 − 17126 = 3748 ; non-program = 229 ; TOTAL = 3977
//
// The DB adapter is exercised through mocked prisma aggregates that stand in for
// "June's post-anchor flow" — identical style to running-balance.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import type { InventorySource, HeadcountSource } from './prefill';

const D = (n: number | string) => new Prisma.Decimal(n);

interface Agg {
  _sum: Record<string, number | Prisma.Decimal | null>;
}

/** One payroll row, in the shape the arg-honouring `groupBy` mock filters on. */
interface BonusEntryRow {
  siteId: string;
  employeeId: string;
  entryDate: Date;
}

const store = {
  anchor: null as null | Record<string, unknown>,
  inbound: { program_unit_count: 0, non_program_unit_count: 0 } as Record<string, number | null>,
  dropoffs: { units: 0 } as Record<string, number | null>,
  stripped: { stripped_program: D(0), stripped_non_program: D(0) } as Record<
    string,
    Prisma.Decimal | null
  >,
  wholeUnitsSold: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  landfilled: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  closes: [] as Record<string, unknown>[],
  signer: null as null | { signer_name: string; signer_title: string },
  // PR #196 §2.3 gate — newest DELIVERED haul docking date. null = empty mirror
  // (bootstrap, not stale) so the pre-gate fixtures run unchanged.
  newestDelivered: null as Date | null,
  // ADR-0076 follow-up — the payroll source behind the headcount pre-fill.
  bonusEntries: [] as BonusEntryRow[],
  /** Non-null makes `bonusDailyEntry.groupBy` REJECT — the uncomputable case. */
  bonusSourceError: null as Error | null,
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: { findFirst: async () => store.anchor },
    inboundLoad: { aggregate: async (): Promise<Agg> => ({ _sum: store.inbound }) },
    consumerDropoff: { aggregate: async (): Promise<Agg> => ({ _sum: store.dropoffs }) },
    processedUnitsDaily: {
      aggregate: async (): Promise<Agg> => ({ _sum: store.stripped }),
      findMany: async () => store.closes,
    },
    outboundMaterial: { aggregate: async (): Promise<Agg> => ({ _sum: store.wholeUnitsSold }) },
    landfilledUnit: { aggregate: async (): Promise<Agg> => ({ _sum: store.landfilled }) },
    corSiteConfig: { findUnique: async () => store.signer },
    // ADR-0076 follow-up — this mock HONOURS its arguments on purpose.
    //
    // It filters on BOTH `where.bonus_employee.site_id` and `where.entry_date`, and it
    // groups by the keys actually requested in `by`. That matters three ways:
    //   • a month-scoping regression (wrong window, or dropping `entry_date`) changes
    //     the returned count instead of passing by mock fiat — see the boundary test;
    //   • a site-scoping regression leaks the other site's processors into the count;
    //   • grouping by `(employee, date)` instead of `(employee)` would count ENTRIES
    //     rather than PEOPLE, and the multi-day processor in the fixture turns that red.
    // A mock that ignored `where` would make all three untestable.
    bonusDailyEntry: {
      groupBy: async ({
        by,
        where,
      }: {
        by: string[];
        where: {
          bonus_employee?: { site_id?: string };
          entry_date?: { gte: Date; lte: Date };
        };
      }): Promise<{ bonus_employee_id: string }[]> => {
        if (store.bonusSourceError) throw store.bonusSourceError;
        const siteId = where.bonus_employee?.site_id;
        const ed = where.entry_date;
        const matched = store.bonusEntries.filter(
          (r) =>
            (siteId === undefined || r.siteId === siteId) &&
            (ed === undefined ||
              (r.entryDate.getTime() >= ed.gte.getTime() &&
                r.entryDate.getTime() <= ed.lte.getTime())),
        );
        const keyOf = (r: BonusEntryRow) =>
          by
            .map((k) => (k === 'bonus_employee_id' ? r.employeeId : String(r.entryDate.getTime())))
            .join('|');
        const groups = new Set(matched.map(keyOf));
        return [...groups].map((k) => ({ bonus_employee_id: k.split('|')[0]! }));
      },
    },
    // ADR-0089 D3 — the freshness measure is a raw max(COALESCE(...)) query.
    $queryRaw: async () => [{ newest: store.newestDelivered }],
  },
}));

import { computeCorPrefill, coverMonthBounds } from './prefill';

/** UTC-midnight `@db.Date` day key — the entry_date convention for this table. */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/**
 * June-2026 Woodland payroll fixture — 20 DISTINCT processors, which is the figure
 * measured against the production database for woodland 2026-06.
 *
 * Deliberately shaped so the count is falsifiable rather than incidental:
 *   • p01 works 2026-06-01 → the INCLUSIVE lower month boundary
 *   • p20 works 2026-06-30 → the INCLUSIVE upper month boundary
 *   • p02 works three separate days → a PEOPLE count must not become an ENTRY count
 *   • `p-may` / `p-jul` sit one day either side of the cover month, and `e01` is at
 *     another site — none of the three may be counted
 */
function juneWoodlandPayroll(): BonusEntryRow[] {
  const rows: BonusEntryRow[] = [
    { siteId: 'site-woodland', employeeId: 'p01', entryDate: day('2026-06-01') },
    { siteId: 'site-woodland', employeeId: 'p02', entryDate: day('2026-06-02') },
    { siteId: 'site-woodland', employeeId: 'p02', entryDate: day('2026-06-03') },
    { siteId: 'site-woodland', employeeId: 'p02', entryDate: day('2026-06-04') },
    { siteId: 'site-woodland', employeeId: 'p20', entryDate: day('2026-06-30') },
  ];
  // p03..p19 — seventeen more distinct processors mid-month → 20 distinct in total.
  for (let i = 3; i <= 19; i++) {
    rows.push({
      siteId: 'site-woodland',
      employeeId: `p${String(i).padStart(2, '0')}`,
      entryDate: day('2026-06-15'),
    });
  }
  rows.push({ siteId: 'site-woodland', employeeId: 'p-may', entryDate: day('2026-05-31') });
  rows.push({ siteId: 'site-woodland', employeeId: 'p-jul', entryDate: day('2026-07-01') });
  rows.push({ siteId: 'site-eugene', employeeId: 'e01', entryDate: day('2026-06-15') });
  return rows;
}

// Root reset — runs BEFORE every nested `beforeEach`, so the payroll store never
// leaks between describe blocks (each one declares the payroll state it needs).
beforeEach(() => {
  store.bonusEntries = [];
  store.bonusSourceError = null;
});

describe('coverMonthBounds', () => {
  it('bounds June 2026 to [2026-06-01 .. 2026-06-30] with an end-of-day asOf', () => {
    const b = coverMonthBounds('2026-06-01');
    expect(b.monthStart.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(b.monthEndDate.toISOString().slice(0, 10)).toBe('2026-06-30');
    expect(b.monthEndAsOf.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('handles a 31-day month and a leap February', () => {
    expect(coverMonthBounds('2026-07-01').monthEndDate.toISOString().slice(0, 10)).toBe(
      '2026-07-31',
    );
    expect(coverMonthBounds('2024-02-01').monthEndDate.toISOString().slice(0, 10)).toBe(
      '2024-02-29',
    );
  });
});

describe('computeCorPrefill — June 2026 Woodland acceptance fixture (§7-b)', () => {
  beforeEach(() => {
    store.anchor = {
      id: 'snap-june-anchor',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 1423, // Processed!D5 program opening = DAY1!L2
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 19451, non_program_unit_count: 229 }; // F40 / G40
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D('17126.0'), stripped_non_program: D('0.0') }; // D40 / E40
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
    store.closes = [
      {
        id: 'close-06-15',
        production_date: new Date('2026-06-15T00:00:00Z'),
        employees_count: 16,
        processors_count: 13,
      },
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: 15,
        processors_count: 12,
      },
    ];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
    store.bonusEntries = juneWoodlandPayroll();
  });

  it('reproduces inventory_units == 3977 (3748 program + 229 non-program)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.inventorySource as InventorySource;
    expect(p.inventoryUnits).toBe(3977);
    expect(src.computedTotal).toBe('3977');
    expect(src.computedProgram).toBe('3748');
    expect(src.computedNonProgram).toBe('229');
  });

  it('records the anchor snapshot id + reconcile delta + asOf in inventory_source', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.inventorySource as InventorySource;
    expect(src.anchorSnapshotId).toBe('snap-june-anchor');
    expect(src.anchorPhysicalUnits).toBe(1423);
    expect(src.anchorReconciledDelta).toBe(0);
    expect(src.asOf).toBe('2026-06-30T23:59:59.999Z');
    expect(src.storedUnits).toBe(3977);
  });

  it('pre-fills processors from the PAYROLL source (20), not the close row (12)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.headcountSource as HeadcountSource;
    // 20 = the measured distinct-processor count for woodland 2026-06. The month-end
    // close row in this fixture says 12; if 12 comes back, the pre-fill regressed onto
    // `processed_units_daily.processors_count` — the column that is NULL in production
    // and made every COR headcount cell render "—".
    expect(src.processorsCount).toBe(20);
    // The close record is retained verbatim so the provenance still shows what the
    // close rows said (and therefore why the old path yielded nothing in production).
    expect(src.monthEndCloseId).toBe('close-06-30');
    expect(src.monthEndDate).toBe('2026-06-30');
    expect(src.consultedCloseRowIds).toEqual(['close-06-15', 'close-06-30']);
    expect(src.series).toHaveLength(2);
    expect(src.series.map((s) => s.processorsCount)).toEqual([13, 12]);
  });

  it('names the derivation honestly and records the window it counted over', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.headcountSource as HeadcountSource;
    // A figure that no longer comes from the daily close must not keep claiming it
    // does. Red here means the provenance label is lying about its own source.
    expect(src.method).toBe('bonus_distinct_processors_adr0076');
    expect(src.processorsWindowStart).toBe('2026-06-01');
    expect(src.processorsWindowEnd).toBe('2026-06-30');
    expect(src.processorsCountUnavailableReason).toBeNull();
  });

  it('resolves the signer from config (D2.3)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('falls back to the seeded default signer when no config row exists', async () => {
    store.signer = null;
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('still pre-fills processors when the month has NO daily-close rows at all', async () => {
    // Production reality this reproduces: `processed_units_daily` has zero Eugene rows
    // (ADR-0076). Under the old close-derived path that site could never pre-fill a
    // headcount at all. The payroll source does not depend on the close table.
    store.closes = [];
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    const src = p.headcountSource as HeadcountSource;
    expect(src.processorsCount).toBe(20);
    expect(src.monthEndCloseId).toBeNull();
    expect(src.employeesCount).toBeNull();
    expect(src.consultedCloseRowIds).toEqual([]);
    // Inventory still computes independently.
    expect(p.inventoryUnits).toBe(3977);
  });
});

describe('computeCorPrefill — mid-month filing (ADR-0042 amendment)', () => {
  beforeEach(() => {
    // A mid-month pre-fill must NOT read the balance/close ledger at all. Poison the
    // store so that any accidental balance/close query would produce a WRONG number
    // — the mid-month path must ignore it entirely.
    store.anchor = {
      id: 'snap-should-not-be-read',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 999999,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 999999, non_program_unit_count: 999999 };
    // Poison the payroll source too — a mid-month filing must not read it either.
    // If the mid-month branch ever grew a headcount, this rejection would surface it.
    store.bonusSourceError = new Error('payroll source must not be read on a mid-month filing');
    store.closes = [
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: 15,
        processors_count: 12,
      },
    ];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
  });

  it('files inventory + headcount BLANK and never computes a figure', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.period).toBe('mid_month');
    expect(p.inventoryUnits).toBeNull();
    expect(p.inventorySource).toEqual({
      method: 'mid_month_blank_adr0042_amendment',
      note: expect.stringContaining('inventory is filed blank'),
    });
    expect(p.headcountSource).toEqual({
      method: 'mid_month_blank_adr0042_amendment',
      note: expect.stringContaining('FT/PT headcount is filed blank'),
    });
  });

  it('still resolves the signer (the mid-month form is signed by hand)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });

  it('falls back to the seeded default signer when no config row exists', async () => {
    store.signer = null;
    const p = await computeCorPrefill('site-woodland', '2026-06-01', 'mid_month');
    expect(p.signerName).toBe('Rick Albritton');
    expect(p.signerTitle).toBe('Transportation Manager');
  });
});

// ── ADR-0076 follow-up (OPEN-ITEMS 0.AG F-1) — the headcount pre-fill ──────
// The COR month-end headcount rendered "—" on every certificate because it read
// `processed_units_daily.employees_count` / `.processors_count`: measured in
// production, 989 rows, ZERO non-null in either column, never written by any of their
// four write paths. The processor figure now derives from the payroll source. These
// tests exist to keep the honest-absence contract from eroding into a fake zero.

describe('computeCorPrefill — headcount from the payroll source (ADR-0076 follow-up)', () => {
  beforeEach(() => {
    // A clean, freshly-passing inventory state: the gates are not what is under test
    // here, and they must stay satisfied so the headcount assertions are reachable.
    store.anchor = {
      id: 'snap-june-anchor',
      snapshot_at: new Date('2026-06-01T00:00:00Z'),
      units_indoor: 1000,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 0, non_program_unit_count: 0 };
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D('0.0'), stripped_non_program: D('0.0') };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
    store.newestDelivered = null;
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
    // Production shape: close rows exist but BOTH count columns are NULL.
    store.closes = [
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: null,
        processors_count: null,
      },
    ];
    store.bonusEntries = juneWoodlandPayroll();
  });

  // ── (a) a month with entries yields the REAL distinct count ──────────────
  it('counts 20 distinct woodland processors for 2026-06 (people, not entries)', async () => {
    const src = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;
    // 22 payroll rows are in range for this site/month, from 20 distinct people (p02
    // worked three days). A red reading 22 means the count degraded from PEOPLE to
    // ENTRIES; a red reading 21 means the other site's processor leaked in.
    expect(src.processorsCount).toBe(20);
  });

  it('scopes to the site — eugene 2026-06 is 1, not woodland 20', async () => {
    const src = (await computeCorPrefill('site-eugene', '2026-06-01'))
      .headcountSource as HeadcountSource;
    expect(src.processorsCount).toBe(1);
  });

  // ── (b) NOT-RECORDED vs ZERO — the whole point of the change ─────────────
  it('keeps a real 0 (source read, month empty) distinct from null (source unreadable)', async () => {
    store.bonusEntries = [];
    const emptyMonth = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;

    store.bonusSourceError = new Error('payroll source unreachable');
    const unreadable = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;

    // Asserted together so a collapse in EITHER direction produces a red diff that
    // names which case holds the wrong value:
    //   • `emptyMonth: null` → a genuine zero got downgraded to "—" (understates a
    //     real, provable measurement on a filed document);
    //   • `unreadable: 0`    → an absent value got fabricated as a zero (asserts a
    //     false fact about the world on a filed document — the worse failure).
    expect({
      emptyMonth: emptyMonth.processorsCount,
      emptyMonthReason: emptyMonth.processorsCountUnavailableReason,
      unreadable: unreadable.processorsCount,
      unreadableReason: unreadable.processorsCountUnavailableReason,
    }).toEqual({
      emptyMonth: 0,
      emptyMonthReason: null,
      unreadable: null,
      unreadableReason: 'payroll_source_unavailable',
    });
  });

  it('an unreadable payroll source does not take the inventory figure down with it', async () => {
    // Degrading the headcount must not degrade — or silently drop — the rest of the
    // pre-fill. The inventory figure is independently provable and still filed.
    store.bonusSourceError = new Error('payroll source unreachable');
    const p = await computeCorPrefill('site-woodland', '2026-06-01');
    expect(p.inventoryUnits).toBe(1000);
    expect((p.headcountSource as HeadcountSource).processorsCount).toBeNull();
  });

  // ── (c) the cover month boundary is respected ────────────────────────────
  it('excludes an entry one day OUTSIDE the cover month (both edges)', async () => {
    // `p-may` (2026-05-31) and `p-jul` (2026-07-01) are in the fixture and are the
    // only two woodland processors outside June. Widening the window by a single day
    // in either direction turns 20 into 21 — so a red naming 21 or 22 is the window
    // having slipped, not a fixture accident.
    const june = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;
    expect(june.processorsCount).toBe(20);

    // The neighbouring months see exactly the excluded people and nobody else, which
    // proves the rows are present and merely out of June's window (not absent).
    store.closes = [];
    const may = (await computeCorPrefill('site-woodland', '2026-05-01'))
      .headcountSource as HeadcountSource;
    const july = (await computeCorPrefill('site-woodland', '2026-07-01'))
      .headcountSource as HeadcountSource;
    expect({ may: may.processorsCount, july: july.processorsCount }).toEqual({ may: 1, july: 1 });
  });

  it('INCLUDES both boundary days — the first and last of the cover month', async () => {
    // p01 works 06-01 and p20 works 06-30. An exclusive bound at either edge drops one
    // of them, so the red reads 19 and the assertion below names which edge by count.
    store.bonusEntries = [
      { siteId: 'site-woodland', employeeId: 'p01', entryDate: day('2026-06-01') },
      { siteId: 'site-woodland', employeeId: 'p20', entryDate: day('2026-06-30') },
    ];
    const src = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;
    expect(src.processorsCount).toBe(2);
  });

  // ── (d) employeesCount is NOT backfilled from the processor count ────────
  it('leaves employeesCount NULL and never substitutes the processor count', async () => {
    // Production shape: the close row exists, its employees_count is NULL, and 20
    // processors worked. `employeesCount: 20` here would be a fabricated FT/PT
    // compliance figure on a filed document — bonus entries cover processors only,
    // which is a different population from the FT/PT total.
    const src = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;
    expect({ employeesCount: src.employeesCount, processorsCount: src.processorsCount }).toEqual({
      employeesCount: null,
      processorsCount: 20,
    });
  });

  it('surfaces a REAL employeesCount when the close column is actually written', async () => {
    // The FT/PT total is not derivable from payroll, so it stays close-derived. If the
    // column is ever populated, the pre-fill must carry that real value through rather
    // than hard-coding null — "not recorded" has to remain a measurement, not a stub.
    store.closes = [
      {
        id: 'close-06-30',
        production_date: new Date('2026-06-30T00:00:00Z'),
        employees_count: 31,
        processors_count: null,
      },
    ];
    const src = (await computeCorPrefill('site-woodland', '2026-06-01'))
      .headcountSource as HeadcountSource;
    expect(src.employeesCount).toBe(31);
  });
});

// ── PR #196 §2.3 — the COR stale-feed / negative-ledger block ──────────────
// The 2026-07 incident is the acceptance fixture: delivered hauls frozen at
// 2026-07-21 while Confirmed rows are future-dated. Prefill must REFUSE, not
// render a confident wrong figure onto a regulatory filing.

describe('computeCorPrefill — inbound-freshness + negative-ledger gate (PR #196 §2.3)', () => {
  beforeEach(() => {
    store.anchor = {
      id: 'snap-july-anchor',
      snapshot_at: new Date('2026-07-22T07:00:00Z'),
      units_indoor: 1597,
      units_total: null,
      units_in_processing: 0,
      reconciled_delta: 0,
    };
    store.inbound = { program_unit_count: 150, non_program_unit_count: 0 };
    store.dropoffs = { units: 0 };
    store.stripped = { stripped_program: D('8034.0'), stripped_non_program: D('0.0') };
    store.wholeUnitsSold = { program_units: 0, non_program_units: 0 };
    store.landfilled = { program_units: 0, non_program_units: 0 };
    store.closes = [];
    store.signer = { signer_name: 'Rick Albritton', signer_title: 'Transportation Manager' };
    // Incident state: newest DELIVERED haul frozen 12+ days before the filing.
    store.newestDelivered = new Date('2026-07-21T12:00:00Z');
  });

  it('REFUSES an end-of-month prefill while the delivered-hauls feed is stale (the incident)', async () => {
    await expect(computeCorPrefill('site-woodland', '2026-07-01')).rejects.toMatchObject({
      name: 'CorInboundStaleError',
      status: 409,
      context: { newest: '2026-07-21' },
    });
  });

  it('mid-month prefill is untouched by the gate (files inventory blank)', async () => {
    const p = await computeCorPrefill('site-woodland', '2026-07-01', 'mid_month');
    expect(p.inventoryUnits).toBeNull();
  });

  it('REFUSES a NEGATIVE balance even when the feed reads fresh (one-sided ledger)', async () => {
    // Feed fresh (delivered today relative to wall clock) but the ledger is
    // one-sided: 1597 + 150 − 8034 = −6287 (the measured 2026-08-03 program pool).
    store.newestDelivered = new Date();
    await expect(computeCorPrefill('site-woodland', '2026-07-01')).rejects.toMatchObject({
      name: 'CorLedgerNegativeError',
      status: 422,
      context: { totalUnits: -6287 },
    });
  });

  it('passes when the feed is fresh and the balance is positive', async () => {
    store.newestDelivered = new Date();
    store.stripped = { stripped_program: D('100.0'), stripped_non_program: D('0.0') };
    const p = await computeCorPrefill('site-woodland', '2026-07-01');
    expect(p.inventoryUnits).toBe(1597 + 150 - 100);
  });

  // ADR-0076 follow-up — the headcount degradation is a settle-to-object wrapper
  // scoped to ONE query. It must never become an escape hatch for these gates.
  it('an unreadable payroll source does NOT swallow the stale-feed refusal', async () => {
    store.bonusSourceError = new Error('payroll source unreachable');
    await expect(computeCorPrefill('site-woodland', '2026-07-01')).rejects.toMatchObject({
      name: 'CorInboundStaleError',
      status: 409,
    });
  });

  it('an unreadable payroll source does NOT swallow the negative-ledger refusal', async () => {
    store.newestDelivered = new Date();
    store.bonusSourceError = new Error('payroll source unreachable');
    await expect(computeCorPrefill('site-woodland', '2026-07-01')).rejects.toMatchObject({
      name: 'CorLedgerNegativeError',
      status: 422,
      context: { totalUnits: -6287 },
    });
  });

  it('an EMPTY mirror is bootstrap, not stale — prefill proceeds (reconcile tripwire still governs)', async () => {
    store.newestDelivered = null;
    store.stripped = { stripped_program: D('0.0'), stripped_non_program: D('0.0') };
    const p = await computeCorPrefill('site-woodland', '2026-07-01');
    expect(p.inventoryUnits).toBe(1597 + 150);
  });
});
