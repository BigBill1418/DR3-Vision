import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { invariantModulesOnDisk } from './colocation.guard.test';

// The suite DIAGNOSES production; it never repairs it. That is a promise, and a
// promise with no mechanism is the thing this whole module exists to complain
// about — so here is the mechanism.
//
// It is a source scan rather than a type-level seam because the one function the
// checks must call (`onHand`) binds the shared Prisma singleton internally, so
// there is no client to narrow. A scan is weaker than a type, and it is honest
// about which: it catches a write VERB, not a write reached through an alias.

const LIB = join(process.cwd(), 'src', 'lib');
const DIR = join(LIB, 'invariants');

/** Prisma and raw-SQL mutation verbs. `\b` so `createdAt` is not a hit. */
const WRITE_VERBS = [
  /\.create\s*\(/,
  /\.createMany\s*\(/,
  /\.update\s*\(/,
  /\.updateMany\s*\(/,
  /\.upsert\s*\(/,
  /\.delete\s*\(/,
  /\.deleteMany\s*\(/,
  /\$executeRaw/,
  /\$transaction/,
];

/**
 * Strip line comments BEFORE block comments.
 *
 * A `//` comment containing `/*` would otherwise open a block comment that eats
 * the rest of the file, and a scanner that silently swallows its own subject
 * reports a clean pass over nothing.
 */
export function stripComments(src: string): string {
  return src
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The runner/registry/types/notify modules PLUS every co-located
 * `src/lib/**‍/invariants.ts`.
 *
 * The second half is not optional and is the reason this helper exists rather than
 * a bare `readdirSync`. ADR-0131 D2 moved the checks — the code that actually
 * queries — OUT of `src/lib/invariants/`, so a scan of that directory alone covers
 * the plumbing and none of the database access. Deriving the list from
 * `invariantModulesOnDisk` means a NEW co-located module is in scope the moment it
 * is created, with nobody having to remember to widen this.
 */
function productionFiles(): { name: string; body: string }[] {
  const own = readdirSync(DIR)
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    .map((name) => ({ name: `invariants/${name}`, path: join(DIR, name) }));
  const colocated = invariantModulesOnDisk().map((dir) => ({
    name: `${dir}/invariants.ts`,
    path: join(LIB, dir, 'invariants.ts'),
  }));
  return [...own, ...colocated].map(({ name, path }) => ({
    name,
    body: stripComments(readFileSync(path, 'utf8')),
  }));
}

describe('the invariant suite is read-only against production', () => {
  it('scans a non-empty set of files — a scan over nothing proves nothing', () => {
    const files = productionFiles();
    // A floor plus the specific modules that hold the QUERIES — asserting only a
    // count would let the co-located half drop out silently, which is exactly how
    // this test failed the first time the checks moved.
    expect(files.length).toBeGreaterThanOrEqual(7);
    const names = files.map((f) => f.name);
    expect(names).toContain('invariants/runner.ts');
    expect(names).toContain('inventory/invariants.ts');
    expect(names).toContain('workbook-sync/invariants.ts');
    expect(names).toContain('notify/invariants.ts');
  });

  it('contains no Prisma or raw-SQL write verb', () => {
    const hits: string[] = [];
    for (const f of productionFiles()) {
      for (const verb of WRITE_VERBS) {
        const m = verb.exec(f.body);
        if (m) hits.push(`${f.name}: ${m[0]}`);
      }
    }
    expect(hits, `write verbs found in the read-only invariant suite:\n${hits.join('\n')}`).toEqual(
      [],
    );
  });

  it('NEGATIVE CONTROL — the scan actually detects a write verb when one is present', () => {
    // Without this, a broken regex set reports the same clean green as a clean
    // module and the guard is a detector that cannot fire.
    const planted = stripComments('const x = await prisma.site.update({ where: { id } });');
    const caught = WRITE_VERBS.some((v) => v.test(planted));
    expect(caught).toBe(true);
  });

  it('NEGATIVE CONTROL — stripComments does not let a // comment eat the file', () => {
    const src = ['// a path like /clips/* in a line comment', 'prisma.site.update({})'].join('\n');
    expect(WRITE_VERBS.some((v) => v.test(stripComments(src)))).toBe(true);
  });

  it('does not mistake createdAt / created_at for a write', () => {
    const src = 'orderBy: [{ created_at: "desc" }], select: { createdAt: true }';
    expect(WRITE_VERBS.some((v) => v.test(stripComments(src)))).toBe(false);
  });
});
