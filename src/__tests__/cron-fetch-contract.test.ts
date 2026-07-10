// ADR-0036-addendum fetch-contract regression for the three bonus daemons fixed
// in the stack-sweep 2026-07-10 (bonus-period-close, bonus-escalation-check,
// bonus-daily-report). Before the fix they used the default fetch redirect mode
// and `res.ok`, so a middleware 307 → /login would be followed to the login
// page's 200 and the tick would "succeed" while doing nothing (the exact
// 2026-07-03 survey-cron incident). Each fetch fn must now: pass
// `redirect: 'manual'`, treat ANY redirect / non-200 as a failure, and truncate
// logged bodies. This mirrors the survey daemon's own runFireOnce test.

import { describe, expect, it, vi, afterEach } from 'vitest';

import { runCloseOnce } from '../../scripts/bonus-period-close.mjs';
import { runTierOnce } from '../../scripts/bonus-escalation-check.mjs';
import { runFireOnce as runDailyReportFire } from '../../scripts/bonus-daily-report.mjs';

function stubFetch(status: number, body: string, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    // The daemon MUST ask fetch not to follow redirects.
    expect(init.redirect).toBe('manual');
    return new Response(status === 204 ? null : body, { status, headers });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const CASES: ReadonlyArray<[string, () => Promise<string>]> = [
  ['bonus-period-close runCloseOnce', () => runCloseOnce()],
  ['bonus-escalation-check runTierOnce', () => runTierOnce('t3' as never)],
  ['bonus-daily-report runFireOnce', () => runDailyReportFire()],
];

describe.each(CASES)('fetch contract — %s', (_name, run) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the body on a direct 200', async () => {
    stubFetch(200, '{"ok":true}');
    await expect(run()).resolves.toContain('"ok":true');
  });

  it('throws on a 307 login redirect instead of following it', async () => {
    stubFetch(307, '', { location: '/login?next=%2Fapi%2Finternal%2Fbonus' });
    await expect(run()).rejects.toThrow(/HTTP 307.*\/login/s);
  });

  it('throws on a non-200 with the (truncated) body in the message', async () => {
    stubFetch(503, 'x'.repeat(1000));
    await expect(run()).rejects.toThrow(/HTTP 503.*truncated 1000 chars/s);
  });
});
