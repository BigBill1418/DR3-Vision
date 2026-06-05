// GlitchTip (Sentry-compatible) error reporting (ADR-0022 §2).
//
// GlitchTip implements the Sentry ingest API, so the official `@sentry/nextjs`
// SDK works against a GlitchTip DSN. This module centralizes the init options so
// the server, edge, and client config files all share one scrubbing policy.
//
// FAIL-OPEN (SPRINT-2-HANDOFF hard rule #6): if `GLITCHTIP_DSN` is unset, init is
// a clean no-op — the app runs normally with no error reporting. This matches the
// ntfy publisher and MyMRC scrape patterns.
//
// DIVISION OF LABOR with the existing ntfy publisher (src/lib/ntfy.ts):
//   - GlitchTip captures EVERY error (handled + unhandled), all roles, browseable
//     in the fleet UI. tracesSampleRate is 0 — Tempo owns traces (ADR-0022 §1).
//   - ntfy fires only for system-level incidents, only to Bill, mobile-push.
// The two are complementary and gate independently.

import type { NodeOptions } from '@sentry/nextjs';

/**
 * Shared `Sentry.init` options for every runtime. Returns `null` when no DSN is
 * configured so callers can no-op cleanly (fail-open).
 */
export function glitchTipInitOptions(): NodeOptions | null {
  const dsn = process.env['GLITCHTIP_DSN'];
  if (!dsn) return null;

  return {
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env['GIT_SHA'] ?? 'dev',
    // Tempo handles traces (ADR-0022 §1); GlitchTip is errors-only.
    tracesSampleRate: 0,
    // Sentry 10 ships its own OpenTelemetry setup. We run our own NodeSDK
    // (instrumentation.ts) and export to Tempo, so disable Sentry's to avoid a
    // duplicate global TracerProvider registration.
    skipOpenTelemetrySetup: true,
    beforeSend(event) {
      // Scrub sensitive fields per CLAUDE.md hard rule #8 + ADR-0007.
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      if (event.request?.cookies) {
        delete event.request.cookies;
      }
      if (event.user) {
        delete event.user.ip_address;
      }
      // Never report PIN-related data — drop the whole event.
      if (event.tags?.['has_pin']) return null;
      return event;
    },
  };
}
