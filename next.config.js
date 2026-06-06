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
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "img-src 'self' https://*.r2.cloudflarestorage.com data: blob:",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "connect-src 'self' https://*.r2.cloudflarestorage.com",
              "media-src 'self' blob:",
              "worker-src 'self' blob:",
              "manifest-src 'self'",
            ].join('; '),
          },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
          },
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
