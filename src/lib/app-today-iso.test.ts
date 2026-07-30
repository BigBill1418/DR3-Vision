// ADR-0065 Amendment 2 — "today" is the PACIFIC day, everywhere.
//
// Six manager/admin client screens each derived today as
// `new Date().toISOString().slice(0, 10)`. `toISOString()` converts to UTC first,
// so from 5:00 PM Pacific — which is 00:00Z the NEXT day — every one of them
// defaulted its date input to TOMORROW. An evening entry silently landed on a
// production day that had not happened.
//
// The correct helper already existed and is documented "for client default
// values". The defect was six re-implementations, not a missing primitive. So this
// file asserts both halves: the helper is right, AND nobody re-rolls it.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { appTodayISO, pacificDayISO } from './time';

describe('appTodayISO — the Pacific calendar day', () => {
  it('returns YESTERDAY-in-UTC-terms during a Pacific evening', () => {
    // 2026-07-30 18:30 PDT === 2026-07-31T01:30Z. The UTC date is the 31st; the
    // Pacific day — the one an operator means by "today" — is the 30th.
    const evening = new Date('2026-07-31T01:30:00.000Z');
    expect(evening.toISOString().slice(0, 10)).toBe('2026-07-31'); // the old, wrong answer
    expect(appTodayISO(evening)).toBe('2026-07-30'); // the right one
  });

  it('agrees with pacificDayISO — one definition, not two', () => {
    for (const iso of [
      '2026-07-31T01:30:00.000Z', // evening PDT
      '2026-07-30T16:00:00.000Z', // morning PDT
      '2026-01-15T02:00:00.000Z', // evening PST
      '2026-11-01T08:30:00.000Z', // during the fall-back overlap
      '2026-03-08T10:30:00.000Z', // just after spring-forward
    ]) {
      const d = new Date(iso);
      expect(appTodayISO(d)).toBe(pacificDayISO(d));
    }
  });

  it('is a well-formed calendar day', () => {
    expect(appTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── The negative control ────────────────────────────────────────────────────
// A hand-written list of the six offending files would pass forever while a
// SEVENTH screen quietly reintroduced the bug. This walks the tree instead.

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

describe('no screen derives "today" from the UTC day', () => {
  it('finds zero occurrences of new Date().toISOString().slice(0, 10)', () => {
    // Comments are stripped first: the fix commit DOCUMENTS the banned pattern by
    // quoting it, and documentation explaining an anti-pattern is valuable. A guard
    // that fires on its own explanation would push people to delete the
    // explanation, which is the opposite of what it is for.
    const stripComments = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = walk('src/app')
      .filter((f) =>
        /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(
          stripComments(readFileSync(f, 'utf8')),
        ),
      )
      .map((f) => f.replace('src/app/', ''));

    expect(
      offenders,
      `These derive today from the UTC day, so after 5 PM Pacific they mean TOMORROW. ` +
        `Use appTodayISO() from @/lib/time.\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('stripping comments does not hide REAL code on the same line', () => {
    // The stripper must not swallow a live call that merely has a trailing
    // comment — otherwise the ban could be bypassed by adding one.
    const strip = (src: string): string =>
      src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const withTrailing = 'const d = new Date().toISOString().slice(0, 10); // today';
    expect(
      /new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(strip(withTrailing)),
    ).toBe(true);
    // …and it DOES ignore a whole-line comment that quotes the pattern.
    expect(strip('  // never write new Date().toISOString().slice(0, 10)').trim()).toBe('');
  });

  it('the guard actually works — it matches the pattern it bans', () => {
    // Without this, a typo in the regex would make the check above vacuously pass
    // and the ban would be decorative.
    const sample = 'const d = new Date().toISOString().slice(0, 10);';
    expect(/new Date\(\)\s*\.toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(sample)).toBe(
      true,
    );
  });
});
