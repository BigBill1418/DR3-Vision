// ADR-0049 D2/D5 — internal workbook-sync poll route guard tests (mirrors the
// AP-poll / board-pack route tests): cf-connecting-ip → 404, bad/absent bearer →
// 404, loopback → 200. Regression coverage for the loopback guard the thin
// `scripts/workbook-sync-cron.mjs` daemon relies on. `isBusinessHours` is stubbed
// true so the loopback case reaches the engine rather than the off-hours short-circuit.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const runWorkbookSyncPoll = vi.fn(async () => ({
  transportMode: 'drive',
  sourcesPolled: 1,
  results: [],
}));
const isBusinessHours = vi.fn(() => true);

vi.mock('@/lib/workbook-sync/engine', () => ({
  runWorkbookSyncPoll: () => runWorkbookSyncPoll(),
}));
vi.mock('@/lib/workbook-sync/business-hours', () => ({
  isBusinessHours: () => isBusinessHours(),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/workbook-sync/poll', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runWorkbookSyncPoll.mockClear();
  isBusinessHours.mockClear();
  isBusinessHours.mockReturnValue(true);
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/workbook-sync/poll', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without polling', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runWorkbookSyncPoll).not.toHaveBeenCalled();
  });

  it('polls and returns the result during business hours (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sourcesPolled).toBe(1);
    expect(runWorkbookSyncPoll).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404); // absent bearer
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
    expect(runWorkbookSyncPoll).toHaveBeenCalledOnce(); // only the authorized call ran
  });
});
