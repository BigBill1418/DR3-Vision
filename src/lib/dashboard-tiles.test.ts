// T-107 (ADR-0020) — Vision Dashboard visibility matrix tests.
//
// Pure-logic module: no Prisma, no auth mock needed. We drive `canSeeTile` /
// `visibleTiles` with hand-built sessions for the four canonical user types and
// assert the exact tile sets from the ADR-0020 matrix:
//
//   Bill   (admin)              → all 6 active tiles
//   Janette(Woodland manager)   → Bonus + Ops + Compliance + Recon + Exports (no Admin)
//   Morena (both-sites manager) → same as Janette (primary_site_id = null)
//   Rick   (Eugene manager)     → Ops + Compliance + Recon + Exports (NO Bonus, no Admin)
//
// The bonus rule keys off Woodland's site id, so every call threads it in,
// matching how the page resolves it from Prisma.

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
  it('Bill (admin) sees all 6 active tiles', () => {
    const bill = makeSession('admin', EUGENE); // admin primary site is irrelevant
    expect(activeKeys(bill)).toEqual([
      'bonus',
      'operations',
      'compliance',
      'reconciliation',
      'exports',
      'admin',
    ]);
  });

  it('Janette (Woodland manager) sees Bonus + Ops + Compliance + Recon + Exports, no Admin', () => {
    const janette = makeSession('manager', WOODLAND);
    expect(activeKeys(janette)).toEqual([
      'bonus',
      'operations',
      'compliance',
      'reconciliation',
      'exports',
    ]);
    expect(canSeeTile(janette, tileByKey('admin'), WOODLAND)).toBe(false);
    expect(canSeeTile(janette, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Morena (both-sites manager, primary_site_id null) sees the same as Janette', () => {
    const morena = makeSession('manager', null);
    expect(activeKeys(morena)).toEqual([
      'bonus',
      'operations',
      'compliance',
      'reconciliation',
      'exports',
    ]);
    expect(canSeeTile(morena, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Rick (Eugene manager) sees Ops + Compliance + Recon + Exports — NO Bonus, no Admin', () => {
    const rick = makeSession('manager', EUGENE);
    expect(activeKeys(rick)).toEqual(['operations', 'compliance', 'reconciliation', 'exports']);
    expect(canSeeTile(rick, tileByKey('bonus'), WOODLAND)).toBe(false);
    expect(canSeeTile(rick, tileByKey('admin'), WOODLAND)).toBe(false);
  });

  it('operator and anonymous see nothing', () => {
    const op = makeSession('operator', WOODLAND);
    expect(visibleTiles(op, WOODLAND)).toEqual([]);
    expect(visibleTiles(null, WOODLAND)).toEqual([]);
    expect(canSeeTile(op, tileByKey('operations'), WOODLAND)).toBe(false);
  });

  it('coming-soon tiles are visible to every manager/admin (Rick included)', () => {
    const rick = makeSession('manager', EUGENE);
    const comingSoon = visibleTiles(rick, WOODLAND).filter((t) => t.status === 'coming-soon');
    expect(comingSoon.map((t) => t.key)).toEqual([
      'bulk-upload',
      'photo-annotation',
      'processor-workflow',
      'cip-capture',
      'mrc-api',
      'observability',
    ]);
  });

  it('only the bonus tile is featured', () => {
    const featured = DASHBOARD_TILES.filter((t) => t.featured);
    expect(featured.map((t) => t.key)).toEqual(['bonus']);
  });

  it('without a resolved Woodland id, a Woodland-bound manager loses bonus (fail-closed)', () => {
    const janette = makeSession('manager', WOODLAND);
    // null woodlandSiteId: primary_site_id 'site-woodland' !== null and !== null
    expect(canSeeTile(janette, tileByKey('bonus'))).toBe(false);
    // but a both-sites manager (null) still passes regardless of resolution
    const morena = makeSession('manager', null);
    expect(canSeeTile(morena, tileByKey('bonus'))).toBe(true);
  });
});

function tileByKey(key: string) {
  const t = DASHBOARD_TILES.find((x) => x.key === key);
  if (!t) throw new Error(`no tile ${key}`);
  return t;
}
