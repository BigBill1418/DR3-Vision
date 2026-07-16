// ADR-0053 D3 — CSP builder. Asserts the policy the middleware emits: a
// nonce+strict-dynamic script-src with NO 'unsafe-inline', the hardening
// directives, the preserved R2/blob/manifest directives, and the per-route
// frame-ancestors distinction (survey exception).

import { describe, it, expect } from 'vitest';
import { buildCsp } from '@/lib/csp';

// Extract one directive (everything up to the next `; `) by name.
function directive(csp: string, name: string): string | undefined {
  return csp
    .split('; ')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe('buildCsp (ADR-0053 D3)', () => {
  const NONCE = 'dGVzdC1ub25jZQ=='; // base64 sample
  const csp = buildCsp({ nonce: NONCE });

  it('nonce-protects scripts and drops unsafe-inline from script-src', () => {
    const scriptSrc = directive(csp, 'script-src')!;
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('keeps style-src unsafe-inline (Tailwind) — the documented lower-risk tradeoff', () => {
    expect(directive(csp, 'style-src')).toBe("style-src 'self' 'unsafe-inline'");
  });

  it('adds the D3 hardening directives', () => {
    expect(directive(csp, 'object-src')).toBe("object-src 'none'");
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(csp, 'form-action')).toBe("form-action 'self'");
  });

  it('preserves the pre-existing directives (R2 img/connect/frame-src, blob, manifest)', () => {
    expect(directive(csp, 'default-src')).toBe("default-src 'self'");
    expect(directive(csp, 'img-src')).toContain('https://*.r2.cloudflarestorage.com');
    expect(directive(csp, 'connect-src')).toContain('https://*.r2.cloudflarestorage.com');
    expect(directive(csp, 'frame-src')).toContain('https://*.r2.cloudflarestorage.com');
    expect(directive(csp, 'media-src')).toBe("media-src 'self' blob:");
    expect(directive(csp, 'worker-src')).toBe("worker-src 'self' blob:");
    expect(directive(csp, 'manifest-src')).toBe("manifest-src 'self'");
  });

  it('omits frame-ancestors by default and appends frame-ancestors self for survey', () => {
    expect(directive(csp, 'frame-ancestors')).toBeUndefined();
    const surveyCsp = buildCsp({ nonce: NONCE, allowSameOriginFraming: true });
    expect(directive(surveyCsp, 'frame-ancestors')).toBe("frame-ancestors 'self'");
    // Survey CSP is the base CSP plus exactly the one extra directive.
    expect(surveyCsp).toBe(`${csp}; frame-ancestors 'self'`);
  });
});
