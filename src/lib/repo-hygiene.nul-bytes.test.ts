// ADR-0103 §5 — no tracked TEXT file may contain a literal NUL (0x00) byte.
//
// Why this is a test and not a style note: a NUL is valid UTF-8, so the compiler,
// the linter and every other test stay green. The damage is to TOOLING —
// `grep` and `ripgrep` classify a file containing NUL as BINARY and skip it
// SILENTLY, reporting zero hits rather than an error. `src/lib/mymrc/list-page.ts`
// (571 lines, 23 exports) answered `grep -c export` with 0 for as long as it held
// one, and `src/lib/equipment/import.ts` did the same. Every codebase-wide audit
// run against this repo in that window had a blind spot it could not report.
//
// Both were composite-key separators (`${a}` + NUL + `${b}`), which is a fine thing to
// want — the escape is byte-identical at runtime. The defect is writing the raw
// byte. This is trivially easy to re-introduce by hand (it happened THREE times
// while writing the ADR that documents it) and produces no feedback at all, which
// is exactly the shape of thing that has to be checked mechanically.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Real binaries live in the tree and are expected to contain NUL.
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

describe('repo hygiene — no literal NUL bytes in tracked text files (ADR-0103)', () => {
  it('every tracked text file is readable by grep', () => {
    const tracked = execFileSync('git', ['ls-files', '-z'], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

    // Guard the guard: if this ever reads an empty file list it would pass
    // vacuously, which is the failure mode this whole test exists to prevent.
    expect(tracked.length).toBeGreaterThan(500);

    const offenders = tracked.filter((f) => {
      if (BINARY_EXT.has(extname(f).toLowerCase())) return false;
      try {
        return readFileSync(f).includes(0x00);
      } catch {
        return false; // deleted/unreadable in this checkout — not our concern
      }
    });

    expect(
      offenders,
      `These tracked text files contain a literal NUL byte, so grep/ripgrep skip them SILENTLY.\n` +
        `Write control characters as escapes (\\u0000), never as raw bytes — the escape is\n` +
        `byte-identical at runtime. Offending files:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});
