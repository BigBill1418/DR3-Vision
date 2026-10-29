// ADR-0143 — the pool-check daemon: a direct 200 is success, anything else (a 307
// to /login above all) is a failure, and it carries the cron bearer.
import { describe, expect, it, vi } from 'vitest';
import { runPoolCheckOnce, TICK_MS } from '../../../../scripts/inventory-pool-check-cron.mjs';

const res = (status: number, body = '{}', location?: string) =>
  ({
    status,
    text: async () => body,
    headers: { get: (h: string) => (h === 'location' ? (location ?? null) : null) },
  }) as unknown as Response;

describe('inventory-pool-check-cron', () => {
  it('POSTs the pool-check route with the bearer and redirect: manual', async () => {
    const f = vi.fn(async () => res(200, '{"writer":"sweep"}'));
    await expect(runPoolCheckOnce(f, 'http://app:3000', 'tok')).resolves.toBe('{"writer":"sweep"}');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://app:3000/api/internal/inventory/pool-check');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('a 307 to /login is a failure, not a quiet success', async () => {
    await expect(
      runPoolCheckOnce(async () => res(307, '', '/login'), 'http://app:3000', 't'),
    ).rejects.toThrow(/HTTP 307 \(redirect → \/login\)/);
  });

  it('a 500 (a site whose guard failed) is a failure', async () => {
    await expect(
      runPoolCheckOnce(async () => res(500, '{"failed":[1]}'), 'x', 't'),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('ticks every 10 minutes', () => {
    expect(TICK_MS).toBe(600_000);
  });
});
