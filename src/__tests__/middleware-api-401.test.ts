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

function req(
  pathname: string,
  auth?: unknown,
  init?: { method?: string; headers?: Record<string, string> },
): FakeReq {
  return {
    nextUrl: { pathname },
    url: `https://dr3-vision.svdp.us${pathname}`,
    headers: new Headers(init?.headers ?? {}),
    // Deliberately left UNDEFINED unless a test asks for one — the pre-ADR-0086
    // cases above construct a request with no method, and the grant predicate
    // must tolerate that rather than throw inside the auth path.
    ...(init?.method ? { method: init.method } : {}),
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

// ── ADR-0086 D4 — the grant keyhole, through the REAL middleware ─────────────

describe('ADR-0086 D4 — a grant-bearing photo POST reaches its route handler', () => {
  // This is the WIRING test, and it is the one that would have caught a feature
  // that shipped inert.
  //
  // ADR-0086 D4 asserts the routes are reached "because the client sends
  // `redirect: 'manual'`". Held against the block above, that is false: G7 made
  // `/api/*` answer a **401**, and no redirect mode survives a 401 — the request
  // dies here and the route's grant check never runs. Testing the predicate and
  // testing the route handler would BOTH have been green while the two were
  // never connected, which is exactly the shape of a feature that works in the
  // suite and does nothing on the floor.
  //
  // FALSIFIED BY HAND: removing the `isGrantBearingPhotoRequest` branch from
  // `middleware.ts` makes both cases below red with 401 — the state in which a
  // sessionless iPad can never drain, which is the entire residual ADR-0086
  // exists to close.
  const GRANT = 'eyJ2IjoxfQ.c2lnbmF0dXJl';

  it.each(['/api/photos/upload-url', '/api/photos/confirm'])(
    '%s is let through when it carries a grant-shaped header',
    (path) => {
      const res = run(
        req(path, undefined, { method: 'POST', headers: { 'x-upload-grant': GRANT } }),
      );
      expect(res.status, `${path} was refused at the edge — the route never ran`).not.toBe(401);
      expect(res.headers.get('location')).toBeNull();
    },
  );

  // The keyhole is a keyhole. Everything that is not exactly the right shape
  // still gets the 401, so this is not a `PUBLIC_PATHS` exemption wearing a
  // different hat.
  it('the same header does NOT open any other route', () => {
    for (const path of ['/api/queue/replay', '/api/operator/eugene/count', '/api/loads']) {
      const res = run(
        req(path, undefined, { method: 'POST', headers: { 'x-upload-grant': GRANT } }),
      );
      expect(res.status, `${path} was opened by a photo grant`).toBe(401);
    }
  });

  it.each([
    ['no header', {}],
    ['an empty header', { 'x-upload-grant': '' }],
    ['a header that is not grant-shaped', { 'x-upload-grant': 'not-a-grant' }],
  ])('a photo POST with %s still gets 401', (_name, headers) => {
    const res = run(req('/api/photos/confirm', undefined, { method: 'POST', headers }));
    expect(res.status).toBe(401);
  });

  it('a GET carrying a grant still gets 401', () => {
    const res = run(
      req('/api/photos/confirm', undefined, {
        method: 'GET',
        headers: { 'x-upload-grant': GRANT },
      }),
    );
    expect(res.status).toBe(401);
  });

  // Same guard-the-guard as above: if the photo paths ever became public, every
  // assertion in this block would pass for the wrong reason.
  it('the photo paths are still NOT public — the keyhole is not an exemption', async () => {
    const { isPublic } = await import('@/lib/public-paths');
    expect(isPublic('/api/photos/upload-url')).toBe(false);
    expect(isPublic('/api/photos/confirm')).toBe(false);
  });
});
