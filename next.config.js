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
    // The base CSP applied to every route. The survey route reuses this EXACT
    // value and appends `frame-ancestors 'self'`, so an admin can preview the
    // survey inside a same-origin <iframe> (ADR-0034 InvitePreview). One source
    // array → the two CSPs can never drift.
    const baseCsp = [
      "default-src 'self'",
      "img-src 'self' https://*.r2.cloudflarestorage.com data: blob:",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https://*.r2.cloudflarestorage.com",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ];
    // Security headers shared by every route (everything except the
    // per-route CSP and X-Frame-Options, which differ for /survey).
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
        // preview iframe renders. `frame-ancestors 'self'` is appended to the
        // identical base CSP, and X-Frame-Options is relaxed to SAMEORIGIN.
        // (DENY forbids ALL framing — including same-origin — which is the bug
        // that broke "preview" in InvitePreview.tsx.)
        source: '/survey/:path*',
        headers: [
          ...sharedSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: [...baseCsp, "frame-ancestors 'self'"].join('; '),
          },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        ],
      },
      {
        // Every OTHER route keeps the hard `DENY`. The negative-lookahead
        // EXCLUDES `/survey` and `/survey/...` so Next never emits a second,
        // conflicting X-Frame-Options block on the survey route — Next emits a
        // header block for EVERY matching `source`, so the global matcher must
        // not also match /survey, or DENY would leak back onto it.
        source: '/((?!survey$|survey/).*)',
        headers: [
          ...sharedSecurityHeaders,
          {
            key: 'Content-Security-Policy',
            value: baseCsp.join('; '),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
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
