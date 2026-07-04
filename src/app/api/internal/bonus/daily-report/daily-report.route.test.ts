import { describe, it, expect, vi, beforeEach } from 'vitest';

const runDailyReportFire = vi.fn(async () => ({
  outcomes: [
    { siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 },
    { siteCode: 'eugene', status: 'skipped_not_due' },
  ],
}));

const runAlertDigestFire = vi.fn(async () => ({
  outcomes: [{ siteCode: 'woodland', status: 'sent', findingCount: 2, delivered: 2, attempted: 2 }],
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/bonus/daily-report-runner', () => ({
  runDailyReportFire: (...a: unknown[]) => runDailyReportFire(...(a as [])),
}));
vi.mock('@/lib/audit/alert-digest', () => ({
  runAlertDigestFire: (...a: unknown[]) => runAlertDigestFire(...(a as [])),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/daily-report', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runDailyReportFire.mockClear();
  runAlertDigestFire.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/bonus/daily-report', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without firing', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runDailyReportFire).not.toHaveBeenCalled();
  });

  it('fires the runner + alert digest and returns both outcomes (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      outcomes: [
        { siteCode: 'woodland', status: 'sent', delivered: 1, attempted: 1 },
        { siteCode: 'eugene', status: 'skipped_not_due' },
      ],
      alertOutcomes: [{ siteCode: 'woodland', status: 'sent', findingCount: 2, delivered: 2, attempted: 2 }],
    });
    expect(runDailyReportFire).toHaveBeenCalledTimes(1);
    expect(runAlertDigestFire).toHaveBeenCalledTimes(1);
  });

  it('a thrown alert digest does not 500 the cron (daily report still returns)', async () => {
    runAlertDigestFire.mockRejectedValueOnce(new Error('digest blip'));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcomes).toHaveLength(2);
    expect(body.alertOutcomes).toEqual([]);
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
    expect(runDailyReportFire).toHaveBeenCalledTimes(1); // only the valid call fired
  });
});
