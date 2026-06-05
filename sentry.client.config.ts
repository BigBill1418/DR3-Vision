// Sentry/GlitchTip browser-runtime init (ADR-0022 §2).
// Catches client-side React errors. No-ops cleanly when NEXT_PUBLIC_GLITCHTIP_DSN
// is unset (fail-open). The client cannot read server-only GLITCHTIP_DSN, so the
// browser DSN is exposed via the NEXT_PUBLIC_ prefix (a DSN is a write-only public
// ingest key — safe to ship to the browser, same as any Sentry web setup).
import * as Sentry from '@sentry/nextjs';

const dsn = process.env['NEXT_PUBLIC_GLITCHTIP_DSN'];
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    release: process.env['NEXT_PUBLIC_GIT_SHA'] ?? 'dev',
    tracesSampleRate: 0,
    beforeSend(event) {
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      if (event.user) {
        delete event.user.ip_address;
      }
      if (event.tags?.['has_pin']) return null;
      return event;
    },
  });
}
