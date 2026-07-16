// M4 — the AP decision amount input truncated comma currency: parseFloat('1,234.56')
// is 1, so a $1,234.56 invoice was filed to Great Plains as $1.00. parseUsdToCents
// strips US thousands separators, accepts plain/grouped amounts, and rejects the
// ambiguous input rather than silently coercing it.

import { describe, it, expect } from 'vitest';
import { parseUsdToCents } from './ApQueueClient';

describe('parseUsdToCents (M4 — comma-safe currency normalization)', () => {
  it('the regression: 1,234.56 → 123456 cents, NOT 100', () => {
    expect(parseUsdToCents('1,234.56')).toBe(123456);
  });

  it('handles plain, grouped, whole, and whitespace-padded amounts', () => {
    expect(parseUsdToCents('1234.56')).toBe(123456);
    expect(parseUsdToCents('1234')).toBe(123400);
    expect(parseUsdToCents('1,234')).toBe(123400);
    expect(parseUsdToCents('12,345,678.90')).toBe(1234567890);
    expect(parseUsdToCents('  99.99  ')).toBe(9999);
    expect(parseUsdToCents('0.05')).toBe(5);
  });

  it('rounds at the cent (half-up) without floating drift', () => {
    expect(parseUsdToCents('0.1')).toBe(10);
    expect(parseUsdToCents('19.99')).toBe(1999);
  });

  function err(v: string): string {
    const r = parseUsdToCents(v);
    expect(typeof r).not.toBe('number'); // must be a validation error, not a coercion
    return (r as { error: string }).error;
  }

  it('REJECTS a $-prefixed / symbol / lettered amount instead of silently coercing', () => {
    expect(err('$1,234.56')).toMatch(/no \$/i);
    expect(err('1234abc')).toBeTruthy();
    expect(err('1.2.3')).toBeTruthy();
    expect(err('1,23')).toBeTruthy(); // ambiguous grouping (not a valid US group)
    expect(err('')).toBeTruthy();
  });

  it('rejects more than two decimal places (cents are integer)', () => {
    expect(typeof parseUsdToCents('1.234')).not.toBe('number');
  });
});
