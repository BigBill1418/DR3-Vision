import { describe, expect, it, vi, beforeEach } from 'vitest';

const runAuditSweep = vi.fn(async () => ({
  runs: [{ siteId: 's1', siteCode: 'eugene', status: 'ok', windowStartISO: '2026-06-19', windowEndISO: '2026-07-03', checksRun: [], opened: 0, updated: 0, resolved: 0 }],
  failures: 0,
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/audit/sweep', () => ({ runAuditSweep: () => runAuditSweep() }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/audit/sweep', { method: 'POST', headers });
}

beforeEach(() => {
  runAuditSweep.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/audit/sweep', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without sweeping', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runAuditSweep).not.toHaveBeenCalled();
  });

  it('runs the sweep and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.failures).toBe(0);
    expect(body.runs).toHaveLength(1);
    expect(runAuditSweep).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
