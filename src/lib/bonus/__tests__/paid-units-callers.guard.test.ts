// ADR-0083 Amendment 1 — the guard that keeps "paid units are computed in ONE
// place" a control instead of a comment.
//
// ## Why prose was not enough — the defect that prompted this
//
// `paid-units.ts` opens by claiming that the on-screen grid, the signed PDF, the
// sign-time lock, the CSV export, the month list, the aggregates and the ADR-0033
// reconcile tripwire "all call `dailyPaidUnits`, so the number on the screen, the
// number on the signed PDF and the number the reconciler independently recomputes
// cannot diverge."
//
// That sentence was not true. `src/app/bonus/months/[id]/page.tsx` — the month
// detail page, which is the surface an admin unlocks a signed month FROM and
// reads the corrected total ON — computed its per-employee monthly totals and its
// read-only grid totals with `calculateDailyBonusCents(mattress_count, rule)`,
// bypassing the funnel entirely. It understated every processor's month by the
// whole cash value of their saves, and nothing said so: the number was
// well-formed, the page rendered, every test passed. It was found by reading the
// call sites, which is exactly the work this file now does on every run.
//
// So: every `calculateDailyBonusCents` call in `src/` outside the funnel and the
// calculator module itself must be listed below with a reason. Adding an entry is
// a DECISION — "this call site is measuring production quantity, not pay, and
// here is the token proving the compensating control is still in the file" — not
// a way to make a red test green.
//
// ## Three things that keep the guard itself honest
//
//   1. **It self-tests.** `flags a bare mattress_count call` runs the matcher
//      over fabricated source containing the exact defect above and asserts it is
//      caught. A guard nobody has seen fail is a guard nobody has evidence works.
//   2. **It asserts its own coverage.** A rename or a bad glob makes the scan
//      return nothing, and a scan of nothing has no violations — green while
//      measuring NOTHING. `inspects every known call site` pins the count.
//   3. **Its allowlist has teeth.** Every entry must still MATCH a real call
//      site (a stale entry pointing at a moved file fails rather than silently
//      widening the exemption) and carries a `mustContain` token.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SRC = join(REPO_ROOT, 'src');

const CALL_RE = /calculateDailyBonusCents\s*\(/g;

/** Files that DEFINE the primitive rather than consume it. */
const CORE_FILES = ['src/lib/bonus/calculator.ts', 'src/lib/bonus/paid-units.ts'] as const;

interface CallSite {
  file: string;
  /** 1-based line, so a failure names somewhere a human can go. */
  line: number;
}

/** Every `calculateDailyBonusCents(` call in one source string, comments removed. */
export function callSitesIn(file: string, src: string): CallSite[] {
  // Comments are stripped FIRST. Every call site in this repo documents itself
  // in a comment naming the function, and the ADR-0084 guard was already burned
  // once by matching its own documentation — a guard that reads the prose
  // explaining a token instead of the token is the "green while measuring
  // nothing" failure it exists to prevent.
  const code = stripComments(src);
  const out: CallSite[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL_RE.exec(code)) !== null) {
    out.push({ file, line: code.slice(0, m.index).split('\n').length });
  }
  return out;
}

/** Replaces comment bodies with blanks, preserving newlines so lines stay true. */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = i;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      i += 1;
      out += src.slice(start, i);
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.(test|spec)\.tsx?$/.test(name)) continue;
    acc.push(full);
  }
  return acc;
}

function scanRepo(): CallSite[] {
  return walk(SRC).flatMap((f) =>
    callSitesIn(relative(REPO_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The allowlist — DELIBERATE direct callers, each with its reason
// ─────────────────────────────────────────────────────────────────────────

interface Exception {
  file: string;
  /** Expected number of direct calls in that file. A new one fails the guard. */
  calls: number;
  why: string;
  /** Token whose presence in the FILE proves the compensating control survives. */
  mustContain: string;
}

const ALLOWLIST: Exception[] = [
  {
    file: 'src/lib/bonus/daily-report.ts',
    calls: 1,
    why:
      'PRODUCTION-QUANTITY path, not a pay path. The 8 PM report and the ' +
      'MTD/annual figures measure mattresses PROCESSED; adding saves would ' +
      'inflate a production number with units that were never torn down, and ' +
      'those numbers sit adjacent to MRC billing (ADR-0083 §"what this is not").',
    mustContain: 'calculateDailyBonusCents',
  },
  {
    file: 'src/app/bonus/DailyEntryGrid.tsx',
    calls: 2,
    why:
      'CLIENT-side live preview of an unsaved edit. It has raw input strings, ' +
      'not DB rows, so it cannot take the `DecimalLike` funnel — it sums the two ' +
      "columns itself and tiers ONCE, which is the funnel's policy inlined. The " +
      '`mustContain` token pins the summed shape: tiering the columns separately ' +
      'applies the 50-unit threshold twice and pays $0 for most real days.',
    mustContain: '(n ?? 0) + (sv ?? 0)',
  },
  {
    file: 'src/app/bonus/months/[id]/AmendmentPanel.tsx',
    calls: 2,
    why:
      'Same as DailyEntryGrid, for the amended-month editor (ADR-0083 ' +
      'Amendment 1). Raw input strings, summed then tiered once.',
    mustContain: '(n ?? 0) + (sv ?? 0)',
  },
];

// ─────────────────────────────────────────────────────────────────────────

describe('every bonus-cents computation goes through the paid-units funnel', () => {
  const sites = scanRepo();
  const outside = sites.filter((s) => !CORE_FILES.includes(s.file as (typeof CORE_FILES)[number]));

  it('inspects every known call site (a scan of nothing must not report green)', () => {
    // 4 in the calculator + paid-units, plus the 5 allowlisted. If this number
    // changes, the change is either a new call site (which the next test will
    // name) or a broken scan (which this one catches).
    expect(sites.length).toBe(9);
    expect(outside.length).toBe(5);
  });

  it('has no un-allowlisted direct caller', () => {
    const allowed = new Map(ALLOWLIST.map((e) => [e.file, e]));
    const violations = outside.filter((s) => !allowed.has(s.file));
    expect(
      violations.map((v) => `${v.file}:${v.line}`),
      'These call `calculateDailyBonusCents` directly instead of `dailyBonusCentsFor`/' +
        '`dailyPaidUnits`. If this is a PAY figure, it is under-paying by the value of ' +
        "the row's saves — switch it to the funnel. If it is genuinely a production " +
        'quantity, add it to ALLOWLIST in this file with the reason.',
    ).toEqual([]);
  });

  it('every allowlist entry still matches real code (no stale exemptions)', () => {
    for (const e of ALLOWLIST) {
      const hits = outside.filter((s) => s.file === e.file);
      expect(hits.length, `allowlist entry for ${e.file} matched ${hits.length} call sites`).toBe(
        e.calls,
      );
      const src = readFileSync(join(REPO_ROOT, e.file), 'utf8');
      expect(src.includes(e.mustContain), `${e.file} no longer contains "${e.mustContain}"`).toBe(
        true,
      );
    }
  });

  it('the month detail page uses the funnel (the defect this guard was written for)', () => {
    const src = readFileSync(join(REPO_ROOT, 'src/app/bonus/months/[id]/page.tsx'), 'utf8');
    const code = stripComments(src);
    expect(code).toContain('dailyBonusCentsFor(e, rule)');
    // And the specific shape that under-paid: a pay total off `mattress_count`.
    expect(code).not.toMatch(/calculateDailyBonusCents\s*\(\s*count\s*,/);
  });
});

describe('the guard itself goes red on the real defect', () => {
  it('flags a bare mattress_count call and ignores the funnel', () => {
    const defective = [
      "import { calculateDailyBonusCents } from '@/lib/bonus/calculator';",
      'const count = e.mattress_count.toNumber();',
      '// ADR-0083 — paid units are mattress_count + saves via calculateDailyBonusCents',
      'acc.totalBonusCents += calculateDailyBonusCents(count, rule);',
    ].join('\n');

    const found = callSitesIn('src/app/bonus/months/[id]/page.tsx', defective);
    // ONE, not two: the mention inside the comment on line 3 is not a call. A
    // guard that counted it would be matching its own documentation.
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(4);

    const clean = 'acc.totalBonusCents += dailyBonusCentsFor(e, rule);';
    expect(callSitesIn('x.ts', clean)).toEqual([]);
  });
});
