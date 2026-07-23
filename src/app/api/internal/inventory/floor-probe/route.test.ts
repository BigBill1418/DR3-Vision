// ADR-0058 D4 — the internal floor-probe route: internal-only guard + Decimal
// STRING output (byte-identical comparison is the whole point of the gate).

import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('@/lib/prisma', () => ({
  prisma: {
    site: {
      findFirst: async ({ where }: { where: { code: string } }) =>
        where.code === 'woodland' ? { id: 'site-wood', code: 'woodland' } : null,
    },
  },
}));

const onHand = vi.fn<(...a: unknown[]) => Promise<{
  program: Prisma.Decimal;
  nonProgram: Prisma.Decimal;
  total: Prisma.Decimal;
  anchorPool: 'measured';
}>>(async () => ({
  program: new Prisma.Decimal('1597'),
  nonProgram: new Prisma.Decimal('886'),
  total: new Prisma.Decimal('2483'),
  anchorPool: 'measured' as const,
}));
vi.mock('@/lib/inventory/running-balance', () => ({ onHand: (...a: unknown[]) => onHand(...a) }));

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://app/api/internal/inventory/floor-probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/internal/inventory/floor-probe', () => {
  it('404s a public-tunnel request (cf-connecting-ip)', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ siteCode: 'woodland' }, { 'cf-connecting-ip': '1.2.3.4' }));
    expect(res.status).toBe(404);
  });

  it('returns the floor as Decimal STRINGS at a fixed asOf', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ siteCode: 'woodland', asOf: '2026-07-23T20:00:00.000Z' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      site: 'woodland',
      asOf: '2026-07-23T20:00:00.000Z',
      program: '1597',
      nonProgram: '886',
      total: '2483',
      anchorPool: 'measured',
    });
    // the fixed asOf was passed through to onHand
    expect(onHand).toHaveBeenCalledWith('site-wood', new Date('2026-07-23T20:00:00.000Z'));
  });

  it('422s an invalid body', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ siteCode: 'portland' }));
    expect(res.status).toBe(422);
  });

  it('404s an unknown (but valid-enum) site with no row', async () => {
    const { POST } = await import('./route');
    const res = await POST(makeReq({ siteCode: 'eugene' }));
    expect(res.status).toBe(404);
  });
});
