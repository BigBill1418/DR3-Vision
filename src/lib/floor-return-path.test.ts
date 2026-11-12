// ADR-0078 G8c — the post-PIN return path is validated, not trusted.
//
// `?next=` arrives in a URL, so it is attacker-influenceable, and it is handed
// to `router.push`. An unvalidated push target is an open redirect: a crafted
// link handed to an operator would send them off-site after a successful PIN,
// on a shared device, in a browser they have just authenticated.

import { describe, expect, it } from 'vitest';
import { floorSignInPath, resolveFloorReturnPath } from './floor-return-path';

const HUB = '/operator/eugene/today';

describe('ADR-0078 G8c — resolveFloorReturnPath', () => {
  it('returns the operator to the screen they were on', () => {
    expect(resolveFloorReturnPath('/operator/eugene/count', 'eugene')).toBe(
      '/operator/eugene/count',
    );
    expect(resolveFloorReturnPath('/operator/eugene/load/abc-123', 'eugene')).toBe(
      '/operator/eugene/load/abc-123',
    );
    expect(resolveFloorReturnPath('/operator/eugene/queue/conflicts', 'eugene')).toBe(
      '/operator/eugene/queue/conflicts',
    );
  });

  it('falls back to the hub when there is no destination', () => {
    expect(resolveFloorReturnPath(null, 'eugene')).toBe(HUB);
    expect(resolveFloorReturnPath(undefined, 'eugene')).toBe(HUB);
    expect(resolveFloorReturnPath('', 'eugene')).toBe(HUB);
  });

  // ── The open-redirect cases ─────────────────────────────────────────────
  //
  // FALSIFIED BY HAND: replacing the guard with a bare `next.startsWith('/')`
  // check — the obvious implementation — passes every other test in this file
  // and goes red HERE on `//evil.example`, which is protocol-relative and
  // navigates off-site despite starting with a slash. That is the specific
  // bypass a naive check misses, which is why it has its own case.
  it.each([
    ['https://evil.example/steal', 'absolute URL'],
    ['//evil.example/steal', 'protocol-relative'],
    ['/\\evil.example', 'backslash'],
    ['javascript:alert(1)', 'script scheme'],
    ['/dashboard/eugene', 'off-surface app route'],
    ['/operator/woodland/count', 'a DIFFERENT site'],
    ['/operator/eugene', 'the name picker itself — would bounce straight back out'],
    ['/operator/eugene/', 'trailing slash, no leaf'],
  ])('refuses %s (%s) and falls back to the hub', (candidate) => {
    expect(resolveFloorReturnPath(candidate, 'eugene')).toBe(HUB);
  });

  it('scopes to the signing-in site, not to whatever the URL claims', () => {
    // Same path, different site context: allowed for eugene, refused for woodland.
    expect(resolveFloorReturnPath('/operator/eugene/count', 'eugene')).toBe(
      '/operator/eugene/count',
    );
    expect(resolveFloorReturnPath('/operator/eugene/count', 'woodland')).toBe(
      '/operator/woodland/today',
    );
  });
});

// ADR-0144 — the way BACK to the PIN screen, built from the same validator.
//
// Every signed-out floor surface (the check-in rows, the write-refusal notice and
// the floor pages' own redirects) sends the operator to the name picker with
// `?next=<where they were>`. The link is built here so the encoding exists once,
// and so a path that `resolveFloorReturnPath` would refuse is never emitted.
describe('ADR-0144 — floorSignInPath', () => {
  it('carries the current floor path through the name picker', () => {
    expect(floorSignInPath('woodland', '/operator/woodland/hauls')).toBe(
      '/operator/woodland?next=%2Foperator%2Fwoodland%2Fhauls',
    );
  });

  it('round-trips: what the keypad receives resolves to the same screen', () => {
    for (const here of [
      '/operator/woodland/queue',
      '/operator/woodland/load/abc-123',
      '/operator/woodland/hauls?q=H-1&page=2',
    ]) {
      const next = new URL(floorSignInPath('woodland', here), 'https://x.test').searchParams.get(
        'next',
      );
      expect(resolveFloorReturnPath(next, 'woodland')).toBe(here);
    }
  });

  it.each([
    ['https://evil.example/steal'],
    ['//evil.example/steal'],
    ['/\\evil.example'],
    ['javascript:alert(1)'],
    ['/dashboard/woodland'],
    ['/operator/eugene/count'],
    ['/operator/woodland'],
  ])('drops an unsafe return path %s rather than encoding it', (here) => {
    expect(floorSignInPath('woodland', here)).toBe('/operator/woodland');
  });

  it('with no current path it is the bare name picker', () => {
    expect(floorSignInPath('woodland', null)).toBe('/operator/woodland');
    expect(floorSignInPath('woodland', undefined)).toBe('/operator/woodland');
  });

  it('encodes the site segment rather than splicing it raw', () => {
    expect(floorSignInPath('a?b', null)).toBe('/operator/a%3Fb');
    expect(floorSignInPath('a?b', '/operator/a?b/count')).toMatch(/^\/operator\/a%3Fb\?next=/);
  });
});
