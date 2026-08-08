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
  // ADR-0068 Amendment 5 — the reimbursement decision-mail re-send
  // (`/api/internal/reimbursements/resend`). Added after walking into the exact
  // trap the paragraph above documents: the first live call returned HTTP 200
  // carrying the LOGIN PAGE, because the middleware 307'd the session-less POST
  // and fetch followed the redirect. A 200 that is actually a login page is the
  // most convincing kind of silent no-op — it looks like success at every layer
  // except the one that matters. Nothing was sent, which is the only reason it
  // was caught.
  if (pathname.startsWith('/api/internal/reimbursements/')) return true;
  // ADR-0045 §3 addendum (planning rollup 2026-07-08 §1.8) — internal board-pack
  // digest cron endpoint (`/api/internal/board-pack/send`). Same loopback-guarded
  // internal-route pattern as the survey/bonus/audit/ap crons above: without this
  // exemption the middleware 307s the session-less `board-pack-digest-cron.mjs` POST
  // to /login, its fetch follows to a 200 HTML page, and the digest silently no-ops
  // while logging success (the ADR-0036 regression, mandatory day-one). The daemon
  // uses `redirect:'manual'` as the second line of defence.
  if (pathname.startsWith('/api/internal/board-pack/')) return true;
  // ADR-0049 D2 — internal workbook-sync poll cron endpoint
  // (`/api/internal/workbook-sync/poll`). Same loopback-guarded internal-route
  // pattern as the survey/bonus/audit/ap crons above: without this exemption the
  // middleware 307s the session-less `workbook-sync-cron.mjs` POST to /login, its
  // fetch follows to a 200 HTML page, and the poll silently no-ops while logging
  // success (the ADR-0036 regression, mandatory day-one). The daemon uses
  // `redirect:'manual'` as the second line of defence.
  if (pathname.startsWith('/api/internal/workbook-sync/')) return true;
  // ADR-0058 — internal inventory floor-probe route
  // (`/api/internal/inventory/floor-probe`). The MyMRC processed/inbound bridge
  // backfills call it over loopback to assert onHand() is byte-identical before
  // and after a write (the anchor-safety gate). Same loopback-guarded internal-
  // route pattern as the crons above: the route itself requires the bearer in
  // prod and 404s any cf-connecting-ip request, so this exemption only stops the
  // middleware 307'ing the session-less caller to /login. WITHOUT it the gate
  // fetch gets a 307 and the bridge fails closed — the write never lands (the
  // ADR-0036 regression, made a mandatory day-one case here per ADR-0058).
  if (pathname.startsWith('/api/internal/inventory/')) return true;
  // ADR-0067 §3.2 D4 — the document-ingestion delta sweep
  // (`/api/internal/doc-ingest/sweep`). Same loopback-guarded internal-route
  // pattern as the crons above. WITHOUT this exemption the middleware 307s the
  // session-less `doc-ingest-sweep-cron.mjs` POST to /login, its fetch follows to
  // a 200 HTML page, and the sweep silently no-ops while logging success. That is
  // the standing ADR-0036 regression, and it is worse here than anywhere else:
  // this sweep IS the correctness guarantee for shared-file ingestion, so a
  // silent no-op reproduces the exact MyMRC failure (ADR-0057 D9) the sweep was
  // built to prevent. The daemon uses `redirect:'manual'` as the second defence.
  if (pathname.startsWith('/api/internal/doc-ingest/')) return true;
  // ADR-0087 — the Terex throughput-gap watchdog
  // (`/api/internal/equipment/throughput-gap`). Same loopback-guarded
  // internal-route pattern as every cron above: the route itself requires the
  // bearer in prod and 404s any cf-connecting-ip request, so this exemption only
  // stops the middleware 307'ing the session-less daemon POST to /login. The
  // failure it prevents is the exact one this feature was built to end — a
  // watchdog that logs success while reporting nothing is a SECOND silent
  // instrument layered over the first, and it would be far worse than having no
  // watchdog, because the ledger would stay empty and look like "no gaps". The
  // daemon uses `redirect:'manual'` as the second defence.
  if (pathname.startsWith('/api/internal/equipment/')) return true;
  // ADR-0067 §3.2 — the Graph change-notification webhook
  // (`/api/doc-ingest/notifications`). UNLIKE the loopback-guarded crons above,
  // this endpoint is genuinely internet-reachable: Microsoft Graph POSTs to it
  // from outside, so a `cf-connecting-ip` 404 would break it by design. The
  // per-subscription `clientState` secret — verified in constant time against a
  // stored hash on every notification — IS the protection, exactly as the
  // shared-secret header is for /api/intake/.
  if (pathname.startsWith('/api/doc-ingest/')) return true;
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

// ── ADR-0086 D4 — grant-bearing photo requests ───────────────────────────────
//
// NEITHER photo route is in `PUBLIC_PATHS` above, and neither gets a
// `startsWith` exemption. That is D4's decision and it is not stylistic: this
// file carries ELEVEN `/api/internal/*` exemptions, every one with a comment
// recording the same shape — a session-less POST 307s to /login, `fetch` follows
// the redirect, a 200 carrying the LOGIN PAGE comes back, and the caller logs
// success for work that never happened. ADR-0068 Amendment 5 records walking
// into it as recently as the reimbursement re-send. Putting a bearer-authorized
// WRITE on the far side of that mechanism is not a trade worth making.
//
// ## Why a predicate is needed at all — the ADR's own prose is stale here
//
// ADR-0086 D4 says the routes "are reached by the grant-bearing client because
// the client sends `redirect: 'manual'` and the route itself performs the grant
// check." Read against the code, that is no longer true. ADR-0078 G7 changed the
// middleware: a session-less `/api/*` request now gets a **401 JSON**, not a 307.
// `redirect: 'manual'` does nothing to a 401 — the request never reaches the
// route handler, so a route-level grant check could never run and the feature
// would be inert. D4's second paragraph anticipates exactly this and states the
// only acceptable shape, which is what this implements:
//
//   "If the middleware genuinely must be taught about the header, it should let
//    through ONLY requests that carry a syntactically well-formed
//    `X-Upload-Grant`, and the route must still be the thing that verifies it."
//
// So this predicate is deliberately as narrow as it can be made:
//
//   - the two photo paths and nothing else (exact match, not `startsWith`);
//   - POST only;
//   - a header that is syntactically shaped like a grant.
//
// It is SEPARATE from `isPublic` on purpose. Folding it in would exempt the
// routes from every other caller's point of view and would quietly weaken the
// `public-paths` regression test, which is the thing standing between this file
// and its own history.
//
// This proves NOTHING about authenticity — it cannot: the middleware is edge
// runtime and `node:crypto` is unavailable there. `@/lib/photo-grant`'s
// `verifyPhotoGrant`, run inside the route handler, is the real gate. A request
// that satisfies this predicate and carries garbage gets refused by the route,
// exactly as an unauthenticated one does.

const GRANT_PHOTO_PATHS = new Set<string>(['/api/photos/upload-url', '/api/photos/confirm']);

/** Syntax only: two non-empty base64url segments, bounded. Never authenticity. */
export function looksLikePhotoGrant(value: string | null | undefined): boolean {
  if (!value || value.length > 2048) return false;
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

export function isGrantBearingPhotoRequest(
  pathname: string,
  method: string | null | undefined,
  grantHeader: string | null | undefined,
): boolean {
  // Path first: it is the narrowest test and it short-circuits every other
  // request in the app before any string work happens.
  if (!GRANT_PHOTO_PATHS.has(pathname)) return false;
  // `method` is always present on a real edge Request. Tolerated as absent, and
  // FAIL-CLOSED when it is: an unknown method is not POST, so it is refused.
  // (Reading it bare threw a TypeError under the existing middleware test
  // doubles, which construct a request without one — a predicate that can throw
  // inside the auth path is a 500 on every unauthenticated navigation.)
  if ((method ?? '').toUpperCase() !== 'POST') return false;
  return looksLikePhotoGrant(grantHeader);
}
