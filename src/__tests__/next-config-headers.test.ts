// ADR-0034 follow-up — survey-preview framing fix.
//
// The admin invite preview (src/app/admin/operations/intel/[campaignId]/
// InvitePreview.tsx) embeds the survey in a SAME-ORIGIN <iframe src="/survey/
// {token}?preview=1">. A global `X-Frame-Options: DENY` in next.config.js
// forbids ALL framing — including same-origin — so the survey would not render
// ("vision won't connect"). The fix: a more-specific `/survey/:path*` header
// block sets `X-Frame-Options: SAMEORIGIN` + appends `frame-ancestors 'self'`
// to the CSP, while a negative-lookahead global block keeps `DENY` on every
// other route.
//
// These tests assert the RESOLVED header semantics — not the intent — by
// (a) requiring the regexes Next compiles from each `source` to match/not-match
// the right paths, and (b) checking the header values per block. This is the
// regression guard the live emitted-header proof complements.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS config
const nextConfig = require('../../next.config.js');

interface HeaderEntry {
  key: string;
  value: string;
}
interface HeaderBlock {
  source: string;
  headers: HeaderEntry[];
}

function header(block: HeaderBlock | undefined, key: string): string | undefined {
  return block?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

// Mirror how Next anchors a `source` for matching. Next compiles each source
// with path-to-regexp anchored at both ends. For the two sources under test the
// bodies are already JS-regex-compatible (a `:path*` segment and a
// negative-lookahead group), so a faithful local anchoring is sufficient to
// assert the precedence semantics without pulling Next's internal compiler.
function matches(source: string, path: string): boolean {
  const body = source
    // `/:path*` (named catch-all) → match any remaining path, including empty.
    .replace(/\/:[a-zA-Z0-9_]+\*/g, '(?:/.*)?')
    // `/:param` (named segment) → one path segment.
    .replace(/\/:[a-zA-Z0-9_]+/g, '/[^/]+');
  return new RegExp(`^${body}/?$`).test(path);
}

describe('next.config.js header blocks (survey preview framing)', () => {
  // withSentryConfig/withSerwist wrap the config; headers() survives the wrap.
  const config = nextConfig.default ?? nextConfig;

  it('exposes an async headers() function', () => {
    expect(typeof config.headers).toBe('function');
  });

  it('resolves a SAMEORIGIN block for /survey and DENY for other routes', async () => {
    const blocks: HeaderBlock[] = await config.headers();

    const surveyBlock = blocks.find((b) => b.source.startsWith('/survey/'));
    const globalBlock = blocks.find((b) => b.source.includes('?!survey'));

    expect(surveyBlock, 'a /survey/:path* block must exist').toBeDefined();
    expect(globalBlock, 'a negative-lookahead global block must exist').toBeDefined();

    // Survey route: relaxed framing + frame-ancestors.
    expect(header(surveyBlock, 'X-Frame-Options')).toBe('SAMEORIGIN');
    expect(header(surveyBlock, 'Content-Security-Policy')).toContain("frame-ancestors 'self'");

    // Every other route: hard DENY, and NO frame-ancestors leniency.
    expect(header(globalBlock, 'X-Frame-Options')).toBe('DENY');
    expect(header(globalBlock, 'Content-Security-Policy')).not.toContain('frame-ancestors');
  });

  it('the survey block matches survey paths; the global block excludes them', async () => {
    const blocks: HeaderBlock[] = await config.headers();
    const surveyBlock = blocks.find((b) => b.source.startsWith('/survey/'))!;
    const globalBlock = blocks.find((b) => b.source.includes('?!survey'))!;

    const surveyPath = '/survey/98C2-H5B7DKWMQ8rNK9F_V2UbJjbtXpn';

    // The survey block applies SAMEORIGIN to the survey token path...
    expect(matches(surveyBlock.source, surveyPath)).toBe(true);
    // ...and the global DENY block must NOT also match it (else DENY leaks back
    // — Next emits a block per matching source).
    expect(matches(globalBlock.source, surveyPath)).toBe(false);

    // A normal route gets the global DENY block and not the survey block.
    expect(matches(globalBlock.source, '/login')).toBe(true);
    expect(matches(surveyBlock.source, '/login')).toBe(false);
  });

  it('the base CSP (sans frame-ancestors) and the survey CSP share identical directives', async () => {
    const blocks: HeaderBlock[] = await config.headers();
    const surveyCsp = header(
      blocks.find((b) => b.source.startsWith('/survey/')),
      'Content-Security-Policy',
    )!;
    const globalCsp = header(
      blocks.find((b) => b.source.includes('?!survey')),
      'Content-Security-Policy',
    )!;

    // The survey CSP must be the global CSP plus exactly one extra directive.
    expect(surveyCsp).toBe(`${globalCsp}; frame-ancestors 'self'`);
  });
});
