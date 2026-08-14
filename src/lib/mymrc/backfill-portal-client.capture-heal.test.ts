// ADR-0103 — `captureListPage` survives a mid-run session heal (2026-08-13).
//
// The live failure this closes (prod page, 2026-08-13 23:01 PT, and an identical
// one 2026-08-12 00:01 PT): `captureListPage` read `admin.getPage()` ONCE, bound
// its aura listeners to that page, and then called `admin.ensureAuthenticated()`.
// A mid-run drop makes `ensureAuthenticated` tear the context down and open a NEW
// page (portal-client `rebuildAndLogin`), so the cached reference is dead — and
// the very next line, `page.waitForTimeout(CAPTURE_SETTLE_MS)`, threw
// `Target page, context or browser has been closed`, failing the whole feed:
//
//   mymrc: mid-run re-auth recovered on attempt 1/3 (admin)
//   woodland/outbound FAILED (error) — page.waitForTimeout: Target page, ... closed
//
// The AdminSession contract already said it (portal-client.ts: "callers must
// never cache the reference across an `ensureAuthenticated`") — this is the one
// caller that did. These tests pin BOTH halves of the defect:
//   • the loud half — a heal must not throw, and
//   • the QUIET half — the heal's own re-navigation happens with our listeners on
//     the dead page, so a capture that merely survived would come back EMPTY and
//     silently under-sync billing data. A healed pass must be REPLAYED, not patched.

import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { playwrightBackfillSession } from './backfill-portal-client';
import type { AdminSession } from './portal-client';

const GET_ITEMS_MESSAGE = JSON.stringify({
  actions: [{ n: 'ListViewDataManagerController.getItems', params: { filterName: 'Recent' } }],
});

function auraPostData(token: string): string {
  const p = new URLSearchParams();
  p.set('aura.context', `{"mode":"PROD","token":"${token}"}`);
  p.set('aura.token', token);
  p.set('aura.pageURI', '/s/outbound-materials');
  p.set('message', GET_ITEMS_MESSAGE);
  return p.toString();
}

interface FakePage {
  page: Page;
  id: string;
  closed: boolean;
  listenerCount: () => number;
  /** Fire the aura request+response pair a real list-page navigation produces. */
  emitAura: (token: string) => void;
}

function makePage(id: string): FakePage {
  const listeners = new Map<string, Set<(arg: unknown) => void>>();
  const self: FakePage = {
    id,
    closed: false,
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    emitAura(token) {
      for (const fn of listeners.get('request') ?? []) {
        fn({
          method: () => 'POST',
          url: () => 'https://mrc-us.my.site.com/s/sfsites/aura?r=1',
          postData: () => auraPostData(token),
        });
      }
      for (const fn of listeners.get('response') ?? []) {
        fn({
          url: () => 'https://mrc-us.my.site.com/s/sfsites/aura?r=1',
          text: () => Promise.resolve(`{"token":"${token}"}`),
        });
      }
    },
    page: {
      on(evt: string, fn: (arg: unknown) => void) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt)?.add(fn);
      },
      off(evt: string, fn: (arg: unknown) => void) {
        listeners.get(evt)?.delete(fn);
      },
      waitForTimeout() {
        // Faithful Playwright behaviour: settling a closed page REJECTS.
        return self.closed
          ? Promise.reject(
              new Error('page.waitForTimeout: Target page, context or browser has been closed'),
            )
          : Promise.resolve();
      },
    } as unknown as Page,
  };
  return self;
}

/**
 * An AdminSession whose `ensureAuthenticated` heals exactly `healTimes` times.
 * A heal closes the live page and opens a new one, then re-navigates ITSELF —
 * mirroring `rebuildAndLogin`, whose navigation no caller has listeners on.
 */
function makeAdmin(healTimes: number): {
  admin: AdminSession;
  pages: FakePage[];
  navs: string[];
} {
  const pages: FakePage[] = [makePage('p0')];
  const navs: string[] = [];
  let healsLeft = healTimes;
  let token = 0;
  const live = (): FakePage => pages[pages.length - 1] as FakePage;

  const admin = {
    getPage: () => live().page,
    getContext: () => ({}) as never,
    async gotoWithRetry(url: string) {
      navs.push(url);
      live().emitAura(`t${++token}`);
    },
    async ensureAuthenticated(targetUrl: string) {
      if (healsLeft <= 0) return;
      healsLeft -= 1;
      live().closed = true; // context torn down — the old page is dead
      pages.push(makePage(`p${pages.length}`));
      // The heal re-navigates on the healed page; nothing of ours is listening.
      navs.push(`heal:${targetUrl}`);
      live().emitAura(`heal${++token}`);
    },
    async isLoginPage() {
      return false;
    },
    async collectAura() {
      return [];
    },
    async purgeState() {},
    async persistIfAuthenticated() {},
    async close() {},
  } as unknown as AdminSession;

  return { admin, pages, navs };
}

describe('captureListPage — mid-run session heal (ADR-0103)', () => {
  it('healthy run: one pass, one navigation, capture intact', async () => {
    const { admin, pages, navs } = makeAdmin(0);

    const cap = await playwrightBackfillSession(admin).captureListPage('/s/outbound-materials');

    expect(navs).toEqual(['https://mrc-us.my.site.com/s/outbound-materials']);
    expect(cap.requestMessages).toHaveLength(1);
    expect(cap.responseBodies).toHaveLength(1);
    expect(cap.framework?.auraToken).toBe('t1');
    expect(pages).toHaveLength(1);
    expect(pages[0]?.listenerCount()).toBe(0); // listeners always detached
  });

  it('a heal does NOT throw the stale-page error, and REPLAYS the capture', async () => {
    const { admin, pages, navs } = makeAdmin(1);
    const logs: string[] = [];

    // Pre-fix this rejected with "Target page, context or browser has been closed".
    const cap = await playwrightBackfillSession(admin, (lvl, m) =>
      logs.push(`${lvl}:${m}`),
    ).captureListPage('/s/outbound-materials');

    expect(pages).toHaveLength(2);
    expect(pages[0]?.closed).toBe(true);

    // The capture is REAL, not empty — this is the quiet half of the defect. The
    // surviving traffic must come from the HEALED page's replayed navigation, not
    // from the dead page's discarded pass.
    expect(cap.requestMessages).toHaveLength(1);
    expect(cap.responseBodies).toHaveLength(1);
    expect(cap.framework).not.toBeNull();
    // t1 = pass 1 (discarded), heal2 = the heal's own unlistened nav, t3 = pass 2.
    expect(cap.framework?.auraToken).toBe('t3');
    expect(cap.responseBodies[0]).toContain('t3');

    // Pass 1 navigated, the heal navigated itself, pass 2 replayed on the new page.
    expect(navs).toEqual([
      'https://mrc-us.my.site.com/s/outbound-materials',
      'heal:https://mrc-us.my.site.com/s/outbound-materials',
      'https://mrc-us.my.site.com/s/outbound-materials',
    ]);

    // No listener is left behind on either page.
    expect(pages[0]?.listenerCount()).toBe(0);
    expect(pages[1]?.listenerCount()).toBe(0);

    expect(logs.some((l) => l.startsWith('warn:') && l.includes('healed mid-capture'))).toBe(true);
  });

  it('a heal on EVERY pass DISCARDS the capture — never a throw, never trusted', async () => {
    // The portal dropping us faster than we can log in is the deadman's story to
    // tell; this loop must not spin forever or explode on a dead page. The final
    // pass DID capture traffic — but off a page that read logged-out, so it must be
    // thrown away rather than replayed (fetchListPage then wedges loud).
    const { admin, pages } = makeAdmin(99);
    const logs: string[] = [];

    const cap = await playwrightBackfillSession(admin, (lvl, m) =>
      logs.push(`${lvl}:${m}`),
    ).captureListPage('/s/outbound-materials');

    expect(cap.requestMessages).toHaveLength(0);
    expect(cap.responseBodies).toHaveLength(0);
    expect(cap.framework).toBeNull();
    expect(pages).toHaveLength(3); // bounded: MAX_CAPTURE_PASSES = 2 heals, no more
    expect(logs.some((l) => l.includes('ABANDONED'))).toBe(true);
  });

  it('does not settle on a page the heal closed', async () => {
    const { admin, pages } = makeAdmin(1);
    await playwrightBackfillSession(admin).captureListPage('/s/hauls');
    // The dead page's waitForTimeout would have rejected; reaching here proves it
    // was never called on it. Guard the guard: it really does reject when closed.
    const dead = pages[0] as FakePage;
    await expect(dead.page.waitForTimeout(1)).rejects.toThrow(/has been closed/);
  });
});
