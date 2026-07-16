import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth.config';
import { isPublic } from '@/lib/public-paths';
import { buildCsp } from '@/lib/csp';

// Edge-runtime middleware. Imports `authConfig` (the edge-safe base
// config without Prisma-backed providers) rather than the full
// `auth.ts`, which would pull Prisma into the edge bundle and fail
// the middleware build.
//
// The public-path predicate lives in `@/lib/public-paths` (pure, edge-safe) so
// the exemption list is unit-testable — a session-less internal cron route that
// is MISSING from that list gets 307'd to /login, which its caller's fetch
// happily follows to a 200 HTML page: the call "succeeds" and does nothing
// (bit ADR-0036's reminder-tick on its first fire, 2026-07-03).
//
// ADR-0053 D3: this middleware is ALSO the single source of the Content-Security-
// Policy. Per request it mints a base64 nonce, forwards it (and the CSP) on the
// REQUEST headers so Next auto-stamps the nonce onto its own bootstrap <script>
// tags, and sets the CSP on the response. `script-src` uses nonce+strict-dynamic
// with NO `'unsafe-inline'`, so an injected inline script cannot run. The auth
// logic below is unchanged — nonce/CSP handling wraps it, never replaces it.

const { auth } = NextAuth(authConfig);

// Edge-safe base64 nonce (Web Crypto only — NO node:crypto). crypto.randomUUID()
// is a v4 UUID (122 bits of entropy); btoa is a global Web API on the edge
// runtime, and a UUID string is Latin1-safe so btoa never throws.
function generateNonce(): string {
  return btoa(crypto.randomUUID());
}

// Survey routes get a same-origin framing exception (ADR-0034 InvitePreview): the
// admin previews the survey in a same-origin <iframe>. `frame-ancestors 'self'`
// mirrors the X-Frame-Options: SAMEORIGIN that next.config.js still sets for
// /survey; every other route keeps DENY and omits frame-ancestors.
function allowsSameOriginFraming(path: string): boolean {
  return path === '/survey' || path.startsWith('/survey/');
}

export default auth((req) => {
  const path = req.nextUrl.pathname;

  // Request-id correlation (ADR-0022 §3, T-108). Mint an edge-safe id (or honor
  // an inbound one from an upstream proxy/trace) and forward it to downstream
  // Node handlers (which build a child logger from it) AND echo it on the
  // response. crypto.randomUUID() is available globally on the edge runtime.
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const forwardHeaders = new Headers(req.headers);
  forwardHeaders.set('x-request-id', requestId);

  // Per-request CSP nonce (ADR-0053 D3). Skip nonce generation for App-Router
  // prefetches: their RSC payload is cached by the client router and never
  // (re)executes document scripts, so a nonce is wasted work and could mismatch a
  // cached response (Next's own guidance). Auth STILL runs on prefetches — the
  // matcher is unchanged, so this is NOT an auth bypass; only the CSP is skipped.
  // Real navigations always mint a fresh nonce.
  const isPrefetch =
    req.headers.get('next-router-prefetch') === '1' || req.headers.get('purpose') === 'prefetch';

  let csp: string | undefined;
  if (!isPrefetch) {
    const nonce = generateNonce();
    csp = buildCsp({ nonce, allowSameOriginFraming: allowsSameOriginFraming(path) });
    // `x-nonce` is for our own code (the login FOUC guard reads it via
    // next/headers). Next itself parses the nonce out of the CSP *request*
    // header — this is the line that nonce-protects Next's framework bootstrap
    // scripts without white-screening the app.
    forwardHeaders.set('x-nonce', nonce);
    forwardHeaders.set('Content-Security-Policy', csp);
  }

  const decorate = (res: NextResponse): NextResponse => {
    res.headers.set('x-request-id', requestId);
    if (csp) res.headers.set('Content-Security-Policy', csp);
    return res;
  };

  if (isPublic(path)) {
    return decorate(NextResponse.next({ request: { headers: forwardHeaders } }));
  }
  if (!req.auth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', path);
    return decorate(NextResponse.redirect(loginUrl));
  }
  return decorate(NextResponse.next({ request: { headers: forwardHeaders } }));
});

export const config = {
  // Skip middleware on Next static chunks, the favicon, the PWA
  // manifest, the Service Worker bundle (Serwist), and any in-band
  // sw-* worker chunks. These need to be served as public assets
  // for the PWA install + offline behavior to work.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|swe-worker-).*)'],
};
