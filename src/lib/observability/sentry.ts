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

import type { BrowserOptions, NodeOptions } from '@sentry/nextjs';

type BeforeSend = NonNullable<NodeOptions['beforeSend']>;
type BeforeBreadcrumb = NonNullable<NodeOptions['beforeBreadcrumb']>;
export type SentryErrorEvent = Parameters<BeforeSend>[0];
export type SentryBreadcrumb = Parameters<BeforeBreadcrumb>[0];

/** Drop everything after `?` / `#` — query strings can carry names or PIN params. */
function stripQuery(url: unknown): unknown {
  return typeof url === 'string' ? url.replace(/[?#].*$/, '') : url;
}

/**
 * Breadcrumb filter (browser + server). UI breadcrumbs are dropped outright: a
 * keypad tap records the clicked element's selector, so a PIN entry would leave
 * its digits in order in the trail. Console breadcrumbs are dropped because log
 * lines can carry operator names. URL-bearing ones lose their query string.
 */
export function scrubBreadcrumb(crumb: SentryBreadcrumb): SentryBreadcrumb | null {
  const category = crumb.category ?? '';
  if (category.startsWith('ui.') || category === 'console') return null;
  if (crumb.data) {
    for (const key of ['url', 'from', 'to']) {
      if (key in crumb.data) crumb.data[key] = stripQuery(crumb.data[key]);
    }
  }
  return crumb;
}

/**
 * The one scrubbing policy for every runtime (CLAUDE.md hard rule #8, ADR-0007,
 * ADR-0022 Amendment 1). GlitchTip must never receive PIN digits, operator names,
 * or request bodies.
 */
export const scrubEvent = ((event: SentryErrorEvent): SentryErrorEvent | null => {
  // Never report PIN-related data — drop the whole event.
  if (event.tags?.['has_pin']) return null;
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = event.request.url.replace(/[?#].*$/, '');
    if (event.request.headers) {
      delete event.request.headers['authorization'];
      delete event.request.headers['cookie'];
    }
  }
  // Only the opaque id survives: no username, email or IP.
  if (event.user) {
    if (event.user.id === undefined) delete event.user;
    else event.user = { id: event.user.id };
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.flatMap((b) => scrubBreadcrumb(b) ?? []);
  }
  return event;
}) satisfies BeforeSend;

/**
 * Browser `Sentry.init` options (src/instrumentation-client.ts). The DSN is
 * passed in because Next inlines `process.env.NEXT_PUBLIC_GLITCHTIP_DSN` only
 * where that DOTTED literal appears; it is baked at image BUILD time and must
 * name the PUBLIC host errors.barnardhq.com (ADR-0022 Amendment 1).
 */
export function browserInitOptions(dsn: string | undefined): BrowserOptions | null {
  if (!dsn) return null;
  return {
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env.DR3_BUILD_SHA ?? 'dev',
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}

/**
 * Shared server/edge `Sentry.init` options. Returns `null` when no DSN is
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
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeBreadcrumb: scrubBreadcrumb,
  };
}
