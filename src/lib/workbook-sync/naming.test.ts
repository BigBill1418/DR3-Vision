// ADR-0049 D5/D8 — naming/rollover + archival-key derivation tests.

import { describe, expect, it } from 'vitest';
import { fileNameMatchesPattern, resolveMonthlyFileName, yearMonthKeyFromFileName } from './naming';

const PATTERN = '{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm';

describe('resolveMonthlyFileName (auto-rollover, D5)', () => {
  it('expands the current Pacific month', () => {
    // 2026-06-15T18:00Z → June 2026 (PDT).
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-06-15T18:00:00Z'))).toBe('JUNE 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('rolls to August on 8/1 without a config change (test-plan line 5)', () => {
    // 2026-08-01T12:00Z = 2026-08-01 05:00 PDT → still August in PT.
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-08-01T12:00:00Z'))).toBe('AUGUST 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('uses the Pacific month across a UTC month boundary', () => {
    // 2026-07-01T05:00Z = 2026-06-30 22:00 PDT → still JUNE in PT.
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-07-01T05:00:00Z'))).toBe('JUNE 2026 DAILY LOG WOODLAND.xlsm');
  });
});

describe('yearMonthKeyFromFileName / fileNameMatchesPattern (D8)', () => {
  it('derives the YYYY-MM key from a monthly file name', () => {
    expect(yearMonthKeyFromFileName(PATTERN, 'JUNE 2026 DAILY LOG WOODLAND.xlsm')).toBe('2026-06');
    expect(yearMonthKeyFromFileName(PATTERN, 'August 2026 Daily Log Woodland.xlsm')).toBe('2026-08');
  });

  it('rejects a non-matching name', () => {
    expect(yearMonthKeyFromFileName(PATTERN, 'random.xlsx')).toBeNull();
    expect(fileNameMatchesPattern(PATTERN, 'JUNE 2026 DAILY LOG WOODLAND.xlsm')).toBe(true);
    expect(fileNameMatchesPattern(PATTERN, 'notes.txt')).toBe(false);
  });
});
