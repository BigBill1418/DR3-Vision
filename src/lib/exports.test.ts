// audit 2026-07-16 · CSV — formula-injection guard in escapeCsvField, plus the
// pre-existing RFC-4180 behavior it must not regress. One fix covers every
// finance export (mrc / svdp / bonus-annual / variance) because they all render
// through escapeCsvField → toCsv.

import { describe, it, expect } from 'vitest';
import { escapeCsvField, toCsv } from './exports';

describe('escapeCsvField — CSV formula-injection guard', () => {
  it('prefixes a leading =,+,-,@ (or tab/CR) with a single quote so Excel treats it as text', () => {
    // Contains comma + quotes → prefixed AND RFC-4180 quoted (quotes doubled).
    expect(escapeCsvField('=HYPERLINK("http://evil","x")')).toBe(
      `"'=HYPERLINK(""http://evil"",""x"")"`,
    );
    // No comma/quote/CR/LF → prefixed only, no surrounding quotes.
    expect(escapeCsvField('@SUM(A1:A9)')).toBe(`'@SUM(A1:A9)`);
    expect(escapeCsvField('+1')).toBe(`'+1`);
    expect(escapeCsvField('-1')).toBe(`'-1`);
    expect(escapeCsvField('\ttabby')).toBe(`'\ttabby`);
  });

  it('neutralizes a numeric-typed negative (String(-1)) the same way', () => {
    expect(escapeCsvField(-1)).toBe(`'-1`);
  });

  it('leaves safe leading characters untouched', () => {
    expect(escapeCsvField('DR3 Woodland')).toBe('DR3 Woodland');
    expect(escapeCsvField('2026-07-16')).toBe('2026-07-16');
    expect(escapeCsvField(441)).toBe('441');
    expect(escapeCsvField('BOL-4471')).toBe('BOL-4471'); // '-' only guarded at position 0
  });

  it('still does RFC-4180 quoting for comma/quote/CR/LF and doubles quotes', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
    expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
    expect(escapeCsvField('')).toBe('');
  });

  it('toCsv carries the guard into a full export row', () => {
    const csv = toCsv([{ Transporter: '=cmd|calc' }], ['Transporter']);
    expect(csv).toContain(`'=cmd|calc`);
  });
});
