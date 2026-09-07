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
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
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

/** Substitute `{MONTH}` / `{MONTH_TITLE}` / `{YEAR}` for the Pacific month of `at`. */
function expandMonthTokens(pattern: string, at: Date): string {
  const { year, month0 } = pacificYearMonth(at);
  const upper = MONTHS_UPPER[month0]!;
  const title = upper.charAt(0) + upper.slice(1).toLowerCase();
  return pattern
    .replace(/\{MONTH\}/g, upper)
    .replace(/\{MONTH_TITLE\}/g, title)
    .replace(/\{YEAR\}/g, String(year));
}

/** Expand a naming pattern for the Pacific month containing `at` (D5). */
export function resolveMonthlyFileName(pattern: string, at: Date): string {
  return expandMonthTokens(pattern, at);
}

/**
 * Expand a FOLDER path for the Pacific month containing `at` (ADR-0102).
 *
 * D5 automated the file name on the assumption that every month's workbook lives
 * in one fixed folder. Woodland does not: each month has its own folder inside a
 * per-year folder —
 *
 *   `DR3/Woodland/Woodland Operations/{YEAR} Daily Logs/{MONTH_TITLE} {YEAR} Woodland`
 *
 * so a static `folder_path` is right for one month and then silently wrong. The
 * rollover has to cover the path or it is not a rollover.
 *
 * Same tokens and the same Pacific anchor as the file name, and callers pass the
 * SAME anchor to both — which is what makes the grace window (ADR-0049 Am.4 B1)
 * read the prior month's file out of the prior month's FOLDER rather than
 * hunting last month's name in this month's directory.
 *
 * A path with no tokens is returned unchanged, so every existing source — including
 * the empty string, meaning the drive root — behaves exactly as before.
 */
export function resolveMonthlyFolderPath(folderPattern: string, at: Date): string {
  return expandMonthTokens(folderPattern, at);
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
  const monthAlt = MONTHS_UPPER.map((m) => `${m}|${m.charAt(0)}${m.slice(1).toLowerCase()}`).join(
    '|',
  );
  // A named group may appear ONCE per regex — a pattern with two month tokens
  // (or {MONTH} + {MONTH_TITLE}) would be a SyntaxError at archive time. The
  // first month token captures; later ones match without capturing.
  let monthSeen = false;
  const monthGroup = (): string => {
    const g = monthSeen ? `(?:${monthAlt})` : `(?<month>${monthAlt})`;
    monthSeen = true;
    return g;
  };
  let yearSeen = false;
  const yearGroup = (): string => {
    const g = yearSeen ? '(?:\\d{4})' : '(?<year>\\d{4})';
    yearSeen = true;
    return g;
  };
  const src = escapeRegex(pattern)
    .replace(/\\\{MONTH\\\}|\\\{MONTH_TITLE\\\}/g, () => monthGroup())
    .replace(/\\\{YEAR\\\}/g, () => yearGroup());
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

// ────────────────────────────────────────────────────────────────────────────
// ADR-0130 D9 — the tolerant matcher
// ────────────────────────────────────────────────────────────────────────────
//
// An exact-name match against a human-named file is the wrong contract. Of the
// seven months on the live Woodland drive (enumerated read-only through the Graph
// transport, 2026-09-07), only FOUR match `{MONTH} {YEAR} DAILY LOG WOODLAND.xlsm`:
//
//   MARCH_2026 DAILY LOG TEMPLATE WOODLAND.xlsm   underscore + an extra word
//   APRIL 2026 DAILY LOG WOODLAND.xlsm            ok
//   MAY 2026 DAILY LOG WOODLAND(1).xlsm           a `(1)` copy suffix
//   JUNE / JULY / AUGUST …                        ok
//   SEPT 2026 DAILY LOG WOODLAND.xlsm             abbreviated month
//
// Four of seven is not a naming convention; it is a coincidence that held four
// times. `SEPT` is what cost 337 consecutive failed polls while the floor kept
// filling the file in.
//
// This is a SEPARATE function from `fileNameMatchesPattern` on purpose. That one
// is the STRICT pattern match and `archive.ts` uses it to decide which files in a
// folder are monthly workbooks worth archiving; loosening it there would change
// archival behaviour as a side effect of fixing discovery.

/** Minimum month-prefix length. All twelve 3-letter month prefixes are unique. */
const MIN_MONTH_PREFIX = 3;

/**
 * Normalise a file name for tolerant comparison: lowercase, `_` as a space, and a
 * trailing ` (n)` / `(n)` copy suffix removed from the stem.
 */
function normaliseForMatch(fileName: string): { stem: string; ext: string } {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  const ext = dot < 0 ? '' : trimmed.slice(dot).toLowerCase();
  const rawStem = dot < 0 ? trimmed : trimmed.slice(0, dot);
  const stem = rawStem
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, '') // ` (1)` / `(1)` copy suffix
    .replace(/_/g, ' ')
    .trim();
  return { stem, ext };
}

/** Alphanumeric tokens of a normalised stem. */
function tokens(stem: string): string[] {
  return stem.split(/[^a-z0-9]+/).filter(Boolean);
}

export interface TolerantMonthlyMatch {
  /** The single matching file name, or null when zero or more than one matched. */
  matched: string | null;
  /** Every candidate considered a match — 0, 1, or the ambiguous set. */
  candidates: string[];
}

/**
 * Find THE `.xlsm` in `fileNames` that is this month's workbook, tolerantly.
 *
 * A candidate is an `.xlsm` whose name carries the 4-digit year as a token AND a
 * token that is a prefix (>= 3 chars) of the month name — ignoring case, `_`, and a
 * trailing copy suffix. Matching a whole TOKEN rather than a substring is what keeps
 * `JUNK 2026 …` from satisfying June.
 *
 * Exactly one candidate ⇒ that file. Zero or more than one ⇒ `matched: null`, and
 * the caller reports `not_found` WITH the folder listing. Refusing on ambiguity is
 * the point: silently preferring one of `MARCH … TEMPLATE …` and `MARCH …` would
 * ingest a template into billing data.
 *
 * Anchored on the PACIFIC month of `at`, like every other rollover here.
 */
export function matchMonthlyFileTolerant(
  fileNames: readonly string[],
  at: Date,
): TolerantMonthlyMatch {
  const { year, month0 } = pacificYearMonth(at);
  const monthLower = MONTHS_UPPER[month0]!.toLowerCase();
  const yearToken = String(year);

  const candidates = fileNames.filter((name) => {
    const { stem, ext } = normaliseForMatch(name);
    if (ext !== '.xlsm') return false;
    const tk = tokens(stem);
    if (!tk.includes(yearToken)) return false;
    return tk.some(
      (t) =>
        t.length >= MIN_MONTH_PREFIX && t.length <= monthLower.length && monthLower.startsWith(t),
    );
  });

  return { matched: candidates.length === 1 ? candidates[0]! : null, candidates: [...candidates] };
}

// ────────────────────────────────────────────────────────────────────────────
// ADR-0130 D10 — the untokenised-folder guard
// ────────────────────────────────────────────────────────────────────────────

/**
 * True when `folderPath` names a month literally but carries no `{…}` token.
 *
 * That shape is a latent time-bomb: correct this month, silently wrong the next.
 * It is not hypothetical — the live Woodland row held
 * `…/2026 Daily Logs/August 2026 Woodland` with the month already expanded, so when
 * the file name rolled to SEPTEMBER on 2026-09-01 the transport went on asking for
 * September's file inside August's folder. ADR-0102 §5 specified the tokenised
 * value and `resolveMonthlyFolderPath` implements it correctly — a string with no
 * tokens simply comes back unchanged. The code shipped; the row never moved.
 *
 * Any `{` is treated as intentional tokenisation, so this only flags the fully
 * token-free case. Whole-word match so "Augusta Operations" is not a month.
 */
export function folderPathHasUntokenisedMonth(folderPath: string): boolean {
  if (folderPath.includes('{')) return false;
  const words = folderPath
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return MONTHS_UPPER.some((m) => words.includes(m.toLowerCase()));
}
