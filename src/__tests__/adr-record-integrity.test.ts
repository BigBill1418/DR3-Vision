// ADR record integrity (ADR-0098; prescribed by ADR-0094 §5 P5).
//
// Two guards, deliberately different in strength:
//
//   1. CITATION RESOLVER — a HARD gate. Every `ADR-NNNN` / `Amendment N` reference
//      in the scanned trees must resolve to a real ADR file and section.
//   2. PROMISE REGISTRY — ADVISORY. Asserted here only for shape and honesty; the
//      coverage warning is emitted by CI, never by a failing test.
//
// The defect that motivates guard 1: five source files and one test carried the
// comment "ADR-0065 Amendment 2" for twelve days while no such amendment existed.
// The work was real and shipped; the record was not written. Nobody noticed,
// because the failure mode was silence.
//
// Every guard below also PROVES IT CAN FAIL against a fixture. Without that, a
// typo'd regex makes the whole file vacuously green — the same trap
// `app-today-iso.test.ts` documents about its own ban, and the same trap
// ADR-0094 §3 RC-4 describes about safety nets whose failure mode is silence.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkAdrCitations,
  collectAdrIndex,
  extractCitations,
  findDuplicateAdrNumbers,
  KNOWN_UNRESOLVED,
} from '../../scripts/check-adr-citations.mjs';
import {
  extractPromises,
  registeredAdrs,
  PROMISE_MARKERS,
} from '../../scripts/extract-adr-promises.mjs';

/**
 * Build a citation string WITHOUT writing the literal token in this file.
 *
 * The negative controls below need citations that deliberately do not resolve —
 * and this file is inside the tree the resolver scans, so writing them literally
 * would make the suite fail on its own fixtures. That is the trap
 * `app-today-iso.test.ts` names about its own ban: *a guard that punishes its own
 * documentation trains people to delete the documentation.*
 *
 * The alternative was an `ignore` pragma in the checker. Rejected: a bypass that
 * exists for tests exists for everyone, and the gate is only worth having if it
 * is absolute. Assembling the token at runtime keeps the scanner honest and costs
 * one helper.
 */
const cite = (n: string, amendment?: number) =>
  `ADR-${n}${amendment === undefined ? '' : ` Amendment ${amendment}`}`;

/** Build a throwaway repo: `docs/adr/*.md` plus a `src/` tree of code files. */
function fixture(adrFiles: Record<string, string>, codeFiles: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'adr-integrity-'));
  mkdirSync(join(root, 'docs', 'adr'), { recursive: true });
  for (const [name, body] of Object.entries(adrFiles)) {
    writeFileSync(join(root, 'docs', 'adr', name), body);
  }
  mkdirSync(join(root, 'src'), { recursive: true });
  for (const [name, body] of Object.entries(codeFiles)) {
    writeFileSync(join(root, 'src', name), body);
  }
  return root;
}

const check = (root: string) => checkAdrCitations({ repoRoot: root, scanDirs: ['src'] });

// ── 1. The live gate ─────────────────────────────────────────────────────────

describe('every ADR citation in the repo resolves', () => {
  it('has no unresolved citations outside the documented baseline', () => {
    const { violations } = checkAdrCitations({ repoRoot: process.cwd() });
    const rendered = violations.map((v) => `${v.file}:${v.line} — ${v.message}`).join('\n  ');
    expect(
      violations,
      `Unresolved ADR citation(s). A citation is a promise that a reason is written ` +
        `down; when it does not resolve, the next author cannot tell whether the ` +
        `constraint is real, superseded, or imagined. Either write the ADR/amendment ` +
        `or correct the citation.\n  ${rendered}`,
    ).toEqual([]);
  });

  it('carries no stale baseline entries — the baseline may only shrink', () => {
    const { staleBaseline } = checkAdrCitations({ repoRoot: process.cwd() });
    const rendered = staleBaseline.map((e) => `ADR-${e.adr} Amendment ${e.amendment}`).join(', ');
    expect(
      staleBaseline,
      `These KNOWN_UNRESOLVED entries no longer correspond to a real violation. ` +
        `Delete them from scripts/check-adr-citations.mjs — otherwise the baseline ` +
        `ossifies into a second OPEN-ITEMS.md.\n  ${rendered}`,
    ).toEqual([]);
  });

  it('every baselined entry has a row in the promise register', () => {
    // A tolerated violation with no handle is exactly the failure this work exists
    // to stop, so the escape hatch is itself tracked.
    const registered = registeredAdrs(join(process.cwd(), 'docs', 'adr', 'PROMISES.md'));
    for (const entry of KNOWN_UNRESOLVED) {
      expect(
        registered.has(entry.adr),
        `ADR-${entry.adr} is baselined in KNOWN_UNRESOLVED but has no row in docs/adr/PROMISES.md.`,
      ).toBe(true);
    }
  });
});

// ── 1b. The index is the other half of the record ────────────────────────────

describe('every ADR has a row in the index', () => {
  it('docs/adr/README.md lists every ADR file', () => {
    // Same defect class as a dangling citation, from the other end: an ADR that
    // exists but is not indexed is one nobody finds. When this was written,
    // ADR-0091, 0092, 0094, 0096 and all three 0019.x sub-ADRs were missing —
    // seven of the most recent records, including two floor incidents.
    const adrDir = join(process.cwd(), 'docs', 'adr');
    const readme = readFileSync(join(adrDir, 'README.md'), 'utf8');
    const missing = readdirSync(adrDir)
      .filter((f) => /^\d{4}(\.\d+)?[-.].*\.md$/.test(f))
      .map((f) => /^(\d{4}(?:\.\d+)?)/.exec(f)?.[1] ?? '')
      .filter((n) => n && !new RegExp(`^\\|\\s*${n.replace('.', '\\.')}\\s*\\|`, 'm').test(readme))
      // Separate amendment files are indexed under their parent's row.
      .filter((n, i, all) => all.indexOf(n) === i);

    expect(
      missing,
      `These ADRs have no row in docs/adr/README.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});

// ── 1c. Two ADRs must not claim one number ───────────────────────────────────

describe('no two ADRs claim the same number', () => {
  it('every ADR number has exactly one primary file', () => {
    const collisions = findDuplicateAdrNumbers(join(process.cwd(), 'docs', 'adr'));
    const rendered = collisions.map((c) => `ADR-${c.number}: ${c.files.join(' + ')}`).join('\n  ');
    expect(
      collisions,
      `Two ADRs claim one number, so a citation to it resolves to two different ` +
        `decisions — worse than resolving to none, because it looks correct. The ` +
        `number belongs to the first PUSHED reference; the later claim renumbers.\n  ${rendered}`,
    ).toEqual([]);
  });

  it('DETECTS a collision — two primary files on one number', () => {
    // This happened for real on 2026-08-11: ADR-0097 was claimed by two unrelated
    // PRs 19 seconds apart, both merged, and the checker stayed green because the
    // index MERGES files by number. That silence is what this test removes.
    const root = fixture(
      {
        '0097-a-citation-is-a-promise.md': '# ADR-0097 — one decision\n',
        '0097-a-page-that-heals.md': '# ADR-0097 — a different decision\n',
      },
      {},
    );
    const collisions = findDuplicateAdrNumbers(join(root, 'docs', 'adr'));
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.number).toBe('0097');
    expect(collisions[0]?.files).toHaveLength(2);
  });

  it('does NOT flag a parent plus its separate amendment files', () => {
    // The legitimate multi-file case. If this ever fires, the collision check
    // would red every ADR that uses the separate-amendment-file convention.
    const root = fixture(
      {
        '0069-bridge.md': '# ADR-0069 — the bridge\n',
        '0069-amendment-1-trailer.md': '# ADR-0069 Amendment 1 — trailers\n',
        '0069-amendment-2-terex.md': '# ADR-0069 Amendment 2 — TEREX\n',
      },
      {},
    );
    expect(findDuplicateAdrNumbers(join(root, 'docs', 'adr'))).toEqual([]);
  });
});

// ── 2. The resolver actually resolves ────────────────────────────────────────

describe('the citation resolver — proving it can fail', () => {
  it('flags an amendment that was never written', () => {
    const root = fixture(
      { '0065-gates.md': '# ADR-0065\n\n## Amendment 1 — a real one\n' },
      { 'a.ts': '// ADR-0065 Amendment 2 — the Pacific day, not the UTC day.\n' },
    );
    const { violations } = check(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('missing-amendment');
  });

  it('flags a citation to an ADR that does not exist at all', () => {
    const root = fixture(
      { '0065-gates.md': '# ADR-0065\n' },
      { 'a.ts': `// see ${cite('0999')}\n` },
    );
    const { violations } = check(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('missing-adr');
  });

  it('accepts a citation that resolves', () => {
    const root = fixture(
      { '0065-gates.md': '# ADR-0065\n\n## Amendment 1 — a real one\n' },
      { 'a.ts': '// ADR-0065 Amendment 1 and plain ADR-0065\n' },
    );
    expect(check(root).violations).toEqual([]);
  });

  it('REGRESSION: merges amendments recorded as SEPARATE FILES', () => {
    // The first draft of the indexer keyed one file per ADR number, so
    // `0069-amendment-2-*.md` overwrote `0069-*.md` and the amendment vanished.
    // That single bug produced 46 false violations against ADR-0067 and ADR-0069.
    // A gate that cries wolf gets switched off, so this case is locked down.
    const root = fixture(
      {
        '0069-bridge.md': '# ADR-0069 — the bridge\n\nNo amendments in this file.\n',
        '0069-amendment-2-terex.md': '# ADR-0069 Amendment 2 — TEREX absorption\n',
      },
      { 'a.ts': '// ADR-0069 Amendment 2 governs this\n' },
    );
    expect(check(root).violations).toEqual([]);
  });

  it('does not mistake an ADR *about* amendments for an amendment file', () => {
    // `0029-amendment-notification-batching.md` is an ADR whose SUBJECT is
    // amendments. Reading it as "ADR-0029 Amendment <n>" would silently accept a
    // citation to an amendment that does not exist.
    const root = fixture(
      { '0029-amendment-notification-batching.md': '# ADR-0029 — Amendment notification batching\n' },
      { 'a.ts': `// ${cite('0029', 1)}\n` },
    );
    expect(check(root).violations).toHaveLength(1);
  });

  it('reads both `Amendment N` and `Am.N` spellings', () => {
    expect(extractCitations('// ADR-0074 Am.1')[0]?.amendment).toBe(1);
    expect(extractCitations('// ADR-0074 Amendment 1')[0]?.amendment).toBe(1);
    expect(extractCitations('// ADR-0074')[0]?.amendment).toBeNull();
    expect(extractCitations('// ADR-0019.5 Am.1')[0]?.adr).toBe('0019.5');
  });

  it('indexes in-file amendment headings', () => {
    const root = fixture(
      { '0046-x.md': '# ADR-0046\n\n## Amendment 9 — the escape hatch (2026-07-29)\n' },
      {},
    );
    const entry = collectAdrIndex(join(root, 'docs', 'adr')).get('0046');
    expect(entry?.amendments.has(9)).toBe(true);
  });
});

// ── 3. The promise extractor ─────────────────────────────────────────────────

describe('the promise extractor — precision over recall, on purpose', () => {
  it('finds a forward commitment stated in prose', () => {
    const found = extractPromises(
      '- A stale-claim watchdog is the obvious follow-on and is **not** in this change.\n',
    );
    expect(found).toHaveLength(1);
  });

  it('ignores promises inside fenced code', () => {
    // A `TODO` in a code sample is documentation of code, not a commitment.
    expect(extractPromises('```ts\n// TODO: wire this up later in the sample\n```\n')).toEqual([]);
  });

  it('ignores promises inside blockquotes', () => {
    // A quoted promise belongs to whoever made it, not to the quoting ADR.
    expect(
      extractPromises('> This is deferred until the next sprint, said the other ADR.\n'),
    ).toEqual([]);
  });

  it('ignores a commitment that has already been closed', () => {
    expect(
      extractPromises('- The follow-up sweep this ADR deferred is now done, with evidence.\n'),
    ).toEqual([]);
  });

  it('does NOT treat a rollout flag as a promise', () => {
    // `gated on` was removed from the vocabulary after an audit: 6 hits, 6 false
    // positives. This locks the decision so it is not casually re-added.
    expect(PROMISE_MARKERS.some((m) => m.name === 'gated-on')).toBe(false);
    expect(
      extractPromises('The mint is gated on `ipad_dropoff` — the same surface as the write.\n'),
    ).toEqual([]);
  });

  it('reads ADR numbers out of the registry table', () => {
    const root = mkdtempSync(join(tmpdir(), 'adr-registry-'));
    const path = join(root, 'PROMISES.md');
    writeFileSync(path, '| P-01 | ADR-0068 | something | OPEN | note |\n');
    expect(registeredAdrs(path).has('0068')).toBe(true);
  });
});
