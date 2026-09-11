// Every ntfy Click URL points at a host that actually exists.
//
// ## The defect this exists for
//
// `src/lib/mymrc/ntfy.ts` sent every MyMRC alert with
// `Click: https://dr3-vision.barnardhq.com/admin/mrc-scrape`. That host has no DNS
// record — `getent hosts` returns nothing, `curl` reports `http=000`. DR3-Vision is
// published at `dr3-vision.svdp.us`. The same wrong host was copied into three
// `.mjs` workers, so FOUR publishers shipped a dead link.
//
// Measured against the live ntfy retention window on 2026-09-11: **25 of the 41
// messages** carried it, including all 24 stale-mirror pages of 2026-09-07. Tapping
// any of them did nothing. The alerts were delivered, graded and deduplicated
// correctly, and were unactionable.
//
// ## Why a test and not a comment
//
// `src/lib/ntfy.ts:19` already carries a comment warning about this exact class —
// the `noc.barnardhq.com` vs `noc-mastercontrol.barnardhq.com` pair from CLAUDE.md.
// The defect happened anyway, two files away, in a module whose header cites the
// same ADR. A comment is read by whoever is already looking at the file; the author
// of the next publisher is not. (That warning is live, incidentally:
// `noc.barnardhq.com/status/dr3-vision` returns 404, tested in the same pass.)
//
// ## Why an allowlist and not a DNS lookup
//
// A test that resolves DNS is a test that fails on a plane, and a flaky guard gets
// skipped. The allowlist is static and every entry records when it was verified and
// what it returned. Adding a host is a deliberate, reviewable act — which is the
// property that was missing.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();
const SCAN_DIRS = ['src', 'scripts'];

/**
 * Hosts an ntfy Click URL may point at.
 *
 * Each entry is a claim that the host resolved and answered on the date given. Do
 * not add one without testing it:
 *   `curl -s -o /dev/null -w '%{http_code}' https://<host>/<path>`
 */
const ALLOWED_HOSTS: Readonly<Record<string, string>> = {
  // The application itself. CLAUDE.md "Build context" — public domain
  // `dr3-vision.svdp.us`. Verified 2026-09-11: /admin/mrc-scrape → 307 (the auth
  // redirect, which is the correct answer for a session-less GET).
  'dr3-vision.svdp.us': 'app — 307 on /admin/* (auth redirect), 2026-09-11',
  // ADR-0036 tier-3 fallback. Verified 2026-09-11: /status/dr3-vision → 200.
  // NOT `noc.barnardhq.com`, which 404s on the same path — the confusable pair.
  'noc-mastercontrol.barnardhq.com': 'NOC status — 200 on /status/dr3-vision, 2026-09-11',
  // ADR-0036 transport primary (not a Click target, but a fleet host literal the
  // scan sees). Verified 2026-09-11: 200.
  'ntfy.barnardhq.com': 'ntfy primary — 200, 2026-09-11',
  // SVdP parent-org marketing site, referenced only in brand-token comments and a
  // favicon URL. Not an alert target.
  'www.svdp.us': 'SVdP parent-org site — brand asset reference only',
};

/**
 * Hosts that are KNOWN WRONG. A named blocklist alongside the allowlist, because
 * "not in the allowlist" and "this specific mistake again" deserve different
 * messages — the second one can name the fix.
 */
const KNOWN_WRONG: Readonly<Record<string, string>> = {
  'dr3-vision.barnardhq.com': 'NXDOMAIN — the app is at dr3-vision.svdp.us',
  'noc.barnardhq.com':
    'InfraWatch, not the NOC app — /status/<svc> 404s there; use noc-mastercontrol.barnardhq.com',
};

interface Hit {
  file: string;
  line: number;
  host: string;
  url: string;
}

/**
 * Every FLEET host literal — anything under `barnardhq.com` or `svdp.us`.
 *
 * Scoped by what the host IS, not by the identifier that names it. The first
 * version of this guard keyed on `clickUrl:` / `Click:` / `*CLICK_URL` and MISSED
 * three of the four dead links, because `scripts/mymrc-scrape.mjs` calls its
 * constant `ADMIN_SURFACE_URL` and puts the literal on the next line. A guard
 * keyed on a naming convention only finds the authors who followed it — and the
 * author who did not is precisely the one worth catching.
 *
 * The domain suffixes keep the scan tight without a keyword: SharePoint, Graph and
 * example.com fixtures are not fleet hosts and never match.
 */
const FLEET_HOST = /(https:\/\/[a-z0-9.-]+\.(?:barnardhq\.com|svdp\.us))/gi;

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
      walk(full, acc);
      continue;
    }
    if (!/\.(ts|tsx|mjs|cjs|js)$/.test(name)) continue;
    if (/\.(test|spec)\.(ts|tsx|mjs)$/.test(name)) continue;
    acc.push(full);
  }
  return acc;
}

export function clickHostsIn(file: string, src: string): Hit[] {
  const out: Hit[] = [];
  FLEET_HOST.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FLEET_HOST.exec(src)) !== null) {
    const url = m[1] as string;
    // Strip a `//`-comment line: the repaired module documents the dead host in
    // prose, and a guard that reads its own postmortem is the "matches its own
    // documentation" failure the void-readers guard already learned about.
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const lineText = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
    out.push({
      file,
      line: src.slice(0, m.index).split('\n').length,
      host: url.replace(/^https:\/\//, ''),
      url,
    });
  }
  return out;
}

const hits = SCAN_DIRS.flatMap((d) =>
  walk(join(REPO_ROOT, d)).flatMap((f) =>
    clickHostsIn(relative(REPO_ROOT, f).split(sep).join('/'), readFileSync(f, 'utf8')),
  ),
);

describe('ntfy Click URLs point at hosts that exist', () => {
  it('finds click URLs at all — a scan over nothing proves nothing', () => {
    // A FLOOR plus the specific publishers, so the scan silently ceasing to match
    // (a rename, a reformat) cannot report the same green as a clean repo. This is
    // the failure mode that let the dead host survive: nothing was looking.
    expect(hits.length).toBeGreaterThanOrEqual(40);
    const files = new Set(hits.map((h) => h.file));
    // The four publishers that shipped the dead link. Named individually because a
    // count alone would not notice three of them dropping out of the scan — which
    // is exactly what the first version of this guard did.
    expect(files).toContain('src/lib/mymrc/ntfy.ts');
    expect(files).toContain('scripts/mymrc-scrape.mjs');
    expect(files).toContain('scripts/mymrc-backfill.mjs');
    expect(files).toContain('scripts/mymrc-enrich-details.mjs');
  });

  it('every click host is on the verified allowlist', () => {
    const bad = hits
      .filter((h) => !(h.host in ALLOWED_HOSTS))
      .map(
        (h) =>
          `${h.file}:${h.line} → ${h.host}` +
          (h.host in KNOWN_WRONG ? `  [KNOWN WRONG: ${KNOWN_WRONG[h.host]}]` : ''),
      );
    expect(
      bad,
      `ntfy Click URL(s) on an unverified host:\n${bad.join('\n')}\n\n` +
        `Test it, then add it to ALLOWED_HOSTS with the date and status code:\n` +
        `  curl -s -o /dev/null -w '%{http_code}' https://<host>/<path>`,
    ).toEqual([]);
  });

  it('no publisher uses a host on the known-wrong list', () => {
    const wrong = hits
      .filter((h) => h.host in KNOWN_WRONG)
      .map((h) => `${h.file}:${h.line} ${h.host}`);
    expect(wrong).toEqual([]);
  });

  it('NEGATIVE CONTROL — the scan detects the exact defect it was written for', () => {
    // Without this, a regex that stopped matching would report the same green as a
    // repo with no dead hosts in it.
    const planted = clickHostsIn(
      'fake.ts',
      "const CLICK_URL = 'https://dr3-vision.barnardhq.com/admin/mrc-scrape';",
    );
    expect(planted).toHaveLength(1);
    expect(planted[0]!.host).toBe('dr3-vision.barnardhq.com');
    expect(planted[0]!.host in ALLOWED_HOSTS).toBe(false);
    expect(planted[0]!.host in KNOWN_WRONG).toBe(true);
  });

  it('NEGATIVE CONTROL — it catches a literal on the line AFTER its constant', () => {
    // The miss that broke the first version of this guard: `mymrc-scrape.mjs`
    // names its constant `ADMIN_SURFACE_URL` and wraps the literal onto the next
    // line, so a keyword-proximity scan found nothing there.
    const planted = clickHostsIn(
      'fake.mjs',
      "const ADMIN_SURFACE_URL =\n  process.env.X ||\n  'https://dr3-vision.barnardhq.com/admin/mrc-scrape';",
    );
    expect(planted).toHaveLength(1);
    expect(planted[0]!.host).toBe('dr3-vision.barnardhq.com');
  });

  it('does not flag a non-fleet host (SharePoint, Graph, example fixtures)', () => {
    expect(clickHostsIn('fake.ts', "url: 'https://svdp.sharepoint.com/x'")).toEqual([]);
    expect(clickHostsIn('fake.ts', "url: 'https://example-my.sharepoint.com/y'")).toEqual([]);
  });

  it('NEGATIVE CONTROL — it catches the confusable NOC host too', () => {
    const planted = clickHostsIn(
      'fake.ts',
      "  clickUrl: 'https://noc.barnardhq.com/status/dr3-vision',",
    );
    expect(planted[0]!.host in ALLOWED_HOSTS).toBe(false);
  });

  it('does not flag a host named only inside a comment', () => {
    // The repaired module documents the dead host in its header. A guard that read
    // that prose as a finding would be unfixable.
    expect(
      clickHostsIn('fake.ts', '// Click: https://dr3-vision.barnardhq.com/x was dead'),
    ).toEqual([]);
  });
});
