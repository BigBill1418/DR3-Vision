// ADR-0065 Amendment 1 — STRUCTURAL negative controls over the whole operator tree.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `floor-chrome.test.tsx` and `floor-nav.test.ts` assert the right behavior for a
// HAND-WRITTEN list of paths. That proves the six known screens are correct; it
// cannot prove the claim Bill actually asked about, which is about EVERY screen.
// A seventh operator page added next month passes both existing suites while
// having no back, no Log Out, and no rollout gate.
//
// So this suite derives its inputs from the FILESYSTEM instead of a literal list.
// It enumerates the real `page.tsx` files under `src/app/operator/`, converts each
// to the route it serves, and asserts the invariants against that derived set. Add
// a screen and it is tested automatically; the test is the negative control.
//
// The three claims under test, each of which was FALSE somewhere before this
// amendment:
//   1. Every operator screen has at least one explicit way out (back or Log Out).
//   2. Every ROLLOUT-GATED screen reads a gate. `/queue` and `/load/[id]` did not,
//      despite ADR-0065 D1 saying they did.
//   3. The hub is never gated (Bill: "do not strand anyone").

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveFloorNav } from './floor-nav';

const OPERATOR_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Every `page.tsx` under the operator route group, as absolute paths. */
function findPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // `_components` is a private folder — it never contains routable pages.
      if (entry.startsWith('_')) continue;
      out.push(...findPages(full));
    } else if (entry === 'page.tsx') {
      out.push(full);
    }
  }
  return out;
}

/** `.../operator/[site]/load/[id]/page.tsx` -> `/operator/eugene/load/some-load-id` */
function routeFor(pageFile: string): string {
  const rel = relative(OPERATOR_DIR, pageFile).split(sep).slice(0, -1);
  const segs = rel.map((s) => {
    if (s === '[site]') return 'eugene';
    if (s === '[id]') return 'some-load-id';
    if (s === '[userId]') return 'clx8f3k2a0000abcd1234efgh';
    return s;
  });
  return ['/operator', ...segs].join('/');
}

const PAGES = findPages(OPERATOR_DIR);
const ROUTES = PAGES.map((p) => ({ file: relative(OPERATOR_DIR, p), route: routeFor(p) }));

describe('operator tree — enumeration sanity', () => {
  it('found the operator pages (a zero-length sweep would vacuously pass everything)', () => {
    // Guards the guard: if the glob breaks, every assertion below becomes a no-op.
    // 9 screens as of ADR-0065; asserting a floor rather than an exact count so
    // adding a screen does not fail here, only in the invariant suites below.
    expect(PAGES.length).toBeGreaterThanOrEqual(9);
  });

  it('resolves each page file to a distinct route', () => {
    const routes = ROUTES.map((r) => r.route);
    expect(new Set(routes).size).toBe(routes.length);
  });
});

describe('nobody is ever stranded — every screen has an explicit exit', () => {
  it.each(ROUTES)('$route has back and/or Log Out', ({ route }) => {
    const nav = resolveFloorNav(route);
    const hasExit = nav.backHref !== null || nav.showLogOut;
    // `/operator` itself is the top of the tree AND pre-auth: nothing sits above
    // it and there is no session to end, so it is the one legitimate exception.
    if (route === '/operator') {
      expect(hasExit).toBe(false);
      return;
    }
    expect(hasExit, `${route} offers no way out`).toBe(true);
  });

  it('every POST-AUTH screen specifically offers Log Out (the shared-iPad rule)', () => {
    const postAuth = ROUTES.filter((r) => !resolveFloorNav(r.route).isAuthSurface);
    // The pre-PIN trio is site picker / name picker / keypad, so at least the hub,
    // queue, inbound, count, processed and load workflow must land here.
    expect(postAuth.length).toBeGreaterThanOrEqual(6);
    for (const { route } of postAuth) {
      expect(resolveFloorNav(route).showLogOut, route).toBe(true);
    }
  });

  it('every post-auth screen except the hub has a back destination', () => {
    for (const { route } of ROUTES) {
      const nav = resolveFloorNav(route);
      if (nav.isAuthSurface) continue;
      if (route === '/operator/eugene/today') {
        // The hub IS the back destination; a back pill there would self-link.
        expect(nav.backHref).toBeNull();
        continue;
      }
      expect(nav.backHref, route).toBe('/operator/eugene/today');
    }
  });
});

describe('ADR-0065 D1/D4 — every gated screen actually reads its gate', () => {
  // The surface each page file is REQUIRED to consult. Derived from ADR-0065's D1
  // table. `/queue` and `/load/[id]` are the two entries that were documented but
  // unimplemented until Amendment 1.
  const REQUIRED_GATE: Record<string, string> = {
    [join('[site]', 'queue', 'page.tsx')]: 'IPAD_QUEUE',
    [join('[site]', 'load', '[id]', 'page.tsx')]: 'IPAD_QUEUE',
    [join('[site]', 'inbound', 'page.tsx')]: 'IPAD_INBOUND',
    [join('[site]', 'count', 'page.tsx')]: 'IPAD_COUNT',
    [join('[site]', 'processed', 'page.tsx')]: 'IPAD_PROCESSED',
    // ADR-0074 — the open portal-haul read surface, on its own `ipad_hauls` gate.
    [join('[site]', 'hauls', 'page.tsx')]: 'IPAD_HAULS',
  };

  it('covers every gated surface named in the D1 table', () => {
    // Negative control on the map itself: six gated iPad PAGES (five from
    // ADR-0065's D1 table plus ADR-0074's hauls list), and the hub summary block
    // is asserted separately because it is a block, not a page.
    expect(Object.keys(REQUIRED_GATE)).toHaveLength(6);
  });

  it.each(Object.entries(REQUIRED_GATE))('%s reads UI_SURFACE.%s', (relFile, surface) => {
    const src = readFileSync(join(OPERATOR_DIR, relFile), 'utf8');
    expect(src, `${relFile} does not import the rollout gate`).toContain(
      "from '@/lib/notify/rollout'",
    );
    expect(src, `${relFile} does not consult UI_SURFACE.${surface}`).toContain(
      `UI_SURFACE.${surface}`,
    );
  });

  it('a gated-off screen degrades to the translated block, never a 404 or a throw', () => {
    for (const relFile of Object.keys(REQUIRED_GATE)) {
      const src = readFileSync(join(OPERATOR_DIR, relFile), 'utf8');
      // ADR-0065 rejected 404-ing a gated surface outright: "a bookmarked URL
      // should degrade to the already-translated 'not turned on yet' block, not a
      // dead end."
      expect(src, relFile).toContain('floor.common.not_activated_heading');
    }
  });
});

describe('ADR-0065 D3 — the hub is NEVER gated', () => {
  const hub = readFileSync(join(OPERATOR_DIR, '[site]', 'today', 'page.tsx'), 'utf8');

  it('gates its CONTENT, not itself — no early return before the heading renders', () => {
    // It must read gates (for the cards) …
    expect(hub).toContain('UI_SURFACE.IPAD_QUEUE');
    expect(hub).toContain('UI_SURFACE.IPAD_TODAY_SUMMARY');
    // … but must never redirect or notFound on a gate result. PIN success lands
    // here, so a gated hub drops an authenticated operator onto a dead screen.
    expect(hub).not.toMatch(/if\s*\(\s*!\w*[Ll]ive\s*\)\s*(redirect|notFound)/);
  });

  it('renders an explanation when every surface is off, rather than nothing', () => {
    expect(hub).toContain('floor.common.not_activated_heading');
  });
});

describe('the current-Pacific-day floor uses no server-local boundary', () => {
  it.each(PAGES.map((p) => relative(OPERATOR_DIR, p)))(
    '%s does not compute a day with setHours/UTC slicing',
    (relFile) => {
      const src = readFileSync(join(OPERATOR_DIR, relFile), 'utf8');
      // Strip comments: ADR-0065's own explanatory prose quotes the broken pattern.
      const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(code, `${relFile} uses a server-local day boundary`).not.toMatch(/setHours\s*\(\s*0/);
      expect(code, `${relFile} slices a UTC ISO string into a day key`).not.toMatch(
        /toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/,
      );
    },
  );
});
