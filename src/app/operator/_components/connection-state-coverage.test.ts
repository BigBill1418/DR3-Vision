// ADR-0078 D9 — the connection indicator is on EVERY operator screen.
//
// JT's ask was that a dropped connection be visible. "Visible on the screens we
// remembered to add it to" is not that: the state an operator most needs is the
// one they hit on whichever screen they happen to be on, and before ADR-0065 the
// same class of omission left sign-out on 2 of the 9 operator screens.
//
// The claim is structural, so the guard is structural. It enumerates the
// operator pages off the FILESYSTEM — the same technique
// `floor-surface-coverage.test.ts` uses — rather than listing them, so a screen
// added next month is enrolled without anyone remembering to enrol it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFloorNav } from './floor-nav';

const COMPONENTS_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const OPERATOR_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('_')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findPages(full));
    else if (entry === 'page.tsx') out.push(full);
  }
  return out;
}

function routeFor(pageFile: string): string {
  const segs = relative(OPERATOR_DIR, pageFile)
    .split('/')
    .slice(0, -1)
    .map((s) =>
      s === '[site]'
        ? 'eugene'
        : s === '[id]'
          ? 'some-load-id'
          : s === '[userId]'
            ? 'clx8f3k2a0000abcd1234efgh'
            : s,
    );
  return ['/operator', ...segs].join('/');
}

const PAGES = findPages(OPERATOR_DIR);
const ROUTES = PAGES.map((p) => ({ file: relative(OPERATOR_DIR, p), route: routeFor(p) }));

describe('ADR-0078 D9 — connection state reaches every operator screen', () => {
  // Guards the guard. If the glob breaks, every assertion below passes while
  // measuring an empty list — the failure mode this repo has shipped before.
  it('enumeration actually found the operator pages', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(ROUTES.map((r) => r.route)).size).toBe(ROUTES.length);
  });

  // ── FALSIFICATION 10: chrome.connection-state-on-every-screen ───────────
  //
  // The indicator is mounted ONCE, in `FloorChrome`, which the operator route
  // group's layout wraps around all of these pages. So the structural claim has
  // two halves and both are asserted: the chrome mounts it, and the shell mounts
  // the chrome.
  //
  // FALSIFIED BY HAND: deleting the `<ConnectionState … />` line from
  // `floor-chrome.tsx` makes the first assertion red naming the missing mount;
  // removing `<FloorChrome …>` from `floor-shell.tsx` makes the second red. Both
  // were produced before this guard was trusted.
  it('FloorChrome mounts ConnectionState', () => {
    const chrome = readFileSync(join(COMPONENTS_DIR, 'floor-chrome.tsx'), 'utf8');
    expect(chrome, 'floor-chrome.tsx does not import ConnectionState').toContain(
      "from './connection-state'",
    );
    expect(chrome, 'floor-chrome.tsx does not render <ConnectionState>').toMatch(
      /<ConnectionState\b/,
    );
  });

  it('FloorShell mounts FloorChrome, so every page inherits it', () => {
    const shell = readFileSync(join(COMPONENTS_DIR, 'floor-shell.tsx'), 'utf8');
    expect(shell).toMatch(/<FloorChrome\b/);
  });

  // ── ADR-0078 G8: engine-runs-on-every-screen ────────────────────────────
  //
  // Bill: "drain should happen no matter what page its on." The engine is
  // mounted in FloorShell — above all nine screens — for exactly the same reason
  // the chrome is, and this asserts the mount rather than trusting it.
  //
  // FALSIFIED BY HAND: removing `<DrainEngineMount />` from `floor-shell.tsx`
  // makes this red naming the missing mount; putting the engine back inside a
  // page component would leave it red, which is the point — the previous design
  // had replay living in `load-workflow.tsx`, so whether an operator's queued
  // count went anywhere depended on which screen they were looking at.
  it('FloorShell mounts the drain engine, so it runs on every screen', () => {
    const shell = readFileSync(join(COMPONENTS_DIR, 'floor-shell.tsx'), 'utf8');
    expect(shell, 'floor-shell.tsx does not import the drain engine mount').toContain(
      "from './drain-engine-mount'",
    );
    expect(shell, 'floor-shell.tsx does not render <DrainEngineMount>').toMatch(
      /<DrainEngineMount\b/,
    );
  });

  // The other half: no PAGE may own a drain schedule again. A page-level sweep
  // is what made the drain a per-screen accident in the first place.
  it('no operator PAGE starts its own drain loop', () => {
    for (const { file } of ROUTES) {
      const src = readFileSync(join(OPERATOR_DIR, file), 'utf8');
      expect(src, `${file} starts its own drain engine`).not.toMatch(/startDrainEngine\s*\(/);
    }
  });

  it('the operator layout wraps its pages in FloorShell', () => {
    const layout = readFileSync(join(OPERATOR_DIR, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/<FloorShell\b/);
  });

  // The indicator is suppressed on the pre-PIN trio deliberately — no session,
  // no queued work, nothing to report. Every POST-auth screen must show it, and
  // that set is derived, not listed.
  it.each(ROUTES)('$route is a screen the indicator covers', ({ route }) => {
    const nav = resolveFloorNav(route);
    if (nav.isAuthSurface) {
      // Pre-auth. Asserted explicitly so a working screen that accidentally
      // resolves as an auth surface — the `WORK_SEGMENTS` trap — shows up here
      // as a screen that silently lost its indicator.
      expect(route === '/operator' || nav.showLogOut === false).toBe(true);
      return;
    }
    expect(nav.showLogOut, `${route} is post-auth and must carry the chrome`).toBe(true);
    expect(nav.siteCode, `${route} must resolve a site for the conflicts link`).not.toBeNull();
  });

  // ADR-0078's conflicts screen nests under /queue precisely so it inherits the
  // chrome without touching `WORK_SEGMENTS`. That was verified rather than
  // assumed, and this pins it: if anyone moves it to /operator/<site>/conflicts,
  // `resolveFloorNav` classifies it as a user id and it renders as a black
  // pre-auth page with no way out.
  it('the conflicts screen resolves as a post-auth working surface', () => {
    const nav = resolveFloorNav('/operator/eugene/queue/conflicts');
    expect(nav.isAuthSurface).toBe(false);
    expect(nav.showLogOut).toBe(true);
    expect(nav.backHref).toBe('/operator/eugene/today');
  });
});
