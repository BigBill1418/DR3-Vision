// ADR-0046 §3 amendment (handoff §1.6f) — internal AP-approver-expiry route
// guard tests (mirrors the AP poll route test): cf-connecting-ip → 404, loopback
// → 200 + summary, optional bearer.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runApApproverExpiry = vi.fn(async () => ({ expired: 1, userIds: ['u-kelsey'] }));

vi.mock('@/lib/ap/expiry', () => ({ runApApproverExpiry: () => runApApproverExpiry() }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/ap/expiry', { method: 'POST', headers });
}

beforeEach(() => {
  runApApproverExpiry.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/ap/expiry', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without running', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runApApproverExpiry).not.toHaveBeenCalled();
  });

  it('runs the reaper and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expired).toBe(1);
    expect(body.userIds).toEqual(['u-kelsey']);
    expect(runApApproverExpiry).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
