// ADR-0045 §3 addendum — internal board-pack digest send route guard tests
// (mirrors the AP-expiry / close-months route tests): cf-connecting-ip → 404,
// bad/absent bearer → 404, loopback → 200 + result. Regression coverage for the
// loopback guard the thin `scripts/board-pack-digest-cron.mjs` daemon relies on.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const sendBoardPackDigest = vi.fn(async () => ({ sent: [], skipped: 'not_board_pack_day' }));

vi.mock('@/lib/prisma', () => ({ prisma: { site: { findMany: vi.fn(async () => []) } } }));
vi.mock('@/lib/board-pack/digest', () => ({ sendBoardPackDigest: () => sendBoardPackDigest() }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/board-pack/send', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  sendBoardPackDigest.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/board-pack/send', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without running', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(sendBoardPackDigest).not.toHaveBeenCalled();
  });

  it('runs the digest and returns the result (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sent: [], skipped: 'not_board_pack_day' });
    expect(sendBoardPackDigest).toHaveBeenCalledOnce();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404); // absent bearer
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });
});
