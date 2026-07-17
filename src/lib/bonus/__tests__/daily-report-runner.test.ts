import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────
const findManyConfigs = vi.fn();
const findUniqueHoliday = vi.fn();
const findUniqueLog = vi.fn();
const createLog = vi.fn();
const updateLog = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusDailyReportConfig: { findMany: (...a: unknown[]) => findManyConfigs(...a) },
    siteHoliday: { findUnique: (...a: unknown[]) => findUniqueHoliday(...a) },
    bonusDailyReportLog: {
      findUnique: (...a: unknown[]) => findUniqueLog(...a),
      create: (...a: unknown[]) => createLog(...a),
      update: (...a: unknown[]) => updateLog(...a),
    },
  },
}));

import { Prisma } from '@prisma/client';

/** A real Prisma P2002 (unique-constraint) error — the claim-lost signal. */
function p2002(): Error {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['site_id', 'report_date'] },
  });
}

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
  createLog.mockReset().mockResolvedValue({ id: 'log-1' });
  updateLog.mockReset().mockResolvedValue({ id: 'log-1' });
  buildDailyReport.mockReset().mockResolvedValue(makeReport());
  sendDailyReport.mockReset().mockResolvedValue({
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
    // CLAIM-before-send: create writes the content with a placeholder delivery…
    expect(createLog).toHaveBeenCalledTimes(1);
    expect(createLog).toHaveBeenCalledWith({
      data: {
        site_id: 'site-w',
        report_date: DAY_KEY,
        recipient_count: 1,
        total_today: 42,
        total_bonus_cents: 1275,
        mtd_total: 500,
        delivered_count: 0,
      },
      select: { id: true },
    });
    // …then the finalize update records the real delivery outcome.
    expect(updateLog).toHaveBeenCalledTimes(1);
    expect(updateLog).toHaveBeenCalledWith({
      where: { id: 'log-1' },
      data: {
        recipient_count: 1,
        delivered_count: 1,
        graph_message_id: 'g1',
        last_status: 202,
      },
    });
  });

  it('claim lost (P2002 from a concurrent fire/late-send) → skipped, NO duplicate send', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    findUniqueLog.mockResolvedValue(null); // fast-path read finds nothing…
    createLog.mockRejectedValue(p2002()); // …but the atomic claim loses the race
    const { outcomes } = await runDailyReportFire(NOW);
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_already_logged' }]);
    expect(sendDailyReport).not.toHaveBeenCalled(); // the whole point: no duplicate report
    expect(updateLog).not.toHaveBeenCalled();
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

// ── Backfill path (forDate / siteCodes / force) ─────────────────────────
// The scheduled path (no opts) is exercised above and is byte-identical; these
// prove the explicit-target-day BACKFILL used to re-send a missed report day.
describe('runDailyReportFire — backfill', () => {
  // 2026-07-16 (a Thursday) as the @db.Date-shaped UTC-midnight key.
  const FOR_DATE = new Date(Date.UTC(2026, 6, 16));

  it('past-day forDate sends to the REAL roster + logs (real subject, not-due BYPASSED)', async () => {
    // send_time_pt = 18:00 PT → would be `skipped_not_due` at NOW (1 PM PT) on
    // the scheduled path; forDate makes the past day unconditionally due.
    findManyConfigs.mockResolvedValue([makeConfig({ send_time_pt: pt(18) })]);
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE });

    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 }]);
    // REAL configured recipients + REAL subject template (no `[TEST]` prefix).
    expect(sendDailyReport).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['a@svdp.us'], subjectTemplate: 'DR3 {site} {date}' }),
    );
    // Report built for the BACKFILL day, and the log row keyed on it.
    expect(buildDailyReport).toHaveBeenCalledWith('site-w', FOR_DATE);
    expect(createLog).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ site_id: 'site-w', report_date: FOR_DATE, delivered_count: 0 }),
      }),
    );
    expect(updateLog).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: an already-logged backfill day is skipped (no send) without force', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    findUniqueLog.mockResolvedValue({ id: 'existing' });
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_already_logged' }]);
    expect(sendDailyReport).not.toHaveBeenCalled();
    expect(createLog).not.toHaveBeenCalled();
  });

  it('force re-sends over an existing row: reuses it (no create), re-finalizes delivery', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    findUniqueLog.mockResolvedValue({ id: 'existing' });
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE, force: true });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 }]);
    expect(sendDailyReport).toHaveBeenCalledTimes(1);
    expect(createLog).not.toHaveBeenCalled(); // unique constraint forbids a 2nd row
    expect(updateLog).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'existing' } }));
  });

  it('force still re-sends when a concurrent writer claimed the row (P2002 → reuse raced row)', async () => {
    findManyConfigs.mockResolvedValue([makeConfig()]);
    findUniqueLog
      .mockResolvedValueOnce(null) // fast-path read finds nothing…
      .mockResolvedValueOnce({ id: 'raced' }); // …refetch after the P2002 finds the racer's row
    createLog.mockRejectedValue(p2002());
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE, force: true });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 }]);
    expect(updateLog).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'raced' } }));
  });

  it('still honors weekend skip on the TARGET day (read in UTC, not the run instant)', async () => {
    findManyConfigs.mockResolvedValue([makeConfig({ skip_weekends: true })]);
    const SAT = new Date(Date.UTC(2026, 6, 18)); // 2026-07-18 = Saturday
    const { outcomes } = await runDailyReportFire(NOW, { forDate: SAT });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_weekend' }]);
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('still honors holiday skip keyed on the backfill day', async () => {
    findManyConfigs.mockResolvedValue([makeConfig({ skip_holidays: true })]);
    findUniqueHoliday.mockResolvedValue({ id: 'hol' });
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_holiday' }]);
    expect(findUniqueHoliday).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { site_id_holiday_date: { site_id: 'site-w', holiday_date: FOR_DATE } },
      }),
    );
  });

  it('still honors skip_if_zero on the backfill day', async () => {
    findManyConfigs.mockResolvedValue([makeConfig({ skip_if_zero: true })]);
    buildDailyReport.mockResolvedValue(makeReport({ totalToday: 0 }));
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE });
    expect(outcomes).toEqual([{ siteCode: 'woodland', status: 'skipped_zero' }]);
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('siteCodes restricts the fire to the named sites', async () => {
    const cfgW = makeConfig();
    const cfgE = makeConfig({
      id: 'cfg-e',
      site_id: 'site-e',
      site: { id: 'site-e', code: 'eugene', name: 'Eugene' },
    });
    findManyConfigs.mockResolvedValue([cfgW, cfgE]);
    const { outcomes } = await runDailyReportFire(NOW, { forDate: FOR_DATE, siteCodes: ['eugene'] });
    expect(outcomes).toEqual([{ siteCode: 'eugene', status: 'sent', delivered: 1, attempted: 1 }]);
    expect(buildDailyReport).toHaveBeenCalledTimes(1);
    expect(buildDailyReport).toHaveBeenCalledWith('site-e', FOR_DATE);
  });
});
