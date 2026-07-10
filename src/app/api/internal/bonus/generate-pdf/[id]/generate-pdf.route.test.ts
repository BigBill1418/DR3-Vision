// ADR-0023 Q13 / T-321 — internal eager-PDF generation route guard tests
// (mirrors the close-months / board-pack route tests): cf-connecting-ip → 404,
// bad/absent bearer → 404. Regression coverage for the loopback guard the
// historical-import seed (`scripts/generate-historical-pdfs.mjs`) relies on.
//
// The loopback case asserts the guards are cleared by reaching the handler's
// state check (a non-historical period → 409), which unambiguously distinguishes
// "passed the loopback/bearer guards" from a guard 404.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const generateBonusPdf = vi.fn(async () => ({ storageKey: 'k' }));

vi.mock('@/lib/prisma', () => ({ prisma: { bonusPayPeriod: { findUnique: () => findUnique() } } }));
vi.mock('@/lib/bonus/pdf', () => ({ generateBonusPdf: () => generateBonusPdf() }));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from './route';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/generate-pdf/p1', {
    method: 'POST',
    headers,
  });
}
const ctx = { params: Promise.resolve({ id: 'p1' }) };

beforeEach(() => {
  findUnique.mockReset();
  generateBonusPdf.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/bonus/generate-pdf/[id]', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without touching the DB', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }), ctx);
    expect(res.status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled();
    expect(generateBonusPdf).not.toHaveBeenCalled();
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    // A live (draft) period → 409, proving the loopback + bearer guards cleared.
    findUnique.mockResolvedValue({ id: 'p1', state: 'draft', pdf_storage_key: null });

    expect((await POST(req(), ctx)).status).toBe(404); // absent bearer
    expect((await POST(req({ authorization: 'Bearer wrong' }), ctx)).status).toBe(404);
    expect(findUnique).not.toHaveBeenCalled(); // guards short-circuit before the DB

    const ok = await POST(req({ authorization: 'Bearer sekret' }), ctx);
    expect(ok.status).toBe(409); // reached the handler; restricted to historical_imported
    expect(generateBonusPdf).not.toHaveBeenCalled();
  });
});
