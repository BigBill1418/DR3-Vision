// Middleware public-path predicate, extracted from src/middleware.ts so it is
// unit-testable without pulling NextAuth into the test (and so the exemption
// list — which has now bitten us twice: ADR-0034's /survey routes and
// ADR-0036's internal reminder-tick — has a regression test). Pure and
// edge-safe: no imports, no env, no Node APIs.

// NOTE: '/' is NOT public — the root route is the authenticated Vision Dashboard
// (ADR-0020, T-107). page.tsx self-gates too, so this is defense-in-depth.
// '/metrics' IS public at the middleware layer so Prometheus can scrape it; the
// route handler itself is the real gate (404 on any request carrying a
// cf-connecting-ip header, i.e. anything via the public Cloudflare tunnel — T-109).
const PUBLIC_PATHS = new Set<string>(['/login', '/healthz', '/metrics']);

export function isPublic(pathname: string): boolean {
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
  // ADR-0036 — survey reminder-tick cron endpoint: identical loopback-guarded
  // internal-route pattern as the bonus cron endpoints above. Without this
  // exemption the middleware 307s the session-less cron POST to /login, fetch
  // follows the redirect to a 200 HTML page, and the tick silently no-ops while
  // logging success (bit us on the first 09:00 PT fire, 2026-07-03).
  if (pathname.startsWith('/api/internal/survey/')) return true;
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
