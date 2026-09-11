import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INVARIANTS } from './registry';

// ADR-0131 D2 — invariants live beside the code whose assumption they encode, and
// `registry.ts` holds none. The failure mode that makes this worth a test is not
// "someone puts an invariant in the wrong folder"; it is an `invariants.ts` that
// exists, looks maintained, and is imported by NOTHING — so it never runs and its
// absence from the digest is indistinguishable from it passing.
//
// Same mechanism D2 points at: `snapshot-void-readers.guard.test.ts` parses the
// real source rather than trusting a convention.

const LIB = join(process.cwd(), 'src', 'lib');
const REGISTRY = join(LIB, 'invariants', 'registry.ts');

/** Every `src/lib/**‍/invariants.ts` on disk, as a path relative to src/lib. */
export function invariantModulesOnDisk(root = LIB, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      out.push(...invariantModulesOnDisk(full, prefix ? `${prefix}/${entry}` : entry));
    } else if (entry === 'invariants.ts') {
      out.push(prefix);
    }
  }
  return out.sort();
}

describe('ADR-0131 D2 — co-location, enforced', () => {
  const modules = invariantModulesOnDisk();
  const registrySrc = readFileSync(REGISTRY, 'utf8');

  it('finds the co-located modules at all — a scan over nothing proves nothing', () => {
    expect(modules.length).toBeGreaterThanOrEqual(3);
    expect(modules).toContain('inventory');
  });

  it.each(modules)('src/lib/%s/invariants.ts is imported by the registry', (dir) => {
    expect(
      registrySrc.includes(`@/lib/${dir}/invariants`),
      `src/lib/${dir}/invariants.ts exists but registry.ts does not import it, so nothing runs it`,
    ).toBe(true);
  });

  it('NEGATIVE CONTROL — the import check rejects a module the registry omits', () => {
    expect(registrySrc.includes('@/lib/definitely-not-a-real-module/invariants')).toBe(false);
  });

  it('registry.ts DEFINES no invariant of its own', () => {
    // D2: "imports them; holds no invariants itself". An `id:` literal here is the
    // first step back toward the central registry D2 exists to prevent.
    expect(registrySrc).not.toMatch(/\bid:\s*'INV-/);
    expect(registrySrc).not.toMatch(/\bcheck\s*\(/);
  });

  it('every registered invariant came from a co-located module', () => {
    expect(INVARIANTS.length).toBeGreaterThanOrEqual(8);
  });
});
