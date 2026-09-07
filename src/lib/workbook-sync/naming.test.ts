// ADR-0049 D5/D8 — naming/rollover + archival-key derivation tests.

import { describe, expect, it } from 'vitest';
import {
  fileNameMatchesPattern,
  resolveMonthlyFileName,
  resolveMonthlyFolderPath,
  yearMonthKeyFromFileName,
  matchMonthlyFileTolerant,
  folderPathHasUntokenisedMonth,
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

// ── ADR-0130 D9 / D10 ────────────────────────────────────────────────────────

/**
 * The seven real file names on the live Woodland drive, enumerated read-only
 * through the Graph transport on 2026-09-07 (ADR-0130 §4). FOUR of seven match
 * `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm` exactly. Four of seven is not a naming
 * convention; it is a coincidence that held four times.
 */
const LIVE = {
  march: 'MARCH_2026 DAILY LOG TEMPLATE WOODLAND.xlsm',
  april: 'APRIL 2026 DAILY LOG WOODLAND.xlsm',
  may: 'MAY 2026 DAILY LOG WOODLAND(1).xlsm',
  june: 'JUNE 2026 DAILY LOG WOODLAND.xlsm',
  july: 'JULY 2026 DAILY LOG WOODLAND.xlsm',
  august: 'AUGUST 2026 DAILY LOG WOODLAND.xlsm',
  september: 'SEPT 2026 DAILY LOG WOODLAND.xlsm',
};
const at = (iso: string) => new Date(iso);

describe('matchMonthlyFileTolerant (ADR-0130 D9)', () => {
  it('resolves SEPT against SEPTEMBER — the file that caused 337 failed polls', () => {
    // The live September file, 692,880 bytes, last modified 2026-09-04 10:40 PDT.
    // The floor had been filling it in all along; Vision ingested none of it.
    const r = matchMonthlyFileTolerant([LIVE.september], at('2026-09-15T19:00:00Z'));
    expect(r.matched).toBe(LIVE.september);
    expect(r.candidates).toEqual([LIVE.september]);
  });

  it('resolves the other two non-conforming months on the live drive', () => {
    // `_` instead of a space, plus an extra word ("TEMPLATE").
    expect(matchMonthlyFileTolerant([LIVE.march], at('2026-03-15T19:00:00Z')).matched).toBe(
      LIVE.march,
    );
    // A trailing `(1)` copy suffix.
    expect(matchMonthlyFileTolerant([LIVE.may], at('2026-05-15T19:00:00Z')).matched).toBe(LIVE.may);
  });

  it('still resolves the four months that always matched', () => {
    const cases: Array<[string, string]> = [
      [LIVE.april, '2026-04-15T19:00:00Z'],
      [LIVE.june, '2026-06-15T19:00:00Z'],
      [LIVE.july, '2026-07-15T19:00:00Z'],
      [LIVE.august, '2026-08-15T19:00:00Z'],
    ];
    for (const [name, iso] of cases) {
      expect(matchMonthlyFileTolerant([name], at(iso)).matched).toBe(name);
    }
  });

  it('ignores files for OTHER months in the same folder', () => {
    const all = Object.values(LIVE);
    const r = matchMonthlyFileTolerant(all, at('2026-09-15T19:00:00Z'));
    expect(r.matched).toBe(LIVE.september);
    expect(r.candidates).toEqual([LIVE.september]);
  });

  it('REFUSES when two candidates exist — never silently picks one', () => {
    // The exact hazard: a template and the real workbook, or a stray `(1)` copy
    // alongside the original. D9 says zero or more than one ⇒ not_found.
    const twoInSeptember = [LIVE.september, 'SEPTEMBER 2026 DAILY LOG WOODLAND.xlsm'];
    const r = matchMonthlyFileTolerant(twoInSeptember, at('2026-09-15T19:00:00Z'));
    expect(r.matched).toBeNull();
    expect(r.candidates.sort()).toEqual(twoInSeptember.sort());

    const templateAndReal = [
      'MARCH_2026 DAILY LOG TEMPLATE WOODLAND.xlsm',
      'MARCH 2026 DAILY LOG WOODLAND.xlsm',
    ];
    expect(
      matchMonthlyFileTolerant(templateAndReal, at('2026-03-15T19:00:00Z')).matched,
    ).toBeNull();
  });

  it('REFUSES on an empty folder', () => {
    const r = matchMonthlyFileTolerant([], at('2026-09-15T19:00:00Z'));
    expect(r.matched).toBeNull();
    expect(r.candidates).toEqual([]);
  });

  it('requires the YEAR — last September is not this September', () => {
    expect(
      matchMonthlyFileTolerant(['SEPT 2025 DAILY LOG WOODLAND.xlsm'], at('2026-09-15T19:00:00Z'))
        .matched,
    ).toBeNull();
  });

  it('requires .xlsm — a stray PDF or lock file is not a workbook', () => {
    const r = matchMonthlyFileTolerant(
      ['SEPT 2026 DAILY LOG WOODLAND.pdf', '~$SEPT 2026 DAILY LOG WOODLAND.xlsx'],
      at('2026-09-15T19:00:00Z'),
    );
    expect(r.matched).toBeNull();
  });

  it('matches a month token by PREFIX, not by substring anywhere in the name', () => {
    // "JUNK" must not satisfy JUNE, and a prefix must be at least three characters
    // — the standard month abbreviation length, and the length at which all twelve
    // month prefixes are still unique.
    expect(
      matchMonthlyFileTolerant(['JUNK 2026 DAILY LOG WOODLAND.xlsm'], at('2026-06-15T19:00:00Z'))
        .matched,
    ).toBeNull();
    expect(
      matchMonthlyFileTolerant(['JU 2026 DAILY LOG WOODLAND.xlsm'], at('2026-06-15T19:00:00Z'))
        .matched,
    ).toBeNull();
    expect(
      matchMonthlyFileTolerant(['JUN 2026 DAILY LOG WOODLAND.xlsm'], at('2026-06-15T19:00:00Z'))
        .matched,
    ).toBe('JUN 2026 DAILY LOG WOODLAND.xlsm');
  });

  it('is anchored on the PACIFIC month, like every other rollover in this module', () => {
    // 2026-10-01T02:00Z is still 2026-09-30 19:00 PDT — September's file, not
    // October's, or the 1st of every month would look for a file nobody made yet.
    expect(matchMonthlyFileTolerant([LIVE.september], at('2026-10-01T02:00:00Z')).matched).toBe(
      LIVE.september,
    );
  });
});

describe('folderPathHasUntokenisedMonth (ADR-0130 D10)', () => {
  it('flags the exact production value that broke September', () => {
    // The live row for site de9875a3-… still literally holds this. ADR-0102 §5
    // specified the tokenised form; the code shipped and the row never moved, so
    // on 2026-09-01 the file name rolled to SEPTEMBER and the folder stayed August.
    expect(
      folderPathHasUntokenisedMonth(
        'DR3/Woodland/Woodland Operations/2026 Daily Logs/August 2026 Woodland',
      ),
    ).toBe(true);
  });

  it('accepts the tokenised form ADR-0102 specified', () => {
    expect(
      folderPathHasUntokenisedMonth(
        'DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland',
      ),
    ).toBe(false);
  });

  it('accepts a path with no month at all — including the drive root', () => {
    expect(folderPathHasUntokenisedMonth('')).toBe(false);
    expect(folderPathHasUntokenisedMonth('DR3/Woodland/Daily Logs')).toBe(false);
  });

  it('matches a month name case-insensitively and as a whole word', () => {
    expect(folderPathHasUntokenisedMonth('DR3/august 2026 woodland')).toBe(true);
    // "Augusta" is a place, not a month — a substring match would reject a valid path.
    expect(folderPathHasUntokenisedMonth('DR3/Augusta Operations/Daily Logs')).toBe(false);
  });

  it('does not flag a path that already carries a token alongside a month word', () => {
    // If the operator tokenised it, the literal month is gone; but a mixed path with
    // ANY `{` token is treated as intentional — the guard is for the token-FREE case.
    expect(folderPathHasUntokenisedMonth('DR3/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR}')).toBe(false);
  });
});
