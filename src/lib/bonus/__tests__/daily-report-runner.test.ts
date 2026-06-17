import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
const findManyConfigs = vi.fn();
const findUniqueHoliday = vi.fn();
const findUniqueLog = vi.fn();
const createLog = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusDailyReportConfig: { findMany: (...a: unknown[]) => findManyConfigs(...a) },
    siteHoliday: { findUnique: (...a: unknown[]) => findUniqueHoliday(...a) },
    bonusDailyReportLog: {
      findUnique: (...a: unknown[]) => findUniqueLog(...a),
      create: (...a: unknown[]) => createLog(...a),
    },
  },
}));

const buildDailyReport = vi.fn();
vi.mock('@/lib/bonus/daily-report', () => ({
  buildDailyReport: (...a: unknown[]) => buildDailyReport(...a),
}));

const sendDailyReport = vi.fn();
vi.mock('@/lib/bonus/daily-report-notifications', () => ({
  sendDailyReport: (...a: unknown[]) => sendDailyReport(...a),
}));

// appToday → the UTC-midnight @db.Date key. Mock to a fixed key so log writes
// are assertable regardless of the host zone.
const DAY_KEY = new Date(Date.UTC(2026, 5, 17)); // 2026-06-17
vi.mock('@/lib/time', () => ({ appToday: () => DAY_KEY }));

vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runDailyReportFire } from '../daily-report-runner';

// ── Fixtures ─────────────────────────────────────────────────────────
// 2026-06-17T20:00:00Z = 1:00 PM PDT (UTC-7) → Pacific seconds-of-day = 46800.
const NOW = new Date('2026-06-17T20:00:00Z');

/** A `@db.Time` value: a Date whose UTC hours/minutes ARE the wall clock. */
function pt(hour: number, minute = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

function makeConfig(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cfg-w',
    site_id: 'site-w',
    enabled: true,
    send_time_pt: pt(12), // 12:00 PT → due at 1 PM PT
    subject_template: 'DR3 {site} {date}',
    skip_if_zero: false,
    skip_weekends: false,
    skip_holidays: false,
    include_bonus_dollars: true,
    include_comparisons: true,
    site: { id: 'site-w', code: 'woodland', name: 'Woodland' },
    recipients: [{ email: 'a@svdp.us' }],
    ...over,
  };
}

function makeReport(over: Partial<Record<string, unknown>> = {}) {
  return {
    siteId: 'site-w',
    siteCode: 'woodland',
    siteName: 'Woodland',
    reportDate: DAY_KEY,
    lines: [],
    totalToday: 42,
    totalBonusCents: 1275,
    sameDayLastYear: { startDate: DAY_KEY, endDate: DAY_KEY, total: null },
    mtd: { startDate: DAY_KEY, endDate: DAY_KEY, total: 500 },
    priorMonthSamePeriod: { startDate: DAY_KEY, endDate: DAY_KEY, total: null },
    paceDeltaPct: null,
    ...over,
  };
}

beforeEach(() => {
  findManyConfigs.mockReset();
  findUniqueHoliday.mockReset().mockResolvedValue(null);
  findUniqueLog.mockReset().mockResolvedValue(null);
  createLog.mockReset().mockResolvedValue({});
  buildDailyReport.mockReset().mockResolvedValue(makeReport());
  sendDailyReport
    .mockReset()
    .mockResolvedValue({
      attempted: 1,
      delivered_count: 1,
      graph_message_id: 'g1',
      last_status: 202,
    });
});

describe('runDailyReportFire', () => {
  it('skips a site whose Pacific send time has not yet passed (not_due)', async () => {
    // send_time_pt = 18:00 PT, now = 1 PM PT → not due.
    findManyConfigs.mockResolvedValue([makeConfig({ send_time_pt: pt(18) })]);
    const { outcomes } = await runDailyReportFire(NOW);
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_not_due' }]);
    expect(buildDailyReport).not.toHaveBeenCalled();
    expect(createLog).not.toHaveBeenCalled();
  });

  it('skips a site that already has a log row for the day (idempotent)', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    findUniqueLog.mockResolvedValue({ id: 'existing' });
    const { outcomes } = await runDailyReportFire(NOW);
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_already_logged' }]);
    expect(sendDailyReport).not.toHaveBeenCalled();
    expect(createLog).not.toHaveBeenCalled();
  });

  it('skips on skip_if_zero when the report has zero units', async () => {
    findManyConfigs.mockResolvedValue([makeConfig({ skip_if_zero: true })]);
    buildDailyReport.mockResolvedValue(makeReport({ totalToday: 0 }));
    const { outcomes } = await runDailyReportFire(NOW);
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_zero' }]);
    expect(sendDailyReport).not.toHaveBeenCalled();
    expect(createLog).not.toHaveBeenCalled();
  });

  it('happy path: sends and writes a log row with the correct fields', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    const { outcomes } = await runDailyReportFire(NOW);

    expect(outcomes).toEqual([
      { siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 },
    ]);
    expect(sendDailyReport).toHaveBeenCalledWith({
      report: expect.objectContaining({ siteId: 'site-w' }),
      recipients: ['a@svdp.us'],
      subjectTemplate: 'DR3 {site} {date}',
      includeBonusDollars: true,
      includeComparisons: true,
    });
    expect(createLog).toHaveBeenCalledTimes(1);
    expect(createLog).toHaveBeenCalledWith({
      data: {
        site_id: 'site-w',
        report_date: DAY_KEY,
        recipient_count: 1,
        total_today: 42,
        total_bonus_cents: 1275,
        mtd_total: 500,
        delivered_count: 1,
        graph_message_id: 'g1',
        last_status: 202,
      },
    });
  });

  it('one site throwing does not stop the other (returns outcomes for both)', async () => {
    const cfgBad = makeConfig({
      id: 'cfg-e',
      site_id: 'site-e',
      site: { id: 'site-e', code: 'eugene', name: 'Eugene' },
    });
    const cfgGood = makeConfig();
    findManyConfigs.mockResolvedValue([cfgBad, cfgGood]);
    // The eugene build throws; woodland proceeds normally.
    buildDailyReport.mockImplementation(async (siteId: string) => {
      if (siteId === 'site-e') throw new Error('build blew up');
      return makeReport();
    });

    const { outcomes } = await runDailyReportFire(NOW);
    // The thrown site produces NO outcome (caught + skipped); the good one is 'sent'.
    expect(outcomes).toEqual([
      { siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 },
    ]);
    expect(createLog).toHaveBeenCalledTimes(1);
  });
});
