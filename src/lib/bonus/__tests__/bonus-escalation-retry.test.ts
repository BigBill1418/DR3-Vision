// Audit P1-4 — bounded in-window retry + app-independent backstop page for the
// escalation daemon (`scripts/bonus-escalation-check.mjs`).
//
// Before the fix, a failed tier fire was logged as "retry next tick" and the
// daemon moved on — so a failed t3 (08:30 auto-override + payroll PDF) was treated
// as done until t4, and t4's own backstop page routed through the SAME possibly-
// down app. Now:
//   (1) `fireTierWithRetry` retries a failing tier 3× / 15min within the same run;
//   (2) on exhaustion it publishes DIRECTLY to ntfy (not through the app) so a
//       down app can never swallow the alert.
// The daemon's Pacific scheduling is covered separately in
// `bonus-escalation-cron.test.ts`; here we mock the transport as the sibling cron
// tests do.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fireTierWithRetry,
  publishFireFailure,
} from '../../../../scripts/bonus-escalation-check.mjs';

// ── fireTierWithRetry ────────────────────────────────────────────────
describe('fireTierWithRetry — bounded in-window retry', () => {
  it('returns after a first-attempt success without retrying or paging', async () => {
    const runTier = vi.fn(async () => 'ok');
    const publishFailure = vi.fn(async () => true);
    const wait = vi.fn(async () => {});

    const res = await fireTierWithRetry('t3', { runTier, publishFailure, wait });

    expect(res).toEqual({ ok: true, attempts: 1 });
    expect(runTier).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(publishFailure).not.toHaveBeenCalled();
  });

  it('retries a failing tier and succeeds on the third attempt (no page)', async () => {
    const runTier = vi
      .fn()
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockRejectedValueOnce(new Error('HTTP 503'))
      .mockResolvedValueOnce('ok');
    const publishFailure = vi.fn(async () => true);
    const wait = vi.fn(async () => {});

    const res = await fireTierWithRetry('t3', { runTier, publishFailure, wait });

    expect(res).toEqual({ ok: true, attempts: 3 });
    expect(runTier).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(publishFailure).not.toHaveBeenCalled();
  });

  it('exhausts 3 attempts then fires the app-independent backstop page', async () => {
    const runTier = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const publishFailure = vi.fn(async () => true);
    const wait = vi.fn(async () => {});

    const res = await fireTierWithRetry('t4', { runTier, publishFailure, wait });

    expect(res.ok).toBe(false);
    expect(res.attempts).toBe(3);
    expect(runTier).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(publishFailure).toHaveBeenCalledTimes(1);
    expect(publishFailure).toHaveBeenCalledWith('t4');
  });

  it('spaces retries 15 minutes apart by default', async () => {
    const runTier = vi.fn(async () => {
      throw new Error('down');
    });
    const publishFailure = vi.fn(async () => true);
    const wait = vi.fn<(ms: number) => Promise<void>>(async () => {});

    await fireTierWithRetry('t3', { runTier, publishFailure, wait });

    expect(wait.mock.calls.length).toBeGreaterThan(0);
    for (const call of wait.mock.calls) {
      expect(call[0]).toBe(15 * 60 * 1000);
    }
  });
});

// ── publishFireFailure — direct, app-independent ntfy ────────────────
function stubFetch(...okSequence: boolean[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const ok = okSequence[Math.min(i, okSequence.length - 1)] ?? true;
    i += 1;
    return { ok } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

const FIXED_NOW = new Date('2026-06-09T16:00:00Z'); // 09:00 PDT — Pacific Jun 9

describe('publishFireFailure — app-independent backstop page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['NTFY_PUBLISHER_TOKEN'];
  });

  it('posts to the primary ntfy topic (NOT the app) with a bearer, dedup id, and urgent priority for t3', async () => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test';
    const { calls } = stubFetch(true);

    const ok = await publishFireFailure('t3', FIXED_NOW);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ntfy.barnardhq.com/dr3-vision-system');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tk_test');
    expect(headers['Priority']).toBe('urgent');
    expect(headers['X-Dedup-Id']).toBe('bonus-escalation-fire-failed:t3:2026-06-09');
    // The page never routes through the DR3 app.
    expect(calls[0]!.url).not.toContain('/api/internal');
  });

  it('uses high priority for a reminder tier (t1)', async () => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test';
    const { calls } = stubFetch(true);
    await publishFireFailure('t1', FIXED_NOW);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['Priority']).toBe('high');
  });

  it('falls back to ntfy.sh when the primary publish fails', async () => {
    process.env['NTFY_PUBLISHER_TOKEN'] = 'tk_test';
    const { calls } = stubFetch(false, true); // primary fails, fallback ok

    const ok = await publishFireFailure('t3', FIXED_NOW);

    expect(ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('https://ntfy.sh/bhq-fb-dr3v-system-k8m2n');
    const fbHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(String(fbHeaders['X-Title'])).toContain('[FALLBACK]');
    // Fallback carries no bearer (public server).
    expect(fbHeaders['Authorization']).toBeUndefined();
  });

  it('when NTFY_PUBLISHER_TOKEN is unset, skips the primary and pages the tokenless ntfy.sh fallback (never posts unauthenticated to the primary)', async () => {
    const { calls } = stubFetch(true); // fallback ok
    const ok = await publishFireFailure('t4', FIXED_NOW);
    // App-independent payroll backstop must not go silent just because the token
    // file is missing — it still reaches the anonymous fallback server.
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ntfy.sh/bhq-fb-dr3v-system-k8m2n');
    const fbHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(String(fbHeaders['X-Title'])).toContain('[FALLBACK]');
    // The primary (authenticated) server is never touched without a bearer.
    expect(calls[0]!.url).not.toContain('ntfy.barnardhq.com');
    expect(fbHeaders['Authorization']).toBeUndefined();
  });

  it('returns false (fully silent only) when the token is unset AND the tokenless fallback also fails', async () => {
    const { calls } = stubFetch(false); // fallback fails
    const ok = await publishFireFailure('t4', FIXED_NOW);
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ntfy.sh/bhq-fb-dr3v-system-k8m2n');
  });
});
