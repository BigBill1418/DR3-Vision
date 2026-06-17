import { describe, it, expect, vi, beforeEach } from 'vitest';

const siteFindUnique = vi.fn();
const configFindUnique = vi.fn();
const logCreate = vi.fn();
vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: { findUnique: (...a: unknown[]) => siteFindUnique(...a) },
    bonusDailyReportConfig: { findUnique: (...a: unknown[]) => configFindUnique(...a) },
    bonusDailyReportLog: { create: (...a: unknown[]) => logCreate(...a) },
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

vi.mock('@/lib/time', () => ({ appToday: () => new Date('2026-06-17T00:00:00.000Z') }));

import { POST } from './route';

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/daily-report/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env['INTERNAL_CRON_TOKEN'];
  siteFindUnique.mockResolvedValue({ id: 'site-wld' });
  configFindUnique.mockResolvedValue({
    subject_template: 'DR3 Daily Production Report — {site} — {date}',
    include_bonus_dollars: true,
    include_comparisons: true,
  });
  buildDailyReport.mockResolvedValue({ siteName: 'Woodland' });
  sendDailyReport.mockResolvedValue({ attempted: 1, delivered_count: 1 });
});

describe('POST /api/internal/bonus/daily-report/test', () => {
  it('404s a public-tunnel request (cf-connecting-ip) without sending', async () => {
    const res = await POST(
      req(
        { siteCode: 'woodland', to: 'bill.barnard@svdp.us' },
        { 'cf-connecting-ip': '203.0.113.9' },
      ),
    );
    expect(res.status).toBe(404);
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('sends to the single address only and writes NO log row (loopback)', async () => {
    const res = await POST(req({ siteCode: 'woodland', to: 'bill.barnard@svdp.us' }));
    expect(res.status).toBe(200);
    expect(sendDailyReport).toHaveBeenCalledTimes(1);
    expect(sendDailyReport).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: ['bill.barnard@svdp.us'] }),
    );
    // subject is prefixed [TEST] so it can't be confused with a production send
    const sent = sendDailyReport.mock.calls[0]?.[0] as { subjectTemplate: string };
    expect(sent.subjectTemplate.startsWith('[TEST]')).toBe(true);
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('422s an invalid body (bad email / bad site)', async () => {
    expect((await POST(req({ siteCode: 'woodland', to: 'not-an-email' }))).status).toBe(422);
    expect((await POST(req({ siteCode: 'stockton', to: 'a@b.co' }))).status).toBe(422);
    expect(sendDailyReport).not.toHaveBeenCalled();
  });

  it('422s (not 500) when the report build throws — e.g. a back-dated day with no active rule', async () => {
    buildDailyReport.mockRejectedValueOnce(new Error('no active bonus rule for 2025-01-01'));
    const res = await POST(
      req({ siteCode: 'woodland', to: 'bill.barnard@svdp.us', date: '2025-01-01' }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('build_failed');
    expect(sendDailyReport).not.toHaveBeenCalled();
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req({ siteCode: 'woodland', to: 'a@b.co' }))).status).toBe(404);
    expect(
      (await POST(req({ siteCode: 'woodland', to: 'a@b.co' }, { authorization: 'Bearer wrong' })))
        .status,
    ).toBe(404);
    expect(
      (await POST(req({ siteCode: 'woodland', to: 'a@b.co' }, { authorization: 'Bearer sekret' })))
        .status,
    ).toBe(200);
  });
});
