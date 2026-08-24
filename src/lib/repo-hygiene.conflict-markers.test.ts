// Repo hygiene — no tracked file may contain a git conflict marker.
//
// Why this is a test and not a code-review habit: this repo has committed
// conflict markers TWICE in one week. Markers survive review because nothing
// else complains about them. In Markdown and SQL they are just text, so the
// docs gates, the ADR citation resolver and every other check stay green; in
// TypeScript `tsc` does fail, but only if the marked file is inside the
// compiled project — and it names a syntax error at a line number, not "you
// committed a merge conflict", which reads as an unrelated breakage.
//
// The check is deliberately narrow. It looks for the OPENING (`<` x7) and
// CLOSING (`>` x7) markers only, and NOT the bare `=` x7 divider: a run of
// seven `=` on its own line is a legitimate Markdown setext heading underline,
// and this repo is mostly Markdown. Every git conflict — merge, rebase,
// cherry-pick, diff3 or not — writes the opener and the closer, so the pair is
// sufficient without the false-positive surface of the divider.
//
// This file builds the marker strings with `repeat()` rather than writing them
// out, so its own source contains no marker and it can honestly scan itself.
// A detector that has to be excluded from its own sweep is one edit away from
// being excluded from a real one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Same list as repo-hygiene.nul-bytes.test.ts — real binaries live in the tree
// and may contain any byte sequence at all.
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.xlsx',
  '.xlsm',
  '.xls',
  '.zip',
  '.gz',
  '.tgz',
  '.mp4',
  '.webm',
  '.avif',
  '.bin',
  '.node',
]);

const OPEN = '<'.repeat(7);
const CLOSE = '>'.repeat(7);

/** Line-anchored marker, followed by a space or the end of the line. */
const MARKER = new RegExp(String.raw`^(${OPEN}|${CLOSE})( |$)`, 'm');

function markerLines(text: string): string[] {
  return text.split('\n').filter((l) => MARKER.test(l));
}

describe('repo hygiene — no conflict markers in tracked files', () => {
  it('detects a marker when there is one (the guard is falsifiable)', () => {
    // Without this, a broken regex would make the sweep below pass on every
    // repo forever, including one full of markers.
    expect(markerLines(`a\n${OPEN} HEAD\nb\n`)).toEqual([`${OPEN} HEAD`]);
    expect(markerLines(`a\n${CLOSE} feat/x\nb\n`)).toEqual([`${CLOSE} feat/x`]);
    expect(markerLines(`${OPEN}\n${CLOSE}\n`)).toEqual([OPEN, CLOSE]);

    // ...and stays quiet on the things that legitimately look like one.
    expect(markerLines('Heading\n=======\n\n| a | b |\n')).toEqual([]);
    expect(markerLines(`const shift = a ${OPEN.slice(0, 2)} 3;\n`)).toEqual([]);
    expect(markerLines(`x ${OPEN} y\n`)).toEqual([]); // not at line start
  });

  it('no tracked file carries one', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

    // Guard the guard: an empty file list would pass vacuously, which is the
    // failure mode this whole test exists to prevent.
    expect(tracked.length).toBeGreaterThan(500);

    const offenders: string[] = [];
    for (const f of tracked) {
      if (BINARY_EXT.has(extname(f).toLowerCase())) continue;
      let text: string;
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue; // deleted/unreadable in this checkout — not our concern
      }
      for (const line of markerLines(text)) offenders.push(`${f}: ${line}`);
    }

    expect(
      offenders,
      `These tracked files contain a git conflict marker. A conflict was resolved\n` +
        `by staging the conflicted file instead of the resolution — re-resolve and\n` +
        `re-commit; do not delete the marker lines and leave both sides in place.\n` +
        `Offending lines:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
