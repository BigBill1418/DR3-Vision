// ADR-0040 D4 — internal fuel-fetch route guard test.
//
// Mirrors the reminder-tick route test: the loopback/cf-connecting-ip guard and the
// optional INTERNAL_CRON_TOKEN bearer. `runFuelFetchTick` is mocked so no EIA/DB/ntfy
// fires — we assert the guard behavior and that the tick summary is returned.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const runFuelFetchTick = vi.fn(async () => ({
  ok: true,
  fetched: 2,
  upserted: 2,
  skipped_manual: 0,
  paged: false,
}));

vi.mock('@/lib/billing-rates/fuel-fetch', () => ({
  runFuelFetchTick: (...a: unknown[]) => runFuelFetchTick(...(a as [])),
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/billing/fuel-fetch', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  runFuelFetchTick.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/billing/fuel-fetch', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without running', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(runFuelFetchTick).not.toHaveBeenCalled();
  });

  it('runs the tick and returns the summary (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, upserted: 2 });
    expect(runFuelFetchTick).toHaveBeenCalledTimes(1);
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
    expect(runFuelFetchTick).toHaveBeenCalledTimes(1);
  });
});
