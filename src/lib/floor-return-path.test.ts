// ADR-0078 G8c — the post-PIN return path is validated, not trusted.
//
// `?next=` arrives in a URL, so it is attacker-influenceable, and it is handed
// to `router.push`. An unvalidated push target is an open redirect: a crafted
// link handed to an operator would send them off-site after a successful PIN,
// on a shared device, in a browser they have just authenticated.

import { describe, expect, it } from 'vitest';
import { resolveFloorReturnPath } from './floor-return-path';

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
