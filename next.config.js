/** @type {import('next').NextConfig} */
//
// PWA wrap intentionally omitted in T-001. Per ADR-0012 §4 the project moves
// from `next-pwa` (EOL, no Next.js 15 App Router support) to `@serwist/next`.
// The Service Worker source, runtime caching rules, and `withSerwist(...)`
// wrap land in T-009 (offline queue). For reference, the legacy runtime
// caching shape was:
//   - https://*.r2.cloudflarestorage.com  →  CacheFirst, 200 entries, 7d
//   - /api/(loads|sources|transporters|users)  →  NetworkFirst, 5s timeout, 5m
// Re-encode these as Serwist `RuntimeCaching` entries when wiring the SW.
//
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
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // photos can be ~5MB; allow some headroom
    },
  },
};

module.exports = nextConfig;
