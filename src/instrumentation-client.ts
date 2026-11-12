// Sentry/GlitchTip browser-runtime init (ADR-0022 §2, Amendment 1). Next 15.3+
// loads this file natively before the app's client code; @sentry/nextjs 10
// deprecates the old `sentry.client.config.ts` injection in its favour.
//
// The DSN is baked at image BUILD time (Dockerfile ARG ← compose build.args ←
// the CHAD-side compose `.env`) and must name the PUBLIC ingest host
// errors.barnardhq.com — the tablets cannot reach the WireGuard-private one. A
// DSN is a write-only public ingest key, safe in the browser. Unset (local dev,
// CI) ⇒ no init: Sentry stays a no-op (fail-open).
//
// The env read must stay a LITERAL `process.env.NEXT_PUBLIC_GLITCHTIP_DSN` in this
// file: Next inlines that literal at build time, and a dynamic lookup would not
// be. (Next 15.5 also inlined the old bracket form — proven by build 2026-11-11;
// dotted matches src/lib/build-info.ts.) `npm run check:browser-dsn` after
// `next build` proves the bake.
import * as Sentry from '@sentry/nextjs';
import { browserInitOptions } from '@/lib/observability/sentry';

const options = browserInitOptions(process.env.NEXT_PUBLIC_GLITCHTIP_DSN);
if (options) {
  Sentry.init(options);
}

// Required by @sentry/nextjs 10 for App Router navigation instrumentation (the
// build warns without it). tracesSampleRate is 0, so this records no spans; it is
// a no-op when Sentry was not initialised.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
