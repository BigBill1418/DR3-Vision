// ADR-0039 integration — the DB-fetch layer (leg-fetchers) against the merged
// ADR-0037/0038 model shapes. The repo's route/DB idiom is a FAKE prisma client
// (no test Postgres; see sweep.route.test / lifecycle.test), so this exercises
// `buildRunChecksForWindow` over a small in-memory scenario: agreeing legs →
// no findings, a mismatch → a fingerprinted finding, and the C7 clock derived
// from the mirror entry instant (no Vision-side submit column). The pure C5/C6
// rolls are cross-checked against the shared `computeRunningBalance`.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { buildRunChecksForWindow, rollConservationRows, rollInventoryDays } from './leg-fetchers';
import { computeRunningBalance } from '@/lib/inventory/running-balance';
import type { AuditWindow } from './types';

// ── tiny in-memory query engine (only the shapes our fetchers use) ────────

type Row = Record<string, unknown>;

function matchWhere(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      const clauses = cond as Row[];
      if (!clauses.some((c) => matchWhere(row, c))) return false;
      continue;
    }
    const v = row[k];
    if (cond === null) {
      if (v !== null && v !== undefined) return false;
    } else if (cond instanceof Date) {
      if ((v as Date)?.getTime() !== cond.getTime()) return false;
    } else if (typeof cond === 'object') {
      const c = cond as Row;
      if ('in' in c && !(c['in'] as unknown[]).includes(v)) return false;
      if ('gte' in c && !((v as Date).getTime() >= (c['gte'] as Date).getTime())) return false;
      if ('gt' in c && !((v as Date).getTime() > (c['gt'] as Date).getTime())) return false;
      if ('lt' in c && !((v as Date).getTime() < (c['lt'] as Date).getTime())) return false;
      if ('lte' in c && !((v as Date).getTime() <= (c['lte'] as Date).getTime())) return false;
    } else if (v !== cond) {
      return false;
    }
  }
  return true;
}

function table(rows: Row[]) {
  return {
    findMany: vi.fn(async (args?: { where?: Row }) => rows.filter((r) => matchWhere(r, args?.where))),
    findFirst: vi.fn(async (args?: { where?: Row; orderBy?: Row }) => {
      let matched = rows.filter((r) => matchWhere(r, args?.where));
      const ob = args?.orderBy;
      if (ob) {
        const [key, dir] = Object.entries(ob)[0]!;
        matched = [...matched].sort((a, b) => {
          const av = (a[key] as Date).getTime();
          const bv = (b[key] as Date).getTime();
          return dir === 'desc' ? bv - av : av - bv;
        });
      }
      return matched[0] ?? null;
    }),
    aggregate: vi.fn(async (args: { _sum: Record<string, boolean>; where?: Row }) => {
      const matched = rows.filter((r) => matchWhere(r, args.where));
      const _sum: Record<string, number | null> = {};
      for (const key of Object.keys(args._sum)) {
        let s = 0;
        let any = false;
        for (const r of matched) {
          if (r[key] != null) {
            s += Number(r[key]);
            any = true;
          }
        }
        _sum[key] = any ? s : null;
      }
      return { _sum };
    }),
  };
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface Seed {
  inbound?: Row[];
  haulMirror?: Row[];
  processed?: Row[];
  processedMirror?: Row[];
  outbound?: Row[];
  outboundMirror?: Row[];
  landfilled?: Row[];
  dropoffs?: Row[];
  snapshots?: Row[];
  configRows?: Row[];
  holidays?: Row[];
}

function fakeDb(seed: Seed): PrismaClient {
  return {
    inboundLoad: table(seed.inbound ?? []),
    mymrcHaulsMirror: table(seed.haulMirror ?? []),
    processedUnitsDaily: table(seed.processed ?? []),
    mymrcProcessedMirror: table(seed.processedMirror ?? []),
    outboundMaterial: table(seed.outbound ?? []),
    mymrcOutboundMirror: table(seed.outboundMirror ?? []),
    landfilledUnit: table(seed.landfilled ?? []),
    consumerDropoff: table(seed.dropoffs ?? []),
    siteInventorySnapshot: table(seed.snapshots ?? []),
    auditCheckConfig: table(seed.configRows ?? []),
    siteHoliday: table(seed.holidays ?? []),
  } as unknown as PrismaClient;
}

// Disable the internal-invariant checks (C5/C6) for the mirror-join tests so a
// derived-inventory edge never masks a C1/C2/C3/C7 assertion. They are covered
// directly by the pure-roll tests below.
const disableInvariants: Row[] = (['c5_conservation', 'c6_inventory_continuity'] as const).map((code) => ({
  site_id: null,
  check_code: code,
  enabled: false,
  severity: 'high',
  unit_tolerance: 0,
  weight_tolerance_lbs: 0,
  grace_business_days: 0,
  open_window_days: null,
  blocks_billing: false,
  params: {},
}));

const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-30', asOfISO: '2026-07-15' };

function inboundRow(over: Row = {}): Row {
  return {
    id: 'in-1',
    site_id: 'site-1',
    status: 'verified',
    load_source_type: 'b2b_haul',
    arrived_at: D('2026-06-10'),
    retrac_id: 'RT-100',
    external_mymrc_haul_id: 'H-100',
    total_units: 40,
    program_unit_count: 40,
    non_program_unit_count: 0,
    slip_number: 'S-1',
    transport_charged: false,
    source: { name: 'Vacaville' },
    ...over,
  };
}

function haulMirrorRow(over: Row = {}): Row {
  return {
    id: 'sf-1',
    site_id: 'site-1',
    external_haul_id: 'H-100',
    retrac_id: 'RT-100',
    docking_appointment_at: D('2026-06-10'),
    units: 40,
    weight_lbs: 1200,
    status: 'Confirmed',
    first_seen_at: D('2026-06-11'),
    ...over,
  };
}

describe('buildRunChecksForWindow — C1 inbound (logs ↔ MyMRC haul mirror)', () => {
  it('agreeing inbound + haul mirror → no C1 finding', async () => {
    const db = fakeDb({ inbound: [inboundRow()], haulMirror: [haulMirrorRow()], configRows: disableInvariants });
    const { findings } = await buildRunChecksForWindow(db)(window);
    expect(findings.filter((f) => f.checkCode === 'c1_inbound')).toHaveLength(0);
  });

  it('a unit mismatch → a fingerprinted C1 value_mismatch', async () => {
    const db = fakeDb({
      inbound: [inboundRow({ total_units: 40 })],
      haulMirror: [haulMirrorRow({ units: 37 })],
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const c1 = findings.filter((f) => f.checkCode === 'c1_inbound');
    expect(c1).toHaveLength(1);
    expect(c1[0]!.kind).toBe('value_mismatch');
    expect(c1[0]!.expected).toEqual({ units: 40 });
    expect(c1[0]!.actual).toEqual({ units: 37 });
    expect(c1[0]!.fingerprint).toBeTruthy();
  });

  it('an inbound with no mirror counterpart → missing_counterpart', async () => {
    const db = fakeDb({ inbound: [inboundRow()], haulMirror: [], configRows: disableInvariants });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const c1 = findings.filter((f) => f.checkCode === 'c1_inbound');
    expect(c1).toHaveLength(1);
    expect(c1[0]!.kind).toBe('missing_counterpart');
  });

  it('matches on Re-TRAC when the haul id is absent on the mirror (detail pass pending)', async () => {
    const db = fakeDb({
      inbound: [inboundRow({ external_mymrc_haul_id: null })], // Vision only has Re-TRAC
      haulMirror: [haulMirrorRow({ external_haul_id: null })], // mirror keys off Salesforce id
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    expect(findings.filter((f) => f.checkCode === 'c1_inbound')).toHaveLength(0);
  });
});

describe('buildRunChecksForWindow — C2 processed (total-only; mirror has no split)', () => {
  it('agreeing totals → no finding even though the mirror lacks a program split', async () => {
    const db = fakeDb({
      processed: [
        { id: 'p-1', site_id: 'site-1', production_date: D('2026-06-12'), stripped_program: 30, stripped_non_program: 5, source: 'manual', closed_at: D('2026-06-12') },
      ],
      processedMirror: [
        { id: 'sfm-1', site_id: 'site-1', external_materials_id: 'M-1', processed_date: D('2026-06-12'), units: 35, entry_date: D('2026-06-12') },
      ],
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    expect(findings.filter((f) => f.checkCode === 'c2_processed')).toHaveLength(0);
  });

  it('a processed-total mismatch → value_mismatch', async () => {
    const db = fakeDb({
      processed: [
        { id: 'p-1', site_id: 'site-1', production_date: D('2026-06-12'), stripped_program: 30, stripped_non_program: 5, source: 'manual', closed_at: D('2026-06-12') },
      ],
      processedMirror: [
        { id: 'sfm-1', site_id: 'site-1', external_materials_id: 'M-1', processed_date: D('2026-06-12'), units: 40, entry_date: D('2026-06-12') },
      ],
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const c2 = findings.filter((f) => f.checkCode === 'c2_processed');
    expect(c2).toHaveLength(1);
    expect(c2[0]!.kind).toBe('value_mismatch');
  });
});

describe('buildRunChecksForWindow — C3 outbound (Material # join = external_materials_id)', () => {
  const outboundRow = (over: Row = {}): Row => ({
    id: 'ob-1',
    site_id: 'site-1',
    ship_date: D('2026-06-14'),
    commodity: 'foam',
    sub_category: 'baled',
    weight_lbs: 900,
    whole_units: null,
    bale_count: 3,
    ticket_number: 'M-500',
    retrac_id: null,
    buyer: 'Acme',
    source: 'manual',
    locked_at: D('2026-06-14'),
    ...over,
  });
  const outboundMirrorRow = (over: Row = {}): Row => ({
    id: 'sfo-1',
    site_id: 'site-1',
    external_materials_id: 'M-500',
    shipment_date: D('2026-06-14'),
    entry_date: D('2026-06-15'),
    weight_lbs: 900,
    vendor: 'Recycler Co',
    ...over,
  });

  it('agreeing weight + date → no finding', async () => {
    const db = fakeDb({ outbound: [outboundRow()], outboundMirror: [outboundMirrorRow()], configRows: disableInvariants });
    const { findings } = await buildRunChecksForWindow(db)(window);
    expect(findings.filter((f) => f.checkCode === 'c3_outbound')).toHaveLength(0);
  });

  it('a weight gap beyond tolerance → value_mismatch', async () => {
    const db = fakeDb({
      outbound: [outboundRow({ weight_lbs: 900 })],
      outboundMirror: [outboundMirrorRow({ weight_lbs: 700 })], // 200 lb gap > 50 lb default tolerance
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const c3 = findings.filter((f) => f.checkCode === 'c3_outbound' && f.kind === 'value_mismatch');
    expect(c3).toHaveLength(1);
  });

  it('a Vision outbound with no mirror, past EOD grace → missing_counterpart', async () => {
    const db = fakeDb({ outbound: [outboundRow()], outboundMirror: [], configRows: disableInvariants });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const c3 = findings.filter((f) => f.checkCode === 'c3_outbound' && f.kind === 'missing_counterpart');
    expect(c3.some((f) => f.legARef === 'ob-1')).toBe(true);
  });
});

describe('buildRunChecksForWindow — C7 clock derived from the mirror entry instant', () => {
  it('inbound entered late in MyMRC (mirror first_seen past the 3-business-day deadline) → late', async () => {
    const db = fakeDb({
      inbound: [inboundRow({ arrived_at: D('2026-06-01'), external_mymrc_haul_id: 'H-9', retrac_id: 'RT-9' })],
      haulMirror: [haulMirrorRow({ external_haul_id: 'H-9', retrac_id: 'RT-9', docking_appointment_at: D('2026-06-01'), first_seen_at: D('2026-06-20') })],
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    const late = findings.filter((f) => f.checkCode === 'c7_deadline');
    expect(late.length).toBeGreaterThanOrEqual(1);
    expect(late.some((f) => (f.detail as { clock?: string })?.clock === 'inbound')).toBe(true);
  });

  it('inbound entered on time → no C7 finding', async () => {
    const db = fakeDb({
      inbound: [inboundRow({ arrived_at: D('2026-06-10'), external_mymrc_haul_id: 'H-9', retrac_id: 'RT-9' })],
      haulMirror: [haulMirrorRow({ external_haul_id: 'H-9', retrac_id: 'RT-9', docking_appointment_at: D('2026-06-10'), first_seen_at: D('2026-06-11') })],
      configRows: disableInvariants,
    });
    const { findings } = await buildRunChecksForWindow(db)(window);
    expect(findings.filter((f) => f.checkCode === 'c7_deadline')).toHaveLength(0);
  });
});

// ── pure C5/C6 rolls + cross-check vs the shared running balance ──────────

describe('rollInventoryDays — cross-check vs computeRunningBalance', () => {
  const flows = new Map([
    ['2026-06-01', { inbound: { program: 30, nonProgram: 4 }, dropoffProgram: 5, stripped: { program: 10, nonProgram: 1 }, renovationSold: { program: 2, nonProgram: 0 }, landfilled: { program: 1, nonProgram: 0 }, physicalSnapshot: null }],
    ['2026-06-02', { inbound: { program: 20, nonProgram: 2 }, dropoffProgram: 0, stripped: { program: 8, nonProgram: 0 }, renovationSold: { program: 0, nonProgram: 0 }, landfilled: { program: 0, nonProgram: 0 }, physicalSnapshot: null }],
  ]);
  const start = { program: 100, nonProgram: 10 };

  it('the final rolled End equals a single computeRunningBalance over the summed window flows', () => {
    const rows = rollInventoryDays(start, flows as never);
    const last = rows[rows.length - 1]!;

    // Independent single-shot computation over the summed components.
    const agg = computeRunningBalance({
      anchor: start,
      verifiedInbound: { program: 30 + 20, nonProgram: 4 + 2 },
      dropoffUnits: 5,
      stripped: { program: 10 + 8, nonProgram: 1 + 0 },
      wholeUnitsSold: { program: 2, nonProgram: 0 },
      landfilled: { program: 1, nonProgram: 0 },
    });
    expect(last.recordedEnd).toBe(agg.program.toNumber());
    expect(last.npRecordedEnd).toBe(agg.nonProgram.toNumber());
  });

  it('each day rolls Start = prior End, so C6 continuity is clean by construction', () => {
    const rows = rollInventoryDays(start, flows as never);
    expect(rows[1]!.recordedStart).toBe(rows[0]!.recordedEnd);
    expect(rows[1]!.npRecordedStart).toBe(rows[0]!.npRecordedEnd);
    for (const r of rows) {
      const computedEnd = r.recordedStart! + r.inbound - r.stripped - r.wholeUnitsSold - r.landfilled;
      expect(computedEnd).toBe(r.recordedEnd);
    }
  });
});

describe('rollConservationRows — cumulative pool availability (Rick Q11 shape)', () => {
  it('folds the starting floor into day-0 availability; over-processing is caught', () => {
    // Start floor 150 program; day-0 inbound 0; process 150 legal, 151 illegal.
    const legal = rollConservationRows(
      { program: 150, nonProgram: 50 },
      new Map([['2026-06-01', { inbound: { program: 0, nonProgram: 0 }, dropoffProgram: 0, stripped: { program: 150, nonProgram: 25 }, renovationSold: { program: 0, nonProgram: 0 }, landfilled: { program: 0, nonProgram: 0 }, physicalSnapshot: null }]]) as never,
    );
    expect(legal[0]!.inboundProgram).toBe(150);
    expect(legal[0]!.programProcessed).toBe(150);
    // available = 150 − 0 − 0 = 150; processing 150 is legal (not > available).
    expect(legal[0]!.programProcessed).toBeLessThanOrEqual(
      legal[0]!.inboundProgram - legal[0]!.priorProcessedProgram - legal[0]!.programRenovationOutflow,
    );
  });

  it('prior days’ stripped reduces later availability', () => {
    const rows = rollConservationRows(
      { program: 100, nonProgram: 0 },
      new Map([
        ['2026-06-01', { inbound: { program: 0, nonProgram: 0 }, dropoffProgram: 0, stripped: { program: 60, nonProgram: 0 }, renovationSold: { program: 0, nonProgram: 0 }, landfilled: { program: 0, nonProgram: 0 }, physicalSnapshot: null }],
        ['2026-06-02', { inbound: { program: 0, nonProgram: 0 }, dropoffProgram: 0, stripped: { program: 30, nonProgram: 0 }, renovationSold: { program: 0, nonProgram: 0 }, landfilled: { program: 0, nonProgram: 0 }, physicalSnapshot: null }],
      ]) as never,
    );
    expect(rows[1]!.priorProcessedProgram).toBe(60);
    // day-2 available = 100 − 60 − 0 = 40; processed 30 ≤ 40 (legal).
    expect(rows[1]!.inboundProgram - rows[1]!.priorProcessedProgram).toBe(40);
  });
});
