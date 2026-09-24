// ADR-0138 — the "who counted" sentence and the name validator.
import { describe, it, expect } from 'vitest';
import { CountPersonName, formatCountAttribution } from './count-attribution';

describe('formatCountAttribution', () => {
  it('counter + confirmer + a different enterer', () => {
    expect(
      formatCountAttribution({
        countedBy: 'Chris R',
        confirmedBy: 'Patrick D',
        enteredBy: 'Bill Barnard',
      }),
    ).toBe('Chris R, confirmed by Patrick D · entered by Bill Barnard');
  });

  it('counter who entered it themselves', () => {
    expect(
      formatCountAttribution({
        countedBy: 'Janette Tomas',
        confirmedBy: null,
        enteredBy: 'Janette Tomas',
      }),
    ).toBe('Janette Tomas');
  });

  it('counter with no known enterer', () => {
    expect(
      formatCountAttribution({ countedBy: 'Chris R', confirmedBy: null, enteredBy: null }),
    ).toBe('Chris R');
  });

  it('never presents the enterer as the counter when no counter was captured', () => {
    const line = formatCountAttribution({
      countedBy: null,
      confirmedBy: 'X',
      enteredBy: 'Bill Barnard',
    });
    expect(line).toBe('Not recorded · entered by Bill Barnard');
    expect(line).not.toBe('Bill Barnard');
  });

  it('blank strings are treated as absent', () => {
    expect(formatCountAttribution({ countedBy: '  ', confirmedBy: ' ', enteredBy: '' })).toBeNull();
  });
});

describe('CountPersonName', () => {
  it('trims', () => expect(CountPersonName.parse('  Chris R ')).toBe('Chris R'));
  it('refuses empty / whitespace', () => {
    expect(CountPersonName.safeParse('').success).toBe(false);
    expect(CountPersonName.safeParse('   ').success).toBe(false);
  });
  it('refuses control characters and over-long input', () => {
    expect(CountPersonName.safeParse('Chris\nR').success).toBe(false);
    expect(CountPersonName.safeParse('x'.repeat(81)).success).toBe(false);
  });
});
