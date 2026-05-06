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

module.exports = withSerwist(nextConfig);
