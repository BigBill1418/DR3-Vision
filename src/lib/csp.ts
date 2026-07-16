// Content-Security-Policy builder (ADR-0053 D3). Pure and edge-safe — no imports,
// no env, no Node APIs — so it is importable from the edge middleware AND
// unit-testable without pulling NextAuth/Prisma (same pattern as public-paths.ts).
//
// The policy is single-sourced here so the middleware is the ONE place CSP is
// emitted. next.config.js no longer sets a CSP header (it would double-set and
// could not carry a per-request nonce); it keeps the non-CSP security headers
// (HSTS/nosniff/Referrer-Policy/Permissions-Policy) and the route-scoped
// X-Frame-Options DENY vs SAMEORIGIN distinction, which blanket every response
// including the static assets the CSP middleware matcher deliberately skips.

export interface CspOptions {
  /** Per-request base64 nonce that authorizes inline <script> tags. */
  nonce: string;
  /**
   * Survey routes only (ADR-0034 InvitePreview): the admin previews the survey
   * in a SAME-ORIGIN <iframe>, so those responses append `frame-ancestors 'self'`.
   * Every other route omits frame-ancestors and relies on X-Frame-Options: DENY
   * (still set in next.config.js) — preserving the pre-existing distinction.
   */
  allowSameOriginFraming?: boolean;
}

/**
 * Build the CSP header value for one request.
 *
 * script-src uses `'nonce-<nonce>' 'strict-dynamic'` and drops `'unsafe-inline'`
 * so an injected inline script cannot execute (ADR-0053 D3). `'strict-dynamic'`
 * lets Next's nonce-stamped bootstrap load the rest of the chunk graph while
 * ignoring host allowlists in CSP3 browsers; `'self'` is retained for older
 * browsers that ignore `'strict-dynamic'`. style-src keeps `'unsafe-inline'`
 * because Tailwind emits inline <style> — a far lower risk than inline script
 * (no code execution). All prior directives (R2 img/connect/frame-src, blob
 * media/worker, manifest) are preserved verbatim.
 */
export function buildCsp({ nonce, allowSameOriginFraming = false }: CspOptions): string {
  const directives = [
    "default-src 'self'",
    "img-src 'self' https://*.r2.cloudflarestorage.com data: blob:",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://*.r2.cloudflarestorage.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    // ADR-0046 Amendment 4 — inline AP attachment preview: the approver's browser
    // frames a presigned-GET PDF straight from R2 (Content-Disposition: inline).
    "frame-src 'self' https://*.r2.cloudflarestorage.com",
    // ADR-0053 D3 hardening additions.
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  if (allowSameOriginFraming) {
    directives.push("frame-ancestors 'self'");
  }
  return directives.join('; ');
}
