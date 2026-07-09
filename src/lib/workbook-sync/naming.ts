// ADR-0049 D5 — monthly file-name resolution (auto-rollover).
//
// The sync discovers the current month's file each poll by expanding the source's
// naming pattern against the current Pacific wall-clock month. On 8/1 the same
// pattern resolves August's file WITHOUT a config change — the rollover is
// automatic (test-plan line 5). A possibly-empty file on the 1st of a new month is
// a `not_found` no-op, not an error (the parser + transport both tolerate it).
//
// Tokens: `{MONTH}` → uppercase English month name (JANUARY…DECEMBER),
//         `{MONTH_TITLE}` → title-case (June), `{YEAR}` → 4-digit year.

const MONTHS_UPPER = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

const PT_YM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'numeric',
});

/** { year, month0 } for `at` in the Pacific zone (month0 is 0-based). */
export function pacificYearMonth(at: Date): { year: number; month0: number } {
  const parts = PT_YM.formatToParts(at);
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? '1970');
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  return { year, month0: month - 1 };
}

/** Expand a naming pattern for the Pacific month containing `at` (D5). */
export function resolveMonthlyFileName(pattern: string, at: Date): string {
  const { year, month0 } = pacificYearMonth(at);
  const upper = MONTHS_UPPER[month0]!;
  const title = upper.charAt(0) + upper.slice(1).toLowerCase();
  return pattern
    .replace(/\{MONTH\}/g, upper)
    .replace(/\{MONTH_TITLE\}/g, title)
    .replace(/\{YEAR\}/g, String(year));
}

/** `YYYY-MM` archival key segment for the Pacific month containing `at` (D8). */
export function pacificYearMonthKey(at: Date): string {
  const { year, month0 } = pacificYearMonth(at);
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a naming pattern into a case-insensitive regex that captures the month
 * name + year. Used by archival (D8) to enumerate every monthly file in the folder
 * and derive its `YYYY-MM` key from the file name.
 */
function patternRegex(pattern: string): RegExp {
  const monthAlt = MONTHS_UPPER.map((m) => `${m}|${m.charAt(0)}${m.slice(1).toLowerCase()}`).join('|');
  const src = escapeRegex(pattern)
    .replace(/\\\{MONTH\\\}/g, `(?<month>${monthAlt})`)
    .replace(/\\\{MONTH_TITLE\\\}/g, `(?<month>${monthAlt})`)
    .replace(/\\\{YEAR\\\}/g, '(?<year>\\d{4})');
  return new RegExp(`^${src}$`, 'i');
}

/** `YYYY-MM` for a monthly file name matching `pattern`, else null (D8). */
export function yearMonthKeyFromFileName(pattern: string, fileName: string): string | null {
  const m = patternRegex(pattern).exec(fileName.trim());
  const monthName = m?.groups?.['month'];
  const year = m?.groups?.['year'];
  if (!monthName || !year) return null;
  const month0 = MONTHS_UPPER.indexOf(monthName.toUpperCase());
  if (month0 < 0) return null;
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

/** True when `fileName` is a monthly file for `pattern` (any month/year). */
export function fileNameMatchesPattern(pattern: string, fileName: string): boolean {
  return yearMonthKeyFromFileName(pattern, fileName) !== null;
}
