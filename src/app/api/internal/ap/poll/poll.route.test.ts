// ADR-0046 D5 — internal AP poll route guard tests (mirrors the audit-sweep
// route test): cf-connecting-ip → 404, loopback → 200 + summary, optional bearer.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runApPoll = vi.fn(async () => ({
  status: 'ok',
  transportMode: 'mock',
  messagesListed: 5,
  requestsCreated: 4,
  followupsCreated: 0,
  quarantined: 1,
  moved: 5,
  duplicates: 0,
  resynced: false,
  error: null,
  runId: 'run-1',
}));

vi.mock('@/lib/ap/poll', () => ({ runApPoll: () => runApPoll() }));
vi.mock('@/lib/observability/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/ap/poll', { method: 'POST', headers });
}

beforeEach(() => {
  runApPoll.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/ap/poll', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without polling', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runApPoll).not.toHaveBeenCalled();
  });

  it('runs the poll and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.transportMode).toBe('mock');
    expect(body.requestsCreated).toBe(4);
    expect(runApPoll).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
