import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth.config';
import { isPublic } from '@/lib/public-paths';

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

const { auth } = NextAuth(authConfig);

export default auth((req) => {
  const path = req.nextUrl.pathname;

  // Request-id correlation (ADR-0022 §3, T-108). Mint an edge-safe id (or honor
  // an inbound one from an upstream proxy/trace) and forward it to downstream
  // Node handlers (which build a child logger from it) AND echo it on the
  // response. crypto.randomUUID() is available globally on the edge runtime.
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const forwardHeaders = new Headers(req.headers);
  forwardHeaders.set('x-request-id', requestId);
  const withId = (res: NextResponse): NextResponse => {
    res.headers.set('x-request-id', requestId);
    return res;
  };

  if (isPublic(path)) {
    return withId(NextResponse.next({ request: { headers: forwardHeaders } }));
  }
  if (!req.auth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', path);
    return withId(NextResponse.redirect(loginUrl));
  }
  return withId(NextResponse.next({ request: { headers: forwardHeaders } }));
});

export const config = {
  // Skip middleware on Next static chunks, the favicon, the PWA
  // manifest, the Service Worker bundle (Serwist), and any in-band
  // sw-* worker chunks. These need to be served as public assets
  // for the PWA install + offline behavior to work.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|swe-worker-).*)'],
};
