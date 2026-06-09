// T-123 — GlitchTip ingest verification endpoint.
//
// GET /api/admin/_test-error
//
// Deliberately throws so an operator can confirm GlitchTip is capturing
// errors end-to-end after wiring GLITCHTIP_DSN on CHAD-HQ (fleet
// observability setup, step 7a). The thrown error propagates to the
// Next.js error boundary, which @sentry/nextjs has instrumented to
// forward to GlitchTip when a DSN is configured.
//
// Admin-gated (role=admin only): an unauthenticated error-trigger is an
// abuse/DoS vector and would pollute the issue stream. Anonymous -> 401,
// authenticated non-admin -> 403. This mirrors every other route under
// /api/admin (ADR-0017).
//
// When GLITCHTIP_DSN is unset the throw still surfaces as a 500 to the
// caller; it simply isn't reported anywhere (fail-open). That is the
// expected dev/test behavior and is why this route is safe to ship.

import { requireAdmin } from '@/lib/auth-helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  // requireAdmin() throws a Response(401|403) for the unauthorized; return
  // it cleanly so only the deliberate Error below escapes to GlitchTip.
  try {
    await requireAdmin();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  throw new Error('T-123 GlitchTip ingest test — this error is deliberate.');
}
