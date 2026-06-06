// T-107 (ADR-0020) — Vision Dashboard visibility matrix tests.
//
// Pure-logic module: no Prisma, no auth mock needed. We drive `canSeeTile` /
// `visibleTiles` with hand-built sessions for the four canonical user types and
// assert the exact tile sets from the ADR-0020 matrix:
//
// As of 2026-06-06 three former-active tiles (operations, compliance,
// reconciliation) are paused to 'coming-soon', so the *active* sets shrank:
//
//   Bill   (admin)              → Bonus + Exports + Admin
//   Janette(Woodland manager)   → Bonus + Exports (no Admin)
//   Morena (both-sites manager) → same as Janette (primary_site_id = null)
//   Rick   (Eugene manager)     → Bonus + Exports (ADR-0019.2 §1; NO Admin)
//
// As of ADR-0019.2 (Eugene enablement, hard rule 6) the bonus tile matrix
// expanded: EVERY manager now passes the bonus gate (Woodland, Eugene, and
// California-ops null all reach at least one bonus site). The `woodlandSiteId`
// arg is retained for back-compat but no longer load-bearing for the bonus tile.
//
// The paused tiles are still *visible* to every manager/admin, just in the
// coming-soon group (asserted below).

import { describe, it, expect } from 'vitest';
import type { Session } from 'next-auth';
import { canSeeTile, visibleTiles, DASHBOARD_TILES } from './dashboard-tiles';

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';

function makeSession(
  role: 'operator' | 'manager' | 'admin',
  primary_site_id: string | null,
): Session {
  return {
    user: { id: 'u1', email: 'u@example.com', name: 'U', role, primary_site_id },
    expires: '2099-01-01T00:00:00.000Z',
  } as Session;
}

const activeKeys = (s: Session) =>
  visibleTiles(s, WOODLAND)
    .filter((t) => t.status === 'active')
    .map((t) => t.key);

describe('canSeeTile / visibleTiles — ADR-0020 matrix', () => {
  it('Bill (admin) sees Bonus + Exports + Admin + Observability active (ops/compliance/recon paused)', () => {
    const bill = makeSession('admin', EUGENE); // admin primary site is irrelevant
    // Observability lit up 2026-06-06 (admin-only); it lives in the COMING_SOON
    // array so it trails the ACTIVE_TILES actives in registry order.
    expect(activeKeys(bill)).toEqual(['bonus', 'exports', 'admin', 'observability']);
  });

  it('Janette (Woodland manager) sees Bonus + Exports active, no Admin', () => {
    const janette = makeSession('manager', WOODLAND);
    expect(activeKeys(janette)).toEqual(['bonus', 'exports']);
    expect(canSeeTile(janette, tileByKey('admin'), WOODLAND)).toBe(false);
    expect(canSeeTile(janette, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Morena (both-sites manager, primary_site_id null) sees the same as Janette', () => {
    const morena = makeSession('manager', null);
    expect(activeKeys(morena)).toEqual(['bonus', 'exports']);
    expect(canSeeTile(morena, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Rick (Eugene manager) now sees Bonus + Exports — ADR-0019.2 §1, NO Admin', () => {
    // The bonus tile matrix expanded (hard rule 6): Rick (Eugene) passes the
    // bonus gate. He still has no Admin & Audit (admin-only).
    const rick = makeSession('manager', EUGENE);
    expect(activeKeys(rick)).toEqual(['bonus', 'exports']);
    expect(canSeeTile(rick, tileByKey('bonus'), WOODLAND)).toBe(true);
    expect(canSeeTile(rick, tileByKey('admin'), WOODLAND)).toBe(false);
  });

  it('operator and anonymous see nothing', () => {
    const op = makeSession('operator', WOODLAND);
    expect(visibleTiles(op, WOODLAND)).toEqual([]);
    expect(visibleTiles(null, WOODLAND)).toEqual([]);
    expect(canSeeTile(op, tileByKey('operations'), WOODLAND)).toBe(false);
  });

  it('coming-soon tiles are visible to every manager/admin (Rick included), in registry order', () => {
    const rick = makeSession('manager', EUGENE);
    const comingSoon = visibleTiles(rick, WOODLAND).filter((t) => t.status === 'coming-soon');
    // The three paused tiles (operations, compliance, reconciliation) sit where
    // they always did in ACTIVE_TILES, so they lead the coming-soon group.
    expect(comingSoon.map((t) => t.key)).toEqual([
      'operations',
      'compliance',
      'reconciliation',
      'bulk-upload',
      'photo-annotation',
      'processor-workflow',
      'cip-capture',
      'mrc-api',
    ]);
    // 'observability' is no longer here — lit up 2026-06-06 (active, admin-only),
    // so Rick (manager) doesn't see it at all.
  });

  it('the three paused tiles carry status coming-soon (2026-06-06 flip)', () => {
    for (const key of ['operations', 'compliance', 'reconciliation']) {
      expect(tileByKey(key).status).toBe('coming-soon');
    }
  });

  it('only the bonus tile is featured', () => {
    const featured = DASHBOARD_TILES.filter((t) => t.featured);
    expect(featured.map((t) => t.key)).toEqual(['bonus']);
  });

  it('bonus tile no longer depends on the resolved Woodland id (ADR-0019.2)', () => {
    // The matrix expanded: every manager sees bonus regardless of the
    // (now-unused) woodlandSiteId arg — Woodland, Eugene, and California-ops null.
    expect(canSeeTile(makeSession('manager', WOODLAND), tileByKey('bonus'))).toBe(true);
    expect(canSeeTile(makeSession('manager', EUGENE), tileByKey('bonus'))).toBe(true);
    expect(canSeeTile(makeSession('manager', null), tileByKey('bonus'))).toBe(true);
    // operators still never see it.
    expect(canSeeTile(makeSession('operator', WOODLAND), tileByKey('bonus'))).toBe(false);
  });
});

function tileByKey(key: string) {
  const t = DASHBOARD_TILES.find((x) => x.key === key);
  if (!t) throw new Error(`no tile ${key}`);
  return t;
}
