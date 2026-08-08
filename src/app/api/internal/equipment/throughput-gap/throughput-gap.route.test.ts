// ADR-0088 — the internal watchdog route's guard posture.
//
// The three cases below are the ones that killed OTHER internal crons in this
// repo (the 2026-07-03 survey 307, the 2026-07-16 unset-token outage), and they
// matter more here than anywhere else: a watchdog that answers 200 while doing
// nothing leaves an EMPTY ledger, and an empty ledger is indistinguishable from
// "no gaps found". That is the original defect reproduced inside its own fix.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runThroughputGapScan = vi.fn(async () => ({
  scanDateISO: '2026-08-10',
  skippedWeekend: false,
  outcomes: [
    {
      siteCode: 'woodland',
      status: 'alerted',
      gapDateISO: '2026-08-07',
      delivered: 1,
      attempted: 1,
    },
    { siteCode: 'eugene', status: 'skipped_no_machine', gapDateISO: '2026-08-07' },
  ],
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/equipment/throughput-gap', () => ({
  runThroughputGapScan: () => runThroughputGapScan(),
}));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/equipment/throughput-gap', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runThroughputGapScan.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/equipment/throughput-gap', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without scanning', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runThroughputGapScan).not.toHaveBeenCalled();
  });

  it('runs the scan and returns the per-site summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scanDateISO).toBe('2026-08-10');
    expect(body.skippedWeekend).toBe(false);
    expect(body.outcomes).toHaveLength(2);
    expect(runThroughputGapScan).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
