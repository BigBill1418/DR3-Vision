// ADR-0053 D3 — middleware CSP wiring. Mocks next-auth so the default export is
// the bare request handler (NextAuth's `auth()` wrapper is identity here), then
// drives it with fake requests to assert the emitted Content-Security-Policy
// response header — AND that the pre-existing auth behavior is untouched
// (public paths pass, unauthenticated gated paths 307 to /login).

import { describe, it, expect, vi } from 'vitest';
import type { NextResponse } from 'next/server';

// NextAuth(authConfig).auth(handler) → handler (identity). authConfig stubbed so
// no edge/Prisma config is evaluated in the node test.
vi.mock('next-auth', () => ({ default: () => ({ auth: (handler: unknown) => handler }) }));
vi.mock('@/lib/auth.config', () => ({ authConfig: {} }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake NextRequest
type FakeReq = any;
import middleware from '@/middleware';

function req(
  pathname: string,
  opts: { auth?: unknown; headers?: Record<string, string> } = {},
): FakeReq {
  return {
    nextUrl: { pathname },
    url: `https://dr3-vision.svdp.us${pathname}`,
    headers: new Headers(opts.headers ?? {}),
    auth: opts.auth,
  };
}

function scriptSrc(csp: string): string {
  return csp.split('; ').find((d) => d.startsWith('script-src '))!;
}

// middleware is typed as a NextMiddleware `(request, event)`; the handler ignores
// the event, so a stub satisfies the signature.
const run = (r: FakeReq): NextResponse => middleware(r, {} as never) as unknown as NextResponse;

describe('middleware CSP (ADR-0053 D3)', () => {
  it('emits a nonce+strict-dynamic CSP with no unsafe-inline on a public route', () => {
    const res = run(req('/login'));
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("'nonce-");
    expect(csp).toContain("'strict-dynamic'");
    expect(scriptSrc(csp!)).not.toContain("'unsafe-inline'");
    // D3 hardening directives present.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    // Request-id correlation preserved.
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('appends frame-ancestors self on /survey but omits it elsewhere', () => {
    expect(run(req('/survey/tok123')).headers.get('content-security-policy')).toContain(
      "frame-ancestors 'self'",
    );
    // A gated route reached with a valid session: CSP present, no frame-ancestors.
    const authed = run(req('/dashboard', { auth: { user: { id: 'u1' } } }));
    const csp = authed.headers.get('content-security-policy')!;
    expect(csp).toBeTruthy();
    expect(csp).not.toContain('frame-ancestors');
  });

  it('mints a fresh nonce per request', () => {
    const a = run(req('/login')).headers.get('content-security-policy')!;
    const b = run(req('/login')).headers.get('content-security-policy')!;
    expect(a).not.toBe(b);
  });

  it('skips the CSP header for router prefetches (but still runs, sets x-request-id)', () => {
    const res = run(req('/login', { headers: { 'next-router-prefetch': '1' } }));
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('preserves auth: an unauthenticated gated route 307s to /login (and still carries CSP)', () => {
    const res = run(req('/dashboard', { auth: undefined }));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('location')).toContain('next=%2Fdashboard');
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
  });
});
