import { describe, it, expect, vi, beforeEach } from 'vitest';

const closePayPeriodsDueForSignature = vi.fn(async () => ({ transitioned: ['m1', 'm2'] }));
const notifyPendingSigner = vi.fn<(id: string) => Promise<{ notified: boolean; slot: 'janette' }>>(
  async () => ({ notified: true, slot: 'janette' as const }),
);

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/lib/bonus/state-machine', () => ({
  closePayPeriodsDueForSignature: (...a: unknown[]) => closePayPeriodsDueForSignature(...(a as [])),
}));
vi.mock('@/lib/bonus/signature-notifications', () => ({
  notifyPendingSigner: (id: string) => notifyPendingSigner(id as never),
}));

import { POST } from './route';
import { appToday, previousDayKey } from '@/lib/time';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/bonus/close-months', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  closePayPeriodsDueForSignature.mockClear();
  notifyPendingSigner.mockClear();
  delete process.env['INTERNAL_CRON_TOKEN'];
});

describe('POST /api/internal/bonus/close-months', () => {
  it('404s a public-tunnel request (cf-connecting-ip present) without closing anything', async () => {
    const res = await POST(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res.status).toBe(404);
    expect(closePayPeriodsDueForSignature).not.toHaveBeenCalled();
  });

  it('closes due months and emails the first signer for each (loopback)', async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ closed: ['m1', 'm2'], notified: ['m1', 'm2'] });
    expect(notifyPendingSigner).toHaveBeenCalledTimes(2);
  });

  it('targets periods whose period_end was YESTERDAY (payroll-day close, ADR-0019.1 amendment)', async () => {
    await POST(req());
    const firstCall = closePayPeriodsDueForSignature.mock.calls[0] as unknown as unknown[];
    const passedNow = firstCall[1] as Date;
    // The route passes previousDayKey(appToday()) — the day BEFORE Pacific today.
    expect(passedNow.getTime()).toBe(previousDayKey(appToday()).getTime());
    expect(passedNow.getTime()).toBe(appToday().getTime() - 86_400_000);
  });

  it('enforces the bearer token when INTERNAL_CRON_TOKEN is set', async () => {
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect((await POST(req())).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer wrong' }))).status).toBe(404);
    expect((await POST(req({ authorization: 'Bearer sekret' }))).status).toBe(200);
  });

  it('a failing email does not fail the run (fail-open)', async () => {
    notifyPendingSigner.mockRejectedValueOnce(new Error('graph down'));
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.closed).toEqual(['m1', 'm2']);
    expect(body.notified).toEqual(['m2']); // m1 threw, m2 succeeded
  });
});
