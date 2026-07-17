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

const runUpdateDigestFire = vi.fn(async () => ({ weekly: 'created', boardPack: 'skipped_not_due' }));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/bonus/daily-report-runner', () => ({
  runDailyReportFire: (...a: unknown[]) => runDailyReportFire(...(a as [])),
}));
vi.mock('@/lib/audit/alert-digest', () => ({
  runAlertDigestFire: (...a: unknown[]) => runAlertDigestFire(...(a as [])),
}));
vi.mock('@/lib/ops/update-digest', () => ({
  runUpdateDigestFire: (...a: unknown[]) => runUpdateDigestFire(...(a as [])),
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
  runUpdateDigestFire.mockClear();
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
      updateDigest: { weekly: 'created', boardPack: 'skipped_not_due' },
    });
    expect(runDailyReportFire).toHaveBeenCalledTimes(1);
    expect(runAlertDigestFire).toHaveBeenCalledTimes(1);
    expect(runUpdateDigestFire).toHaveBeenCalledTimes(1);
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

// ── Backfill body (operator re-send of a missed day) ────────────────────
function jsonReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/daily-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/bonus/daily-report — backfill body', () => {
  it('a { date } body fires the runner with forDate and returns ONLY outcomes (no digests)', async () => {
    const res = await POST(jsonReq({ date: '2026-07-16' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.backfill).toBe(true);
    expect(body.date).toBe('2026-07-16');
    expect(body.outcomes).toHaveLength(2);
    // Historical backfill must NOT re-fire the scheduled-tick digest riders.
    expect(runAlertDigestFire).not.toHaveBeenCalled();
    expect(runUpdateDigestFire).not.toHaveBeenCalled();
    // forDate handed to the runner as the UTC-midnight @db.Date key.
    const [, opts] = runDailyReportFire.mock.calls[0] as unknown as [Date, Record<string, unknown>];
    expect(opts).toEqual({
      forDate: new Date('2026-07-16T00:00:00.000Z'),
      siteCodes: undefined,
      force: undefined,
    });
  });

  it('threads siteCodes + force through to the runner', async () => {
    const res = await POST(jsonReq({ date: '2026-07-16', siteCodes: ['eugene'], force: true }));
    expect(res.status).toBe(200);
    const [, opts] = runDailyReportFire.mock.calls[0] as unknown as [Date, Record<string, unknown>];
    expect(opts).toEqual({
      forDate: new Date('2026-07-16T00:00:00.000Z'),
      siteCodes: ['eugene'],
      force: true,
    });
  });

  it('an invalid body is 422 and fires nothing', async () => {
    const res = await POST(jsonReq({ date: 'not-a-date' }));
    expect(res.status).toBe(422);
    expect(runDailyReportFire).not.toHaveBeenCalled();
  });

  it('an unknown site code in siteCodes is rejected 422', async () => {
    const res = await POST(jsonReq({ date: '2026-07-16', siteCodes: ['atlantis'] }));
    expect(res.status).toBe(422);
    expect(runDailyReportFire).not.toHaveBeenCalled();
  });
});
