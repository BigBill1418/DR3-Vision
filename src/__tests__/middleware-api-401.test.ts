// ADR-0078 G7 — a session-less API call gets a STATUS, not a login page.
//
// This is the primary blocker of the 99-photo drain, and it is the ADR-0036
// class the `public-paths` module already cites six times — arriving this time
// through the photo queue rather than a cron.
//
// Operator sessions idle out after five minutes. `/api/photos/*` is not a public
// path, so a queued replay from an idle iPad was answered `307 → /login`.
// `fetch` follows redirects by default, /login returns `200 text/html`, and the
// caller's `res.ok` is TRUE — so the mint "succeeded", parsing the login page as
// JSON threw a SyntaxError, and that was recorded as a generic retryable error
// with no label. The R2 PUT was never reached. The queue retried forever and
// nothing anywhere said "your session ended".
//
// A browser NAVIGATION still gets its redirect: sending a person to /login is
// correct and is what the redirect is for. Only `fetch` callers, who cannot do
// anything useful with an HTML page, get the status instead.

import { describe, it, expect, vi } from 'vitest';
import type { NextResponse } from 'next/server';

vi.mock('next-auth', () => ({ default: () => ({ auth: (handler: unknown) => handler }) }));
vi.mock('@/lib/auth.config', () => ({ authConfig: {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake NextRequest
type FakeReq = any;
import middleware from '@/middleware';

function req(pathname: string, auth?: unknown): FakeReq {
  return {
    nextUrl: { pathname },
    url: `https://dr3-vision.svdp.us${pathname}`,
    headers: new Headers(),
    auth,
  };
}

const run = (r: FakeReq): NextResponse => middleware(r, {} as never) as unknown as NextResponse;

describe('ADR-0078 G7 — middleware.api-401-not-307', () => {
  // FALSIFIED BY HAND: deleting the `path.startsWith('/api/')` branch returns
  // 307 here, which is the production state in which a queued photo replay
  // followed the redirect and read the login page as a successful mint.
  it.each([
    '/api/photos/upload-url',
    '/api/photos/confirm',
    '/api/queue/replay',
    '/api/operator/eugene/count',
  ])('%s answers 401 JSON when there is no session', (path) => {
    const res = run(req(path));
    expect(res.status, `${path} redirected instead of answering a status`).toBe(401);
    expect(res.status).not.toBe(307);
    expect(res.headers.get('content-type')).toContain('json');
    // No Location header — there is nothing for a fetch to follow.
    expect(res.headers.get('location')).toBeNull();
  });

  // The other half of the contract. A person opening a gated PAGE with no
  // session should land on /login; taking the redirect away from navigations to
  // fix the API case would be a straight downgrade.
  it('a page navigation still redirects to /login', () => {
    const res = run(req('/dashboard/eugene'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
  });

  it('an authenticated API call is untouched', () => {
    const res = run(req('/api/photos/confirm', { user: { id: 'u1' } }));
    expect(res.status).not.toBe(401);
  });

  // THE CATASTROPHIC CASE. Auth.js's own callback is how the PIN keypad signs an
  // operator in; if the 401 branch ever reached it, nobody could log into the
  // building. It is safe today only because `isPublic` is evaluated FIRST and
  // exempts `/api/auth/`, so this asserts that ordering rather than assuming it —
  // a future edit to `public-paths.ts` would otherwise lock out both sites with
  // no test going red.
  it.each(['/api/auth/callback/pin', '/api/auth/csrf', '/api/auth/session'])(
    '%s is never 401d — it IS the sign-in path',
    (path) => {
      expect(run(req(path)).status).not.toBe(401);
    },
  );

  // Cron daemons post session-less to /api/internal/* and must keep passing.
  it('internal cron routes are unaffected', () => {
    expect(run(req('/api/internal/audit/sweep')).status).not.toBe(401);
  });

  // Guards the guard: if `isPublic` ever swallowed these paths the 401 assertions
  // above would pass for the wrong reason (a public path is never gated at all).
  it('the API paths under test are genuinely gated, not public', async () => {
    const { isPublic } = await import('@/lib/public-paths');
    expect(isPublic('/api/photos/upload-url')).toBe(false);
    expect(isPublic('/api/queue/replay')).toBe(false);
  });
});
