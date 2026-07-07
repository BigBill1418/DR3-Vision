// ADR-0047 D1 — repo guard: feature code must NOT import the raw mail sender
// (`@/lib/m365-mail` → sendSystemEmail / sendPayrollPdf). The ONLY sanctioned
// path to staff is `notifyStaff()`. This test scans the real `src/` tree (no
// fixtures) and fails if any non-allowlisted module imports the transport.
//
// Allowlist (enumerated per the directive):
//   - the transport module itself (defines the senders);
//   - the notify policy layer (the chokepoint);
//   - auth flows;
//   - the payroll delivery path (sendPayrollPdf);
//   - the grandfathered production surfaces: bonus signature-chain + survey
//     sends (§4.4 out-of-scope, seeded `live`);
//   - two pre-existing production surfaces NOT named in §4.4 — the ADR-0030
//     daily production report and the ADR-0028/0029 amendment lifecycle mail —
//     grandfathered on the incident-night deploy to avoid regressing a working
//     email. These are REPORTED, not silently gated (directive §3). See
//     docs/QUESTIONS.md Q-0047-1 / Q-0047-2 for Bill's disposition; convert to
//     notifyStaff() when he decides.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC_ROOT = join(process.cwd(), 'src');

/** Files/dirs allowed to import `@/lib/m365-mail`, as repo-relative POSIX paths. */
const ALLOWLIST_FILES = new Set<string>([
  'src/lib/m365-mail.ts', // transport core — defines sendSystemEmail / sendPayrollPdf
  'src/lib/notify/notify-staff.ts', // THE policy-layer chokepoint
  'src/lib/bonus/payroll-delivery.ts', // payroll delivery path (sendPayrollPdf)
  'src/lib/bonus/signature-notifications.ts', // grandfathered — bonus signature-chain (live)
  'src/lib/survey/notifications.ts', // grandfathered — survey invite/reminder sends (live)
  'src/lib/bonus/daily-report-notifications.ts', // grandfathered — ADR-0030 daily production report (Q-0047-1)
  'src/lib/bonus/amendment-notifications.ts', // grandfathered — ADR-0028/0029 amendment mail (Q-0047-2)
]);

/** Directory prefixes allowed wholesale (auth flows). */
const ALLOWLIST_PREFIXES = ['src/lib/auth', 'src/app/api/auth', 'src/app/(auth)'];

/** Import of the transport module by any specifier ending in `/m365-mail` (or bare). */
const MAIL_IMPORT_RE = /\bfrom\s+['"]([^'"]*\bm365-mail)['"]/;

function isTestOrFixture(path: string): boolean {
  return (
    /\.(test|spec)\.[cm]?tsx?$/.test(path) ||
    path.includes(`${sep}__tests__${sep}`) ||
    path.includes(`${sep}__fixtures__${sep}`) ||
    path.includes(`${sep}__testutils__${sep}`)
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.[cm]?tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function toRepoRel(absPath: string): string {
  return relative(process.cwd(), absPath).split(sep).join('/');
}

function isAllowed(repoRel: string): boolean {
  return (
    ALLOWLIST_FILES.has(repoRel) || ALLOWLIST_PREFIXES.some((p) => repoRel.startsWith(`${p}/`) || repoRel === p)
  );
}

/**
 * Pure scanner (test-of-the-test seam): returns repo-relative paths of files that
 * import the transport and are NOT allowlisted. Operates on in-memory records so
 * a synthetic violation can be asserted without touching disk.
 */
export function findDirectMailImports(files: ReadonlyArray<{ path: string; content: string }>): string[] {
  return files
    .filter((f) => !isTestOrFixture(f.path.split('/').join(sep)))
    .filter((f) => MAIL_IMPORT_RE.test(f.content))
    .map((f) => f.path)
    .filter((p) => !isAllowed(p));
}

describe('ADR-0047 — no direct m365-mail imports outside the allowlist', () => {
  it('the real src/ tree has zero un-allowlisted transport importers', () => {
    const files = walk(SRC_ROOT)
      .filter((abs) => !isTestOrFixture(abs))
      .map((abs) => ({ path: toRepoRel(abs), content: readFileSync(abs, 'utf-8') }));

    const violations = findDirectMailImports(files);
    expect(violations, `feature code must route staff mail through notifyStaff(): ${violations.join(', ')}`).toEqual([]);
  });

  it('detects a synthetic direct-mail import (test-of-the-test)', () => {
    const synthetic = [
      { path: 'src/lib/evil/feature.ts', content: "import { sendSystemEmail } from '@/lib/m365-mail';\n" },
      { path: 'src/lib/evil/relative.ts', content: "import { sendSystemEmail } from '../../m365-mail';\n" },
      { path: 'src/lib/notify/notify-staff.ts', content: "import { sendSystemEmail } from '@/lib/m365-mail';\n" }, // allowlisted
    ];
    expect(findDirectMailImports(synthetic)).toEqual(['src/lib/evil/feature.ts', 'src/lib/evil/relative.ts']);
  });

  it('ignores transport imports in test/fixture files', () => {
    const synthetic = [
      { path: 'src/lib/evil/feature.test.ts', content: "import { sendSystemEmail } from '@/lib/m365-mail';\n" },
    ];
    expect(findDirectMailImports(synthetic)).toEqual([]);
  });
});
