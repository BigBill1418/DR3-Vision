// audit 2026-07-16 · CRON + TIME — the shared internal-cron guard.
//
// Two hardenings proven here:
//   CRON: INTERNAL_CRON_TOKEN unset is MANDATORY-refuse (503) in production, but
//         fail-open (allow) in non-prod/dev.
//   TIME: the bearer is compared constant-time (length-safe) via constantTimeEqual.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// The prod-unset 503 branch fires a fail-soft ntfy page (2026-07-16 incident:
// a silent 503 strangled every cron). Mock the publisher so we can assert it is
// attempted on that branch and NOT on the token-set path, without real egress.
const publishNtfy = vi.fn(async () => ({ ok: true, outcome: 'sent' as const }));
vi.mock('@/lib/ntfy', () => ({
  publishNtfy: (...a: unknown[]) => publishNtfy(...(a as [])),
}));

import { constantTimeEqual, guardInternalCron } from './internal-auth';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1:3000/api/internal/x', { method: 'POST', headers });
}

const ORIG_NODE_ENV = process.env.NODE_ENV;
const ORIG_TOKEN = process.env['INTERNAL_CRON_TOKEN'];

beforeEach(() => {
  publishNtfy.mockClear();
});

afterEach(() => {
  // NODE_ENV is a getter-backed value on some runtimes; assign defensively.
  (process.env as Record<string, string | undefined>)['NODE_ENV'] = ORIG_NODE_ENV;
  if (ORIG_TOKEN === undefined) delete process.env['INTERNAL_CRON_TOKEN'];
  else process.env['INTERNAL_CRON_TOKEN'] = ORIG_TOKEN;
});

describe('constantTimeEqual', () => {
  it('true only for an exact match; false on null/mismatch/length-diff', () => {
    expect(constantTimeEqual('Bearer abc', 'Bearer abc')).toBe(true);
    expect(constantTimeEqual('Bearer abc', 'Bearer abd')).toBe(false);
    expect(constantTimeEqual('Bearer ab', 'Bearer abc')).toBe(false); // unequal length
    expect(constantTimeEqual(null, 'Bearer abc')).toBe(false);
    expect(constantTimeEqual(undefined, 'x')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('guardInternalCron', () => {
  it('404s a public-tunnel request (cf-connecting-ip present)', () => {
    delete process.env['INTERNAL_CRON_TOKEN'];
    const res = guardInternalCron(req({ 'cf-connecting-ip': '203.0.113.9' }));
    expect(res?.status).toBe(404);
  });

  it('CRON: refuses with 503 when the token is unset IN PRODUCTION, and PAGES (fail-soft)', () => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    delete process.env['INTERNAL_CRON_TOKEN'];
    const res = guardInternalCron(req());
    // The 503 stays (fail-closed is correct)…
    expect(res?.status).toBe(503);
    // …and the guard attempts a high-priority page so the misconfig can't go
    // unnoticed again (the alert is dedup'd by a stable fingerprint + 30m cooldown).
    expect(publishNtfy).toHaveBeenCalledTimes(1);
    expect(publishNtfy).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: 'dr3-vision-system',
        priority: 'high',
        fingerprint: 'dr3-vision-internal-cron-token-unset',
        cooldownMs: 30 * 60 * 1000,
      }),
    );
  });

  it('the 503 is still returned even if the alert publish throws (fail-soft)', () => {
    publishNtfy.mockRejectedValueOnce(new Error('ntfy egress down'));
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    delete process.env['INTERNAL_CRON_TOKEN'];
    expect(guardInternalCron(req())?.status).toBe(503);
  });

  it('fail-open (allows) when the token is unset in non-prod — no page', () => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'test';
    delete process.env['INTERNAL_CRON_TOKEN'];
    expect(guardInternalCron(req())).toBeNull();
    expect(publishNtfy).not.toHaveBeenCalled();
  });

  it('enforces the bearer when the token is set (constant-time), in prod too — no page', () => {
    (process.env as Record<string, string | undefined>)['NODE_ENV'] = 'production';
    process.env['INTERNAL_CRON_TOKEN'] = 'sekret';
    expect(guardInternalCron(req())?.status).toBe(404); // missing bearer
    expect(guardInternalCron(req({ authorization: 'Bearer wrong' }))?.status).toBe(404);
    expect(guardInternalCron(req({ authorization: 'Bearer sekret' }))).toBeNull();
    // A provisioned token never pages — the alert is only for the unconfigured hole.
    expect(publishNtfy).not.toHaveBeenCalled();
  });
});
