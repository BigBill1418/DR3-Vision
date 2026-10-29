// ADR-0143 D1 — test T1: no surface or mail module renders an on-hand pool except
// through `presentOnHand()` (src/lib/inventory/negative-floor.ts).
//
// The defect this pins (RC3): ADR-0110 D3 ("a negative figure is replaced, never
// shown") was implemented on three of five surfaces. `loads-inventory/page.tsx` and
// the iPad `operator/[site]/today/page.tsx` printed `balance.program.toString()` raw,
// and Woodland's managers read "Program on hand -247" for weeks. Nothing structural
// stopped the next page from doing the same, so this scan does.
//
// Two rules, both CI-blocking:
//   A. RAW RENDER — a page/component under src/app, or a mail module, may not call
//      `.program|.nonProgram|.total` followed by `.toString() / .toNumber() /
//      .toFixed() / .toLocaleString() / .toNearest()`. That call shape is how a
//      Decimal pool becomes text.
//   B. RAW CONSUMER — a file under src/app (or a module that feeds a page) that calls
//      `onHand(` / `computePoolBalance(` must import `presentOnHand`. Getting a raw
//      balance is fine; carrying it to a person without the presenter is not.
//
// Modelled on `src/lib/notify/__tests__/no-direct-mail.test.ts`. Both rules assert how
// many files they inspected, so a scan that silently matches nothing goes red.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Rule B exemptions — each with the reason it never reaches a person. */
const CONSUMER_ALLOWLIST: Record<string, string> = {
  'src/app/api/internal/inventory/floor-probe/route.ts':
    'machine JSON for the NOC floor probe (loopback, INTERNAL_CRON_TOKEN); never rendered to a person',
};

/** Modules outside src/app that hand a balance to a page. Rule B applies to them too. */
const PAGE_FEEDERS = ['src/lib/yard/service.ts'];

const RAW_RENDER_RE =
  /\.(program|nonProgram|total)\s*\.\s*(toString|toNumber|toFixed|toLocaleString|toNearest)\s*\(/;
const CONSUMER_CALL_RE = /\b(onHand|computePoolBalance|computeOnHand)\s*\(/;
const BALANCE_IMPORT_RE = /from\s+['"]@\/lib\/inventory\/running-balance['"]/;
const PRESENTER_IMPORT_RE =
  /\bpresentOnHand\b[^;]*from\s+['"]@\/lib\/inventory\/negative-floor['"]/s;

function isTest(p: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(p) || p.includes('/__tests__/') || p.includes('/__fixtures__/')
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function rel(abs: string): string {
  return relative(ROOT, abs).split(sep).join('/');
}

/** Strip // and /* *\/ comments so prose that quotes the old bug is not a violation. */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

export interface SourceFile {
  path: string;
  content: string;
}

/** Rule A applies to pages/components (not API routes) and to mail renderers. */
export function isRenderSurface(p: string): boolean {
  if (isTest(p)) return false;
  if (p.startsWith('src/app/') && !p.startsWith('src/app/api/')) return true;
  return /^src\/lib\/.*(notifications|-mail|mail-)[^/]*\.ts$/.test(p);
}

/**
 * A line may opt out with an `onhand-presenter-ok: <reason>` comment ON THE SAME LINE when the
 * `.total` it formats is NOT a running-balance pool (a physical count's own total,
 * a production comparison). The marker must carry a reason; a bare marker is ignored.
 */
const OPT_OUT_RE = /onhand-presenter-ok:\s*[^\s*/][^*/]{8,}/;

export function findRawRenders(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => isRenderSurface(f.path))
    .filter((f) =>
      f.content
        .split('\n')
        .filter((line) => !OPT_OUT_RE.test(line))
        .some((line) => RAW_RENDER_RE.test(stripComments(line))),
    )
    .map((f) => f.path);
}

export function isConsumerScope(p: string): boolean {
  if (isTest(p)) return false;
  return p.startsWith('src/app/') || PAGE_FEEDERS.includes(p);
}

export function findUnpresentedConsumers(files: readonly SourceFile[]): string[] {
  return files
    .filter((f) => isConsumerScope(f.path))
    .filter((f) => !(f.path in CONSUMER_ALLOWLIST))
    .filter((f) => {
      const code = stripComments(f.content);
      return BALANCE_IMPORT_RE.test(code) && CONSUMER_CALL_RE.test(code);
    })
    .filter((f) => !PRESENTER_IMPORT_RE.test(f.content))
    .map((f) => f.path);
}

function realFiles(): SourceFile[] {
  return [...walk(join(ROOT, 'src'))]
    .map((abs) => ({ path: rel(abs), content: readFileSync(abs, 'utf-8') }))
    .filter((f) => !isTest(f.path));
}

describe('ADR-0143 D1 — every on-hand figure goes through presentOnHand (T1)', () => {
  const files = realFiles();

  it('rule A: no page, component or mail module renders a pool raw', () => {
    const inspected = files.filter((f) => isRenderSurface(f.path));
    // A scan that inspects nothing is a green light wired to a battery.
    expect(inspected.length).toBeGreaterThan(100);
    expect(inspected.map((f) => f.path)).toContain('src/lib/bonus/daily-report-notifications.ts');
    expect(findRawRenders(files)).toEqual([]);
  });

  it('rule B: every page-side caller of onHand imports presentOnHand', () => {
    const consumers = files.filter(
      (f) =>
        isConsumerScope(f.path) &&
        BALANCE_IMPORT_RE.test(f.content) &&
        CONSUMER_CALL_RE.test(stripComments(f.content)),
    );
    // today, loads-inventory, count, yard service + the allowlisted probe.
    expect(consumers.length).toBeGreaterThanOrEqual(5);
    expect(findUnpresentedConsumers(files)).toEqual([]);
  });

  it('every allowlist entry still exists (no stale exemptions)', () => {
    const paths = new Set(files.map((f) => f.path));
    for (const p of [...Object.keys(CONSUMER_ALLOWLIST), ...PAGE_FEEDERS]) {
      expect(paths.has(p), p).toBe(true);
    }
  });

  it('test-of-the-test: the 2026-10-29 Woodland lines are caught', () => {
    const planted: SourceFile[] = [
      {
        path: 'src/app/dashboard/[site]/planted/page.tsx',
        content:
          "import { onHand } from '@/lib/inventory/running-balance';\n" +
          'const balance = await onHand(siteId, new Date());\n' +
          '<BalanceTile label="Program on hand" value={balance.program.toString()} accent />\n',
      },
      {
        path: 'src/lib/planted/report-notifications.ts',
        content: 'html += `Program ${eod.balance.nonProgram.toNumber()}`;\n',
      },
      {
        path: 'src/app/admin/opted-out/page.tsx',
        content:
          '{r.total.toLocaleString()} {/* x */} // onhand-presenter-ok: a physical count total, never negative\n' +
          '{r.total.toLocaleString()} // onhand-presenter-ok:\n',
      },
      {
        path: 'src/app/dashboard/[site]/commented/page.tsx',
        content: '// it used to print balance.program.toString() raw\nexport const x = 1;\n',
      },
      {
        path: 'src/app/api/internal/inventory/floor-probe/route.ts',
        content:
          "import { onHand } from '@/lib/inventory/running-balance';\nawait onHand(s, n); floor.total.toString();\n",
      },
    ];
    expect(findRawRenders(planted)).toEqual([
      'src/app/dashboard/[site]/planted/page.tsx',
      'src/lib/planted/report-notifications.ts',
      // the second line's bare marker carries no reason, so it does not opt out
      'src/app/admin/opted-out/page.tsx',
    ]);
    expect(findUnpresentedConsumers(planted)).toEqual([
      'src/app/dashboard/[site]/planted/page.tsx',
    ]);
  });
});
