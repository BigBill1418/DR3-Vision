// BS-9 — every anchor selector carries the ADR-0078 D1 `created_at` tiebreak.
//
// ## Why a guard and not three edits
//
// ADR-0078 D1 added the tiebreak to `onHand` and `loadPriorAnchor` and wrote down
// the reason: counts are stamped at Pacific MIDNIGHT of their day (ADR-0060 D-3), so
// two counts taken on one day carry a byte-identical `snapshot_at`, and SQL does not
// promise which of two equal keys `ORDER BY snapshot_at DESC` returns. Which count
// becomes the anchor was decided by the planner.
//
// Three more selectors were written afterwards WITHOUT it, each carrying a comment
// saying so ("PRE-EXISTING: no ADR-0078 D1 tiebreak here"). That is the shape this
// repo keeps rediscovering: a known defect, documented at the call site, propagated
// by copy. `running-balance.ts` already says it out loud — "If you change one of
// these two orderings, change both" — and a sentence in a comment is not a mechanism.
// This is the mechanism.
//
// ## Why it matters on real data
//
// Woodland's 2026-08-18 carries exactly the tying pair. One row is `legacy` (all 923
// units attributed to the PROGRAM pool) and one is `measured` (201 program / 722
// non-program). `cor/prefill.ts` is the COR FILING PATH: it names the anchor row
// that goes to MRC on Exhibit 5, and it was selecting that row with a different
// query than the one that computed the figure it sits beside.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { callSitesIn } from './snapshot-void-readers.guard.test';

const REPO_ROOT = process.cwd();
const SRC = join(REPO_ROOT, 'src');

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

/**
 * An ANCHOR selector: a `findFirst` that picks one physical snapshot. A `findMany`
 * history list is not one — it renders rows, it does not decide which row every
 * downstream number is computed forward from.
 */
function isAnchorSelector(s: { method: string; args: string }): boolean {
  return (
    s.method === 'findFirst' && /snapshot_kind:\s*'physical'/.test(s.args) && /orderBy/.test(s.args)
  );
}

function carriesTiebreak(args: string): boolean {
  return /snapshot_at:\s*'desc'/.test(args) && /created_at:\s*'desc'/.test(args);
}

const anchorSites = walk(SRC)
  .flatMap((f) => callSitesIn(relative(REPO_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')))
  .filter(isAnchorSelector);

describe('ADR-0078 D1 — the anchor tiebreak, enforced', () => {
  it('finds the anchor selectors at all — a scan over nothing proves nothing', () => {
    // A FLOOR with the known participants named. Asserting only a count would let
    // the scan silently stop matching (a rename, a formatting change) and report a
    // clean pass over zero call sites.
    expect(anchorSites.length).toBeGreaterThanOrEqual(4);
    const files = anchorSites.map((s) => s.file);
    expect(files).toContain('src/lib/inventory/running-balance.ts');
    expect(files).toContain('src/lib/cor/prefill.ts');
    expect(files).toContain('src/lib/loads/eod-inventory.ts');
  });

  it('every anchor selector orders by snapshot_at DESC, created_at DESC', () => {
    const missing = anchorSites
      .filter((s) => !carriesTiebreak(s.args))
      .map((s) => `${s.file}:${s.line} .${s.method}()`);
    expect(
      missing,
      `anchor selector(s) without the ADR-0078 D1 created_at tiebreak:\n${missing.join('\n')}\n` +
        `On a two-count day these pick a planner-dependent anchor. Woodland 2026-08-18 is such a day.`,
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL — the check rejects a single-key orderBy', () => {
    // Without this, a regex that stopped matching would report the same green as a
    // repo where every selector is correct.
    expect(carriesTiebreak("orderBy: { snapshot_at: 'desc' },")).toBe(false);
    expect(carriesTiebreak("orderBy: [{ snapshot_at: 'desc' }, { created_at: 'desc' }],")).toBe(
      true,
    );
  });
});
