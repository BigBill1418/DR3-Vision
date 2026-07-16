// Deploy identity (ADR: alerts show the real sha, never package.json 0.1.0).
// Read ONCE at config-eval time — no runtime fs, edge-safe by construction.
let dr3BuildInfo = { sha: 'dev', builtAt: 'unknown' };
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  dr3BuildInfo = JSON.parse(require('node:fs').readFileSync('.build-info.json', 'utf8'));
} catch {
  /* dev / CI without the baked file */
}

/* eslint-disable @typescript-eslint/no-require-imports -- this is a CommonJS Next
   config file; `require()` is the correct (and only) way to load the @serwist/next
   and @sentry/nextjs config wrappers here. */
/** @type {import('next').NextConfig} */
//
// Service Worker is wired via `@serwist/next`. SW source lives at
// `src/app/sw.ts` (per ADR-0006 + ADR-0012 §4 — Serwist replaces the
// EOL `next-pwa`). Disabled in dev because injectManifest churn
// + HMR is noisy and the offline path is e2e-tested in production
// builds only.
//
const withSerwist = require('@serwist/next').default({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  cacheOnNavigation: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig = {
  env: {
    DR3_BUILD_SHA: dr3BuildInfo.sha,
    DR3_BUILD_AT: dr3BuildInfo.builtAt,
  },
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  // Node-only packages that must NOT be bundled by webpack (pino's worker-thread
  // transport; the OpenTelemetry NodeSDK tree, which pulls @grpc/grpc-js → native
  // stream/fs/tls/net). serverExternalPackages externalizes them on the Node
  // server build AND traces them into the standalone output. It does NOT apply to
  // the edge runtime — which is correct: the OTel imports in instrumentation.ts
  // carry a `webpackIgnore: true` magic comment so webpack never tries to bundle
  // them on edge (they're runtime-guarded to nodejs and never execute on edge),
  // while the edge Sentry SDK gets to bundle @opentelemetry/api normally (it is
  // edge-safe — externalizing it there caused "Native module not found").
  serverExternalPackages: [
    'pino',
    'pino-pretty',
    '@opentelemetry/sdk-node',
    '@opentelemetry/auto-instrumentations-node',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/sdk-trace-node',
    '@opentelemetry/resources',
    '@opentelemetry/semantic-conventions',
  ],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.r2.cloudflarestorage.com' },
      { protocol: 'https', hostname: 'photos.dr3-vision.svdp.us' },
      { protocol: 'https', hostname: 'photos-dev.dr3-vision.svdp.us' },
    ],
  },
  async headers() {
    // NOTE (ADR-0053 D3): the Content-Security-Policy is NO LONGER set here — it
    // moved to src/middleware.ts so it can carry a per-request nonce (dropping
    // `script-src 'unsafe-inline'`). Setting it here too would double-set it and
    // could not be nonced. next.config.js keeps only the NON-CSP security headers
    // and the route-scoped X-Frame-Options distinction, which blanket EVERY
    // response — including the static assets the CSP middleware matcher skips.
    // The survey same-origin framing exception now lives in two agreeing places:
    // X-Frame-Options: SAMEORIGIN here, and `frame-ancestors 'self'` in the
    // middleware CSP (see @/lib/csp).
    //
    // Security headers shared by every route (everything except the per-route
    // X-Frame-Options, which differs for /survey).
    const sharedSecurityHeaders = [
      {
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(self), microphone=(self), geolocation=()',
      },
    ];

    return [
      {
        // Survey route ONLY: allow SAME-ORIGIN framing so the admin invite
        // preview iframe renders. X-Frame-Options is relaxed to SAMEORIGIN (and
        // the middleware CSP appends `frame-ancestors 'self'` on the same paths).
        // (DENY forbids ALL framing — including same-origin — which is the bug
        // that broke "preview" in InvitePreview.tsx.)
        source: '/survey/:path*',
        headers: [...sharedSecurityHeaders, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }],
      },
      {
        // Every OTHER route keeps the hard `DENY`. The negative-lookahead
        // EXCLUDES `/survey` and `/survey/...` so Next never emits a second,
        // conflicting X-Frame-Options block on the survey route — Next emits a
        // header block for EVERY matching `source`, so the global matcher must
        // not also match /survey, or DENY would leak back onto it.
        source: '/((?!survey$|survey/).*)',
        headers: [...sharedSecurityHeaders, { key: 'X-Frame-Options', value: 'DENY' }],
      },
      {
        // SW must NOT be cached at the edge — bumped versions need to
        // reach the iPad on next page load. Per Serwist + Workbox
        // convention.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // photos can be ~5MB; allow some headroom
    },
  },
};

// Sentry/GlitchTip (ADR-0022 §2). The bundler plugin injects the release and
// (when GLITCHTIP_AUTH_TOKEN is set) uploads source maps so GlitchTip stack
// traces are readable. Without the token, source-map upload is skipped silently —
// the build still succeeds. The SDK itself no-ops at runtime without a DSN.
const { withSentryConfig } = require('@sentry/nextjs');

const hasSentryAuth = Boolean(process.env.GLITCHTIP_AUTH_TOKEN);

module.exports = withSentryConfig(withSerwist(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.GLITCHTIP_AUTH_TOKEN,
  // GlitchTip ingest host for source-map upload (Sentry CLI). Unused when
  // source-map upload is disabled.
  sentryUrl: process.env.GLITCHTIP_URL || 'https://glitchtip.barnardhq.com',
  silent: true,
  telemetry: false,
  sourcemaps: { disable: !hasSentryAuth },
  widenClientFileUpload: false,
  webpack: {
    // Strip Sentry debug logging from the bundle (replaces deprecated disableLogger).
    treeshake: { removeDebugLogging: true },
    // We register Sentry manually in instrumentation.ts; don't let the plugin
    // auto-inject a second server instrumentation path.
    autoInstrumentServerFunctions: false,
  },
});
