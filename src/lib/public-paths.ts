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
  // ADR-0042 — internal COR print source (T/D3): the session-less Playwright
  // generator (@/lib/cor/pdf.ts) navigates here over loopback to render the
  // certificate PDF. Same loopback / cf-connecting-ip 404 guard as the bonus-pdf
  // route is the real protection (the public tunnel still gets 404); this
  // exemption just stops the auth middleware bouncing the session-less generator
  // to /login. WITHOUT it the fetch follows the 307 to a 200 HTML login page and
  // Playwright prints the login screen (the ADR-0036 regression, made mandatory).
  if (pathname.startsWith('/internal/cor-pdf/')) return true;
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
  // ADR-0039 — audit nightly-sweep cron endpoint: identical loopback-guarded
  // internal-route pattern. Same 2026-07-03 lesson as the survey route above —
  // WITHOUT this exemption the middleware 307s the session-less cron POST to
  // /login, the daemon's fetch follows to a 200 HTML page, and the sweep silently
  // no-ops while logging success. The daemon uses `redirect:'manual'` as the
  // second line of defence; this exemption is the first.
  if (pathname.startsWith('/api/internal/audit/')) return true;
  // ADR-0040 — internal weekly fuel-price fetch cron endpoint
  // (`/api/internal/billing/fuel-fetch`). Same loopback-guarded internal-route
  // pattern as the survey/bonus crons above: without this exemption the middleware
  // 307s the session-less cron POST to /login, fetch follows to a 200 HTML page, and
  // the tick silently no-ops while logging success (the ADR-0036 regression, made a
  // mandatory day-one case here per ADR-0040 D4).
  if (pathname.startsWith('/api/internal/billing/')) return true;
  // ADR-0046 D5 — internal AP mailbox poll cron endpoint
  // (`/api/internal/ap/poll`). Same loopback-guarded internal-route pattern as
  // the survey/bonus/audit crons above: without this exemption the middleware
  // 307s the session-less `ap-poll-cron.mjs` POST to /login, its fetch follows
  // to a 200 HTML page, and the poll silently no-ops while logging success (the
  // ADR-0036 regression, made a mandatory day-one case per ADR-0046 D5). The
  // daemon uses `redirect:'manual'` as the second line of defence.
  if (pathname.startsWith('/api/internal/ap/')) return true;
  // Operator name-picker + PIN-entry are pre-auth surfaces. The
  // /queue subroute does its own server-side session check (and is
  // gated to role=operator there), so middleware doesn't need to.
  if (pathname === '/operator') return true;
  if (pathname.startsWith('/operator/')) return true;
  // ADR-0034 — public, token-gated operational-intelligence survey. The token
  // IS the access (no session); covers the page + its draft/submit API.
  if (pathname.startsWith('/survey/')) return true;
  if (pathname.startsWith('/api/survey/')) return true;
  // ADR-0045 D3 — public contact-form intake. UNLIKE the loopback-guarded
  // internal crons above, this endpoint is genuinely internet-reachable (the
  // WordPress form plugin POSTs to it over the public tunnel): the shared-secret
  // `x-intake-token` header + honeypot + rate limit ARE the protection, not a
  // cf-connecting-ip 404. Without this exemption the middleware 307s the
  // session-less POST to /login and the form silently breaks — the mandatory
  // day-one case per ADR-0045 D3.
  if (pathname.startsWith('/api/intake/')) return true;
  return false;
}
