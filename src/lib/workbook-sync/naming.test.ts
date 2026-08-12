// ADR-0049 D5/D8 — naming/rollover + archival-key derivation tests.

import { describe, expect, it } from 'vitest';
import {
  fileNameMatchesPattern,
  resolveMonthlyFileName,
  resolveMonthlyFolderPath,
  yearMonthKeyFromFileName,
} from './naming';

const PATTERN = '{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm';

// ── ADR-0102 — the FOLDER rolls over too ────────────────────────────────────
//
// D5 automated the file NAME and stopped there, on the assumption that every
// month's workbook sits in one fixed folder. Woodland does not work that way:
//
//   DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland/
//       AUGUST 2026 DAILY LOG WOODLAND.xlsm
//
// Both path segments carry the month or the year, so a static `folder_path`
// is correct for at most one month and then silently wrong — a `not_found`
// every 1st, forever, phrased as if the FILE had been renamed.
const FOLDER = 'DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland';

describe('resolveMonthlyFolderPath (folder rollover, ADR-0102)', () => {
  it('expands month and year tokens in a path, title-case for folder segments', () => {
    expect(resolveMonthlyFolderPath(FOLDER, new Date('2026-08-12T18:00:00Z'))).toBe(
      'DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland',
    );
  });

  it('rolls the folder to September on 9/1 with no config change', () => {
    expect(resolveMonthlyFolderPath(FOLDER, new Date('2026-09-01T12:00:00Z'))).toBe(
      'DR3/Woodland/Woodland Operations/2026 Daily Logs/September 2026 Woodland',
    );
  });

  it('rolls the YEAR segment too, so 1 January does not strand the sync', () => {
    // Both `{YEAR}` occurrences move together — the year folder and the month
    // folder. A pattern that templated only the month would look for
    // "2026 Daily Logs/January 2027 Woodland", which does not exist.
    expect(resolveMonthlyFolderPath(FOLDER, new Date('2027-01-05T12:00:00Z'))).toBe(
      'DR3/Woodland/Woodland Operations/2027 Daily Logs/January 2027 Woodland',
    );
  });

  it('leaves a token-free path exactly as configured', () => {
    // Every source that legitimately uses one fixed folder must be untouched,
    // including the empty string (drive root).
    expect(resolveMonthlyFolderPath('', new Date('2026-08-12T18:00:00Z'))).toBe('');
    expect(resolveMonthlyFolderPath('Shared/Logs', new Date('2026-08-12T18:00:00Z'))).toBe(
      'Shared/Logs',
    );
  });

  it('anchors on PACIFIC, not UTC — an evening poll on the 31st stays in the old month', () => {
    // 2026-08-01T02:00Z is 2026-07-31 19:00 PDT. The floor is still working
    // July's book; resolving August's folder would read the wrong month.
    expect(resolveMonthlyFolderPath(FOLDER, new Date('2026-08-01T02:00:00Z'))).toBe(
      'DR3/Woodland/Woodland Operations/2026 Daily Logs/July 2026 Woodland',
    );
  });
});

describe('resolveMonthlyFileName (auto-rollover, D5)', () => {
  it('expands the current Pacific month', () => {
    // 2026-06-15T18:00Z → June 2026 (PDT).
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-06-15T18:00:00Z'))).toBe(
      'JUNE 2026 DAILY LOG WOODLAND.xlsm',
    );
  });

  it('rolls to August on 8/1 without a config change (test-plan line 5)', () => {
    // 2026-08-01T12:00Z = 2026-08-01 05:00 PDT → still August in PT.
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-08-01T12:00:00Z'))).toBe(
      'AUGUST 2026 DAILY LOG WOODLAND.xlsm',
    );
  });

  it('uses the Pacific month across a UTC month boundary', () => {
    // 2026-07-01T05:00Z = 2026-06-30 22:00 PDT → still JUNE in PT.
    expect(resolveMonthlyFileName(PATTERN, new Date('2026-07-01T05:00:00Z'))).toBe(
      'JUNE 2026 DAILY LOG WOODLAND.xlsm',
    );
  });
});

describe('yearMonthKeyFromFileName / fileNameMatchesPattern (D8)', () => {
  it('derives the YYYY-MM key from a monthly file name', () => {
    expect(yearMonthKeyFromFileName(PATTERN, 'JUNE 2026 DAILY LOG WOODLAND.xlsm')).toBe('2026-06');
    expect(yearMonthKeyFromFileName(PATTERN, 'August 2026 Daily Log Woodland.xlsm')).toBe(
      '2026-08',
    );
  });

  it('rejects a non-matching name', () => {
    expect(yearMonthKeyFromFileName(PATTERN, 'random.xlsx')).toBeNull();
    expect(fileNameMatchesPattern(PATTERN, 'JUNE 2026 DAILY LOG WOODLAND.xlsm')).toBe(true);
    expect(fileNameMatchesPattern(PATTERN, 'notes.txt')).toBe(false);
  });
});
