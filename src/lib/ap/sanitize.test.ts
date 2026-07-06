// ADR-0046 C10.2 — the mandatory sanitization regression test.
//
// Asserts the hostile fixture body renders INERT: none of the XSS vectors
// (script tag, onerror handler, iframe, javascript: URI, style url() vector)
// survive sanitization. This is the non-negotiable belt in "belt-and-suspenders"
// (the sandboxed iframe is the suspenders).

import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './sanitize';
import { SCRIPT_BEARING_HTML } from '@/lib/msgraph-mail';

describe('sanitizeEmailHtml — XSS inert-fixture regression (C10.2)', () => {
  const out = sanitizeEmailHtml(SCRIPT_BEARING_HTML);
  const lower = out.toLowerCase();

  it('strips <script> tags entirely (tag + body)', () => {
    expect(lower).not.toContain('<script');
    expect(lower).not.toContain('document.cookie');
    expect(lower).not.toContain('alert(');
  });

  it('strips onerror / onclick and every inline event handler', () => {
    expect(lower).not.toContain('onerror');
    expect(lower).not.toContain('onclick');
    expect(lower).not.toMatch(/on\w+\s*=/);
  });

  it('strips <iframe>', () => {
    expect(lower).not.toContain('<iframe');
  });

  it('strips javascript: URIs from href', () => {
    expect(lower).not.toContain('javascript:');
  });

  it('strips the style attribute (kills the url(javascript:) vector)', () => {
    expect(lower).not.toContain('style=');
    expect(lower).not.toContain('url(javascript');
  });

  it('strips inline <svg><script>', () => {
    expect(lower).not.toContain('<svg');
  });

  it('PRESERVES benign formatting (the invoice text + bold survive)', () => {
    expect(out).toContain('Acme Mattress Co');
    expect(lower).toContain('<b>');
  });

  it('hardens surviving links with rel=noopener + target=_blank when a safe href remains', () => {
    const safe = sanitizeEmailHtml('<a href="https://example.com/inv">invoice</a>');
    expect(safe).toContain('href="https://example.com/inv"');
    expect(safe).toContain('rel="noopener noreferrer nofollow"');
    expect(safe).toContain('target="_blank"');
  });

  it('returns empty string for null/empty input', () => {
    expect(sanitizeEmailHtml(null)).toBe('');
    expect(sanitizeEmailHtml(undefined)).toBe('');
    expect(sanitizeEmailHtml('')).toBe('');
  });
});
