// ADR-0019.4 — HTTP surface of the chain-health sweep.
//
// Mirrors the house shape of `api/internal/audit/sweep/sweep.route.test.ts`:
// the REAL `guardInternalCron` runs (driven by process.env), only the work
// function and prisma are mocked.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runChainHealthSweep = vi.fn(async () => ({
  overall: 'green' as const,
  sites: [
    {
      siteCode: 'eugene',
      siteName: 'Eugene',
      status: 'green' as const,
      findings: [],
      autoOverrideActorName: 'Bill Barnard',
    },
  ],
  paged: 0,
  ntfyDropped: 0,
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/bonus/chain-health', () => ({
  runChainHealthSweep: () => runChainHealthSweep(),
}));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/chain-health', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runChainHealthSweep.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/bonus/chain-health', () => {
  it('runs the sweep and returns the report on a loopback call', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ overall: 'green', paged: 0 });
    expect(runChainHealthSweep).toHaveBeenCalledTimes(1);
  });

  it('is 404 to anything arriving through Cloudflare, and does NOT run the sweep', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.7' }));
    expect(res.status).toBe(404);
    expect(runChainHealthSweep).not.toHaveBeenCalled();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });

  it('never returns 200 without having run the sweep (no silent success)', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    await POST(req({ authorization: 'Bearer wrong' }));
    expect(runChainHealthSweep).not.toHaveBeenCalled();
  });
});
