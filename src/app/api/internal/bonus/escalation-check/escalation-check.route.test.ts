import { describe, it, expect, vi, beforeEach } from 'vitest';

const runEscalationTier = vi.fn(async (opts: { tier: string }) => ({
  tier: opts.tier,
  periodsExamined: 1,
  ntfyPublished: 1,
  autoSigned: 0,
  deadlineMissed: 0,
  actorUnavailable: 0,
}));

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/bonus/escalation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bonus/escalation')>(
    '@/lib/bonus/escalation',
  );
  return {
    ...actual,
    runEscalationTier: (opts: { tier: string }) => runEscalationTier(opts),
  };
});

import { POST } from './route';

function req(tier: string | null, headers: Record<string, string> = {}): Request {
  const url =
    tier === null
      ? 'http://127.0.0.1:3000/api/internal/bonus/escalation-check'
      : `http://127.0.0.1:3000/api/internal/bonus/escalation-check?tier=${tier}`;
  return new Request(url, { method: 'POST', headers });
}

beforeEach(() => {
  runEscalationTier.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/bonus/escalation-check', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without running', async () => {
    const res = await POST(req('t1', { 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runEscalationTier).not.toHaveBeenCalled();
  });

  it('400s an invalid / missing tier', async () => {
    expect((await POST(req(null))).status).toBe(400);
    expect((await POST(req('t9'))).status).toBe(400);
    expect(runEscalationTier).not.toHaveBeenCalled();
  });

  it('runs the requested tier and returns its result (loopback)', async () => {
    const res = await POST(req('t1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tier).toBe('t1');
    expect(runEscalationTier).toHaveBeenCalledTimes(1);
    const call = runEscalationTier.mock.calls[0];
    if (!call) throw new Error('runEscalationTier not called');
    expect(call[0].tier).toBe('t1');
  });

  it('accepts all four tiers', async () => {
    for (const t of ['t1', 't2', 't3', 't4']) {
      expect((await POST(req(t))).status).toBe(200);
    }
    expect(runEscalationTier).toHaveBeenCalledTimes(4);
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req('t1'))).status).toBe(404);
    expect((await POST(req('t1', { authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req('t1', { authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
