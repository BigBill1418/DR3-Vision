// ADR-0065 — operator navigation resolution.
//
// The load-bearing property is NOBODY IS EVER STRANDED: from every screen an
// authenticated operator can reach, there is at least one explicit way out.

import { describe, it, expect } from 'vitest';
import { resolveFloorNav } from './floor-nav';

const SITE = 'eugene';

describe('resolveFloorNav', () => {
  it('gives the site picker no back (nothing above it) and no Log Out (no session)', () => {
    expect(resolveFloorNav('/operator')).toEqual({
      siteCode: null,
      backHref: null,
      showLogOut: false,
      isAuthSurface: true,
    });
  });

  it('sends the name picker back to the site picker', () => {
    expect(resolveFloorNav(`/operator/${SITE}`)).toMatchObject({
      siteCode: SITE,
      backHref: '/operator',
      showLogOut: false,
    });
  });

  it('sends the PIN keypad back to the name picker ("Not you? Switch user")', () => {
    // A user id — not a known working segment.
    expect(resolveFloorNav(`/operator/${SITE}/clx8f3k2a0000abcd1234efgh`)).toMatchObject({
      backHref: `/operator/${SITE}`,
      showLogOut: false,
      isAuthSurface: true,
    });
  });

  it('gives the hub no back but DOES give it Log Out', () => {
    // The hub is the post-PIN home and the back destination for everything
    // else, so a back pill there would point at the page you are on.
    expect(resolveFloorNav(`/operator/${SITE}/today`)).toMatchObject({
      backHref: null,
      showLogOut: true,
      isAuthSurface: false,
    });
  });

  it('routes every working screen back to the hub, with Log Out', () => {
    for (const seg of ['queue', 'inbound', 'count', 'processed']) {
      expect(resolveFloorNav(`/operator/${SITE}/${seg}`), seg).toMatchObject({
        backHref: `/operator/${SITE}/today`,
        showLogOut: true,
        isAuthSurface: false,
      });
    }
  });

  it('gives the per-load dock workflow a way out (it previously had NONE)', () => {
    // /operator/<site>/load/<id> is a 7-stage workflow whose only exits were
    // submit and reject. This is the regression guard for that.
    const nav = resolveFloorNav(`/operator/${SITE}/load/abc-123`);
    expect(nav.backHref).toBe(`/operator/${SITE}/today`);
    expect(nav.showLogOut).toBe(true);
  });

  it('never strands: every post-auth screen offers back OR Log Out', () => {
    const postAuth = [
      `/operator/${SITE}/today`,
      `/operator/${SITE}/queue`,
      `/operator/${SITE}/inbound`,
      `/operator/${SITE}/count`,
      `/operator/${SITE}/processed`,
      `/operator/${SITE}/load/abc-123`,
    ];
    for (const path of postAuth) {
      const nav = resolveFloorNav(path);
      expect(Boolean(nav.backHref) || nav.showLogOut, path).toBe(true);
    }
  });

  it('never strands: every PRE-auth screen offers back, except the top one', () => {
    expect(resolveFloorNav(`/operator/${SITE}`).backHref).toBeTruthy();
    expect(resolveFloorNav(`/operator/${SITE}/some-user-id`).backHref).toBeTruthy();
    // The site picker is the top of the tree — nothing above it to go back to.
    expect(resolveFloorNav('/operator').backHref).toBeNull();
  });

  it('paints the pre-PIN trio black and the working screens green (ADR-0014)', () => {
    expect(resolveFloorNav('/operator').isAuthSurface).toBe(true);
    expect(resolveFloorNav(`/operator/${SITE}`).isAuthSurface).toBe(true);
    expect(resolveFloorNav(`/operator/${SITE}/user-id`).isAuthSurface).toBe(true);
    expect(resolveFloorNav(`/operator/${SITE}/today`).isAuthSurface).toBe(false);
    expect(resolveFloorNav(`/operator/${SITE}/queue`).isAuthSurface).toBe(false);
  });

  it('tolerates a trailing slash', () => {
    expect(resolveFloorNav(`/operator/${SITE}/today/`)).toMatchObject({ showLogOut: true });
  });
});
