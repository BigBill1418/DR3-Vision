import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/lib/auth.config';

// Edge-runtime middleware. Imports `authConfig` (the edge-safe base
// config without Prisma-backed providers) rather than the full
// `auth.ts`, which would pull Prisma into the edge bundle and fail
// the middleware build.

// NOTE: '/' is NOT public — the root route is the authenticated Vision Dashboard
// (ADR-0020, T-107). page.tsx self-gates too, so this is defense-in-depth.
// '/metrics' IS public at the middleware layer so Prometheus can scrape it; the
// route handler itself is the real gate (404 on any request carrying a
// cf-connecting-ip header, i.e. anything via the public Cloudflare tunnel — T-109).
const PUBLIC_PATHS = new Set<string>(['/login', '/healthz', '/metrics']);

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/api/auth/')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/brand/')) return true;
  // Internal PDF source (T-112): the session-less Playwright generator must reach
  // it without an auth redirect. The route's own loopback / cf-connecting-ip 404
  // guard is the real protection (the public tunnel still gets 404).
  if (pathname.startsWith('/internal/bonus-pdf/')) return true;
  // Internal bonus cron / seed endpoints (close-months T-125, escalation-check,
  // generate-pdf T-321): same loopback-guarded pattern — each route 404s any
  // public-tunnel request and optionally checks a bearer token, so the auth
  // middleware just needs to let the session-less in-fleet caller through.
  if (pathname.startsWith('/api/internal/bonus/')) return true;
  // Operator name-picker + PIN-entry are pre-auth surfaces. The
  // /queue subroute does its own server-side session check (and is
  // gated to role=operator there), so middleware doesn't need to.
  if (pathname === '/operator') return true;
  if (pathname.startsWith('/operator/')) return true;
  // ADR-0034 — public, token-gated operational-intelligence survey. The token
  // IS the access (no session); covers the page + its draft/submit API.
  if (pathname.startsWith('/survey/')) return true;
  if (pathname.startsWith('/api/survey/')) return true;
  return false;
}

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
