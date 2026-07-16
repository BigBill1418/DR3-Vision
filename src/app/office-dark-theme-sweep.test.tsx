// ADR-0051 (C-16 sweep) — the office/manager surfaces adopt the Vision deep-space
// theme; the floor iPads (`/operator/*`) stay green per ADR-0008. This is the
// invariant guard for that split: NO office source file may carry a legacy green
// brand class (`dr3-green*`, `dr3-chartreuse`, `dr3-cream`). The floor tree and the
// COR PDF renderer (a printed deliverable, not office UI) are the only surfaces the
// green tokens are still allowed on, so they are excluded from the scan.
//
// This complements the per-page AP smoke test (ap/page.test.tsx): rather than assert
// one page's markup, it statically sweeps every office .tsx so a NEW green office page
// (or a regression on a repainted one) fails CI without needing its own test.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const APP_DIR = fileURLToPath(new URL('.', import.meta.url));

// Legacy green brand classes (ADR-0008). Utility-class forms only, so a stray
// comment mentioning the token isn't what trips the guard — a rendered class is.
const GREEN_CLASS =
  /\b(?:bg|text|border|from|to|via|ring|accent|fill|stroke)-dr3-(?:green(?:-deep|-dark)?|chartreuse|cream)\b/;

/** Office surfaces where green is still legitimate and therefore NOT swept. */
function isExcluded(path: string): boolean {
  return (
    path.includes(`${join('app', 'operator')}`) || // floor iPads stay green (ADR-0008)
    path.includes('cor-pdf') || // printed COR deliverable, not office UI
    path.endsWith('.test.tsx') ||
    path.endsWith('.test.ts')
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('office dark-theme sweep (ADR-0051 / C-16)', () => {
  it('no office source file carries a legacy green brand class', () => {
    const offenders = walk(APP_DIR)
      .filter((p) => !isExcluded(p))
      .filter((p) => GREEN_CLASS.test(readFileSync(p, 'utf8')))
      .map((p) => p.slice(APP_DIR.length));
    expect(
      offenders,
      `green classes must move to dr3-cyan/space/mist:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('the floor tree still exists and is intentionally left green (exclusion is real)', () => {
    // Guards against the exclusion silently masking an empty/renamed floor tree:
    // if /operator ever loses its green, this catches that the sweep would have
    // nothing to protect against and the exclusion became a lie.
    const floor = walk(join(APP_DIR, 'operator'));
    const greenOnFloor = floor.some((p) => GREEN_CLASS.test(readFileSync(p, 'utf8')));
    expect(greenOnFloor).toBe(true);
  });
});
