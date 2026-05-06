// Tests for the compliance metric collectors. Coverage is targeted at
// the two metrics newly wired off `pending`:
//
//   - metric #2 (Processed-units submission) — reads `processing_sessions`
//   - metric #4 (Recycling rate)              — reads `mymrc_reconciliations`
//                                                + `mymrc_reconciliation_items`
//
// Both metrics share the same shape as their already-wired peers (#1, #3,
// #5, #6, #7), so the contract under test is:
//   1. empty corpus → green-by-convention with caption that tells the
//      truth (no contract violation when no observations exist).
//   2. on-time / late grading buckets correctly via `bucketForPctMetric`
//      (green ≥ threshold, yellow within 5pp, red below threshold-5pp).
//   3. period scoping (queries match the dashboard window).
//
// Prisma is mocked at module-boundary so the tests stay deterministic
// + isolated from any database state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const processingFindManyMock = vi.fn();
const reconciliationFindManyMock = vi.fn();
const reconciliationItemFindManyMock = vi.fn();
const inboundLoadFindManyMock = vi.fn();
const inboundLoadAggregateMock = vi.fn();
const inboundLoadFindFirstMock = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    processingSession: {
      findMany: (...args: unknown[]) => processingFindManyMock(...args),
    },
    mymrcReconciliation: {
      findMany: (...args: unknown[]) => reconciliationFindManyMock(...args),
    },
    mymrcReconciliationItem: {
      findMany: (...args: unknown[]) => reconciliationItemFindManyMock(...args),
    },
    inboundLoad: {
      findMany: (...args: unknown[]) => inboundLoadFindManyMock(...args),
      aggregate: (...args: unknown[]) => inboundLoadAggregateMock(...args),
      findFirst: (...args: unknown[]) => inboundLoadFindFirstMock(...args),
    },
  },
}));

import { collectMetrics, type MetricInput } from './compliance';

const PERIOD_START = new Date('2026-04-01T00:00:00Z');
const PERIOD_END = new Date('2026-05-01T00:00:00Z');

function makeInput(overrides: Partial<MetricInput> = {}): MetricInput {
  return {
    siteId: 'site-eugene',
    siteCode: 'eugene',
    site: {
      recycling_rate_target_pct: 70 as unknown as MetricInput['site']['recycling_rate_target_pct'],
      reconciliation_target_pct: 97 as unknown as MetricInput['site']['reconciliation_target_pct'],
      records_retention_years: 5,
      mymrc_inbound_submission_business_days: 3,
      mymrc_processed_submission_business_days: 1,
      dock_sla_minutes: 60,
      inbound_processing_deadline_days: 30,
      max_units_indoor: 0,
      max_units_outdoor: 0,
      max_units_total_on_site: 6000,
    },
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    holidays: [],
    ...overrides,
  };
}

beforeEach(() => {
  processingFindManyMock.mockReset();
  reconciliationFindManyMock.mockReset();
  reconciliationItemFindManyMock.mockReset();
  inboundLoadFindManyMock.mockReset();
  inboundLoadAggregateMock.mockReset();
  inboundLoadFindFirstMock.mockReset();

  // Defaults for the metrics not under test in a given case — empty
  // corpus → green-by-convention. Tests that need otherwise override
  // these per-case via mockResolvedValueOnce.
  processingFindManyMock.mockResolvedValue([]);
  reconciliationFindManyMock.mockResolvedValue([]);
  reconciliationItemFindManyMock.mockResolvedValue([]);
  inboundLoadFindManyMock.mockResolvedValue([]);
  inboundLoadAggregateMock.mockResolvedValue({ _sum: { total_units: 0 } });
  inboundLoadFindFirstMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('metric #2 — Processed-units submission', () => {
  it('renders green with caption when no sessions are in scope', async () => {
    const slate = await collectMetrics(makeInput());
    expect(slate.processedUnits.bucket).toBe('green');
    expect(slate.processedUnits.value).toBe(100);
    expect(slate.processedUnits.threshold).toBe(95);
    expect(slate.processedUnits.rowCount).toBe(0);
    expect(slate.processedUnits.caption).toMatch(/0 sessions in scope/);
  });

  it('grades green when ≥95% are on time', async () => {
    // 19/20 on time, 1 late → 95%. Boundary: green per the rubric.
    const sessions = [];
    for (let i = 0; i < 19; i++) {
      sessions.push({
        session_date: new Date('2026-04-10T00:00:00Z'),
        // Submitted same day — well within the 1-business-day deadline.
        submitted_to_mymrc_at: new Date('2026-04-10T08:00:00Z'),
      });
    }
    sessions.push({
      session_date: new Date('2026-04-10T00:00:00Z'),
      // Submitted 5 business days later — late.
      submitted_to_mymrc_at: new Date('2026-04-17T00:00:00Z'),
    });
    processingFindManyMock.mockResolvedValueOnce(sessions);

    const slate = await collectMetrics(makeInput());
    expect(slate.processedUnits.bucket).toBe('green');
    expect(slate.processedUnits.value).toBe(95);
    expect(slate.processedUnits.rowCount).toBe(20);
  });

  it('grades yellow when within 5pp of threshold', async () => {
    // 18/20 = 90% — yellow band (threshold-5pp..threshold).
    const sessions = [];
    for (let i = 0; i < 18; i++) {
      sessions.push({
        session_date: new Date('2026-04-10T00:00:00Z'),
        submitted_to_mymrc_at: new Date('2026-04-10T08:00:00Z'),
      });
    }
    for (let i = 0; i < 2; i++) {
      sessions.push({
        session_date: new Date('2026-04-10T00:00:00Z'),
        submitted_to_mymrc_at: new Date('2026-04-17T00:00:00Z'),
      });
    }
    processingFindManyMock.mockResolvedValueOnce(sessions);

    const slate = await collectMetrics(makeInput());
    expect(slate.processedUnits.bucket).toBe('yellow');
    expect(slate.processedUnits.value).toBe(90);
  });

  it('grades red when below threshold-5pp', async () => {
    // 16/20 = 80% — red.
    const sessions = [];
    for (let i = 0; i < 16; i++) {
      sessions.push({
        session_date: new Date('2026-04-10T00:00:00Z'),
        submitted_to_mymrc_at: new Date('2026-04-10T08:00:00Z'),
      });
    }
    for (let i = 0; i < 4; i++) {
      sessions.push({
        session_date: new Date('2026-04-10T00:00:00Z'),
        submitted_to_mymrc_at: new Date('2026-04-17T00:00:00Z'),
      });
    }
    processingFindManyMock.mockResolvedValueOnce(sessions);

    const slate = await collectMetrics(makeInput());
    expect(slate.processedUnits.bucket).toBe('red');
    expect(slate.processedUnits.value).toBe(80);
  });

  it('queries `processing_sessions` scoped by site + period window', async () => {
    await collectMetrics(makeInput());
    const call = processingFindManyMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect((call as { where: { site_id: string } }).where.site_id).toBe('site-eugene');
    expect(
      (call as { where: { session_date: { gte: Date; lt: Date } } }).where.session_date.gte,
    ).toEqual(PERIOD_START);
    expect(
      (call as { where: { session_date: { gte: Date; lt: Date } } }).where.session_date.lt,
    ).toEqual(PERIOD_END);
  });

  it('click-through deep-links to the load list with the period preserved', async () => {
    const slate = await collectMetrics(makeInput());
    expect(slate.processedUnits.clickThroughHref).toContain('/dashboard/eugene/loads');
    expect(slate.processedUnits.clickThroughHref).toContain('range=custom');
    expect(slate.processedUnits.clickThroughHref).toContain('from=2026-04-01');
  });
});

describe('metric #4 — Recycling rate', () => {
  it('renders green with caption when no reconciliation has been uploaded', async () => {
    const slate = await collectMetrics(makeInput());
    expect(slate.recyclingRate.bucket).toBe('green');
    expect(slate.recyclingRate.value).toBe(0);
    expect(slate.recyclingRate.threshold).toBe(70);
    expect(slate.recyclingRate.caption).toMatch(/MyMRC reconciliation proxy/);
  });

  it('grades green when reconciled-weight ratio ≥ target (OR 70%)', async () => {
    reconciliationFindManyMock.mockResolvedValueOnce([{ id: 'rec-1' }]);
    reconciliationItemFindManyMock.mockResolvedValueOnce([
      { external_weight_lbs: 7000, status: 'resolved' },
      { external_weight_lbs: 3000, status: 'unmatched_in_dr3' },
    ]);

    const slate = await collectMetrics(makeInput());
    expect(slate.recyclingRate.bucket).toBe('green');
    expect(slate.recyclingRate.value).toBe(70);
    expect(slate.recyclingRate.rowCount).toBe(2);
    expect(slate.recyclingRate.caption).toContain('7,000/10,000 lbs reconciled');
  });

  it('grades yellow when within 5pp of threshold', async () => {
    reconciliationFindManyMock.mockResolvedValueOnce([{ id: 'rec-1' }]);
    reconciliationItemFindManyMock.mockResolvedValueOnce([
      { external_weight_lbs: 6700, status: 'resolved' },
      { external_weight_lbs: 3300, status: 'count_mismatch' },
    ]);

    const slate = await collectMetrics(makeInput());
    expect(slate.recyclingRate.bucket).toBe('yellow');
    expect(slate.recyclingRate.value).toBe(67);
  });

  it('grades red when below threshold-5pp', async () => {
    reconciliationFindManyMock.mockResolvedValueOnce([{ id: 'rec-1' }]);
    reconciliationItemFindManyMock.mockResolvedValueOnce([
      { external_weight_lbs: 5000, status: 'resolved' },
      { external_weight_lbs: 5000, status: 'weight_mismatch' },
    ]);

    const slate = await collectMetrics(makeInput());
    expect(slate.recyclingRate.bucket).toBe('red');
    expect(slate.recyclingRate.value).toBe(50);
  });

  it('honors per-site target (CA 75% vs OR 70%)', async () => {
    reconciliationFindManyMock.mockResolvedValueOnce([{ id: 'rec-1' }]);
    reconciliationItemFindManyMock.mockResolvedValueOnce([
      { external_weight_lbs: 7200, status: 'resolved' },
      { external_weight_lbs: 2800, status: 'unmatched_in_dr3' },
    ]);

    const woodland = makeInput({
      siteId: 'site-woodland',
      siteCode: 'woodland',
      site: {
        ...makeInput().site,
        recycling_rate_target_pct:
          75 as unknown as MetricInput['site']['recycling_rate_target_pct'],
      },
    });

    const slate = await collectMetrics(woodland);
    // 72% vs OR's 70% would be green, but vs CA's 75% it's yellow.
    expect(slate.recyclingRate.threshold).toBe(75);
    expect(slate.recyclingRate.value).toBe(72);
    expect(slate.recyclingRate.bucket).toBe('yellow');
  });

  it('treats null external_weight_lbs as zero and stays in green/empty state', async () => {
    reconciliationFindManyMock.mockResolvedValueOnce([{ id: 'rec-1' }]);
    reconciliationItemFindManyMock.mockResolvedValueOnce([
      { external_weight_lbs: null, status: 'resolved' },
      { external_weight_lbs: null, status: 'unmatched_in_dr3' },
    ]);

    const slate = await collectMetrics(makeInput());
    expect(slate.recyclingRate.bucket).toBe('green');
    expect(slate.recyclingRate.value).toBe(0);
    // Items still counted in scope so the manager knows the recon was
    // present but had no weight data.
    expect(slate.recyclingRate.rowCount).toBe(2);
  });
});
