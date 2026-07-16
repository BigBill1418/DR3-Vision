// 2026-07-11 Bill directive — on-save late report path. Mirrors the
// daily-report-runner test mocking pattern (module-mocked prisma + build/send).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirstConfig = vi.fn();
const findUniqueLog = vi.fn();
const createLog = vi.fn();
const updateLog = vi.fn();
const updateManyLog = vi.fn();

vi.mock('@/lib/prisma', () => ({
  prisma: {
    bonusDailyReportConfig: { findFirst: (...a: unknown[]) => findFirstConfig(...a) },
    bonusDailyReportLog: {
      findUnique: (...a: unknown[]) => findUniqueLog(...a),
      create: (...a: unknown[]) => createLog(...a),
      update: (...a: unknown[]) => updateLog(...a),
      updateMany: (...a: unknown[]) => updateManyLog(...a),
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

vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  maybeSendLateDailyReport,
  isPastScheduledSend,
  formatSendTimePt,
} from '../daily-report-late';

// 2026-06-17 (PDT). Send time 12:00 PT. 20:00Z = 1:00 PM PDT (past send);
// 18:00Z = 11:00 AM PDT (before send).
const TODAY = new Date(Date.UTC(2026, 5, 17));
const YESTERDAY = new Date(Date.UTC(2026, 5, 16));
const TOMORROW = new Date(Date.UTC(2026, 5, 18));
const AFTER_SEND = new Date('2026-06-17T20:00:00Z');
const BEFORE_SEND = new Date('2026-06-17T18:00:00Z');

function pt(hour: number, minute = 0): Date {
  return new Date(Date.UTC(1970, 0, 1, hour, minute, 0));
}

function makeConfig(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cfg-w',
    site_id: 'site-w',
    enabled: true,
    send_time_pt: pt(12),
    subject_template: 'DR3 {site} {date}',
    skip_if_zero: false,
    skip_weekends: true, // late path must ignore these — data in = report out
    skip_holidays: true,
    include_bonus_dollars: true,
    include_comparisons: true,
    recipients: [{ email: 'team@svdp.us' }],
    ...over,
  };
}

function makeReport(totalToday = 271) {
  return {
    siteName: 'Woodland',
    reportDate: TODAY,
    totalToday,
    totalBonusCents: 12400,
    mtd: { total: 1786 },
    lines: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createLog.mockResolvedValue({ id: 'log-new' });
  updateLog.mockResolvedValue({ id: 'log-new' });
  updateManyLog.mockResolvedValue({ count: 1 }); // resend claim won by default
  sendDailyReport.mockResolvedValue({
    attempted: 1,
    delivered_count: 1,
    graph_message_id: 'msg-1',
    last_status: 202,
  });
});

describe('isPastScheduledSend', () => {
  it('a prior calendar day is always late', () => {
    expect(isPastScheduledSend(YESTERDAY, pt(12), BEFORE_SEND)).toBe(true);
  });
  it('today before the send time is not late', () => {
    expect(isPastScheduledSend(TODAY, pt(12), BEFORE_SEND)).toBe(false);
  });
  it('today at/after the send time is late', () => {
    expect(isPastScheduledSend(TODAY, pt(12), AFTER_SEND)).toBe(true);
  });
});

describe('formatSendTimePt', () => {
  it('renders 12h Pacific wall clock', () => {
    expect(formatSendTimePt(pt(18, 0))).toBe('6:00 PM PT');
    expect(formatSendTimePt(pt(0, 5))).toBe('12:05 AM PT');
    expect(formatSendTimePt(pt(12, 30))).toBe('12:30 PM PT');
  });
});

describe('maybeSendLateDailyReport', () => {
  it('on-time save (before send time) is a no-op', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    const out = await maybeSendLateDailyReport('site-w', TODAY, BEFORE_SEND);
    expect(out).toBe('not_late');
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('late first save sends immediately with the late flag and logs late_submission', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue(null);
    buildDailyReport.mockResolvedValue(makeReport());

    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('sent_late');

    const sendArgs = sendDailyReport.mock.calls[0]![0] as {
      lateInfo?: { isResend: boolean; scheduledPT: string; enteredAtPT: string };
    };
    expect(sendArgs.lateInfo?.isResend).toBe(false);
    expect(sendArgs.lateInfo?.scheduledPT).toBe('12:00 PM PT');
    expect(sendArgs.lateInfo?.enteredAtPT).toContain('PT');

    const created = createLog.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(created.data['late_submission']).toBe(true);
    expect(created.data['data_entered_at']).toEqual(AFTER_SEND);
    expect(created.data['resend_count']).toBeUndefined(); // default 0
  });

  it('a save for YESTERDAY (amendment/backdate) CLAIMS then sends the corrected report as a resend', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue({
      id: 'log-1',
      total_today: 200,
      total_bonus_cents: 9000,
      resend_count: 0,
    });
    buildDailyReport.mockResolvedValue({ ...makeReport(240), reportDate: YESTERDAY });

    const out = await maybeSendLateDailyReport('site-w', YESTERDAY, BEFORE_SEND);
    expect(out).toBe('resent_late');

    // The resend is CLAIMED via a CAS updateMany — guarded on the stored totals
    // still differing — BEFORE the send. Content + resend increment land here.
    const claim = updateManyLog.mock.calls[0]![0] as {
      where: { id: string; NOT?: Record<string, unknown> };
      data: Record<string, unknown>;
    };
    expect(claim.where.id).toBe('log-1');
    expect(claim.where.NOT).toEqual({ total_today: 240, total_bonus_cents: 12400 });
    expect(claim.data['resend_count']).toEqual({ increment: 1 });
    expect(claim.data['late_submission']).toBe(true);
    expect(claim.data['total_today']).toBe(240);

    // The send fires once, flagged as a resend…
    const sendArgs = sendDailyReport.mock.calls[0]![0] as { lateInfo?: { isResend: boolean } };
    expect(sendArgs.lateInfo?.isResend).toBe(true);
    // …and the finalize update records delivery on the claimed row.
    const finalize = updateLog.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(finalize.where.id).toBe('log-1');
    expect(finalize.data['delivered_count']).toBe(1);
  });

  it('claim lost on first send (P2002 from a concurrent save/scheduled fire) → no duplicate send', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue(null);
    buildDailyReport.mockResolvedValue(makeReport());
    createLog.mockRejectedValue(p2002()); // the atomic claim loses the race

    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('skipped_unchanged');
    expect(sendDailyReport).not.toHaveBeenCalled(); // the point: never a duplicate report
  });

  it('resend claim lost (a concurrent resend already wrote these totals) → no duplicate send', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue({
      id: 'log-1',
      total_today: 200,
      total_bonus_cents: 9000,
      resend_count: 0,
    });
    buildDailyReport.mockResolvedValue(makeReport(240));
    updateManyLog.mockResolvedValue({ count: 0 }); // CAS matched nothing — we lost

    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('skipped_unchanged');
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('unchanged totals after a prior send are idempotent (no spam on re-save)', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue({
      id: 'log-1',
      total_today: 271,
      total_bonus_cents: 12400,
      resend_count: 0,
    });
    buildDailyReport.mockResolvedValue(makeReport(271));

    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('skipped_unchanged');
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('a zero-total day never sends from the late path', async () => {
    findFirstConfig.mockResolvedValue(makeConfig());
    findUniqueLog.mockResolvedValue(null);
    buildDailyReport.mockResolvedValue(makeReport(0));

    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('skipped_zero');
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('no enabled config / no recipients / future day are no-ops', async () => {
    findFirstConfig.mockResolvedValue(null);
    expect(await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND)).toBe('skipped_no_config');

    findFirstConfig.mockResolvedValue(makeConfig({ recipients: [] }));
    expect(await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND)).toBe(
      'skipped_no_recipients',
    );

    findFirstConfig.mockResolvedValue(makeConfig());
    expect(await maybeSendLateDailyReport('site-w', TOMORROW, AFTER_SEND)).toBe('skipped_future');
  });

  it('NEVER throws — a mail/DB failure logs and returns error (the save already committed)', async () => {
    findFirstConfig.mockRejectedValue(new Error('db down'));
    const out = await maybeSendLateDailyReport('site-w', TODAY, AFTER_SEND);
    expect(out).toBe('error');
  });
});
