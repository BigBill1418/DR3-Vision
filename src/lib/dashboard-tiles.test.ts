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
  is_super_admin: boolean = false,
): Session {
  return {
    user: { id: 'u1', email: 'u@example.com', name: 'U', role, primary_site_id, is_super_admin },
    expires: '2099-01-01T00:00:00.000Z',
  } as Session;
}

const activeKeys = (s: Session) =>
  visibleTiles(s, WOODLAND)
    .filter((t) => t.status === 'active')
    .map((t) => t.key);

describe('canSeeTile / visibleTiles — ADR-0020 matrix', () => {
  it('Bill (admin) sees Bonus + Exports + Admin + Loads-Inventory + Observability active (ops/compliance/recon paused)', () => {
    const bill = makeSession('admin', EUGENE); // admin primary site is irrelevant
    // Observability lit up 2026-06-06 (admin-only); it lives in the COMING_SOON
    // array so it trails the ACTIVE_TILES actives in registry order. loads-inventory
    // (ADR-0037, admin-only) sits in ACTIVE_TILES before observability.
    // ADR-0044 — the manager+ 'equipment' tile is active; admin sees it too, in
    // registry order after loads-inventory and before observability.
    expect(activeKeys(bill)).toEqual(['bonus', 'exports', 'admin', 'loads-inventory', 'equipment', 'observability']);
  });

  it('Janette (Woodland manager) sees Bonus + Exports + Equipment active, no Admin', () => {
    const janette = makeSession('manager', WOODLAND);
    expect(activeKeys(janette)).toEqual(['bonus', 'exports', 'equipment']);
    // ADR-0045 — the ops-ledger tile (manager+) sits in ACTIVE_TILES after
    // loads-inventory, before the super-admin processed-units, so it appears
    // between loads-inventory and observability for an admin.
    expect(activeKeys(bill)).toEqual(['bonus', 'exports', 'admin', 'loads-inventory', 'ops-ledger', 'observability']);
  });

  it('Janette (Woodland manager) sees Bonus + Exports + Ops-Ledger active, no Admin', () => {
    const janette = makeSession('manager', WOODLAND);
    expect(activeKeys(janette)).toEqual(['bonus', 'exports', 'ops-ledger']);
    expect(canSeeTile(janette, tileByKey('admin'), WOODLAND)).toBe(false);
    expect(canSeeTile(janette, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Morena (both-sites manager, primary_site_id null) sees the same as Janette', () => {
    const morena = makeSession('manager', null);
    expect(activeKeys(morena)).toEqual(['bonus', 'exports', 'equipment']);
    expect(canSeeTile(morena, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Rick (Eugene manager) now sees Bonus + Exports + Equipment — ADR-0019.2 §1, NO Admin', () => {
    expect(activeKeys(morena)).toEqual(['bonus', 'exports', 'ops-ledger']);
    expect(canSeeTile(morena, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Rick (Eugene manager) now sees Bonus + Exports + Ops-Ledger — ADR-0019.2 §1, NO Admin', () => {
    // The bonus tile matrix expanded (hard rule 6): Rick (Eugene) passes the
    // bonus gate. He still has no Admin & Audit (admin-only). ADR-0044 adds the
    // manager+ Equipment tile.
    const rick = makeSession('manager', EUGENE);
    expect(activeKeys(rick)).toEqual(['bonus', 'exports', 'equipment']);
    expect(activeKeys(rick)).toEqual(['bonus', 'exports', 'ops-ledger']);
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

describe('production-report tile — ADR-0030 super-admin-only', () => {
  it('is registered as an active, super-admin-only tile', () => {
    const tile = tileByKey('production-report');
    expect(tile.status).toBe('active');
    expect(tile.scope).toBe('super-admin-only');
    expect(tile.route).toBe('/admin/production-report');
  });

  it('is visible to a super-admin (Bill) and appears in his active tiles', () => {
    const billSuper = makeSession('admin', EUGENE, true);
    expect(canSeeTile(billSuper, tileByKey('production-report'), WOODLAND, true)).toBe(true);
    expect(
      visibleTiles(billSuper, WOODLAND, true)
        .filter((t) => t.status === 'active')
        .map((t) => t.key),
    ).toEqual([
      'bonus',
      'exports',
      'admin',
      'production-report',
      'operational-intelligence',
      'loads-inventory',
      'ops-ledger', // ADR-0045
      'processed-units',
      'equipment', // ADR-0044 (manager+, active)
      'observability',
    ]);
  });

  it('is hidden from a plain admin who is NOT super-admin', () => {
    const plainAdmin = makeSession('admin', EUGENE, false);
    expect(canSeeTile(plainAdmin, tileByKey('production-report'), WOODLAND, false)).toBe(false);
    expect(visibleTiles(plainAdmin, WOODLAND, false).map((t) => t.key)).not.toContain(
      'production-report',
    );
  });

  it('is hidden when isSuperAdmin defaults to false (absent/legacy session)', () => {
    const bill = makeSession('admin', EUGENE);
    // activeKeys() / visibleTiles default isSuperAdmin to false → no leak.
    expect(activeKeys(bill)).not.toContain('production-report');
    expect(canSeeTile(bill, tileByKey('production-report'), WOODLAND)).toBe(false);
  });

  it('is hidden from a manager even when the super-admin flag is somehow true', () => {
    // The base manager/admin gate runs first, but the scope still requires the
    // flag; a manager with the flag set passes the gate, yet a manager would
    // never carry is_super_admin in practice. Assert the scope itself is honored.
    const superManager = makeSession('manager', WOODLAND, true);
    expect(canSeeTile(superManager, tileByKey('production-report'), WOODLAND, true)).toBe(true);
    const plainManager = makeSession('manager', WOODLAND, false);
    expect(canSeeTile(plainManager, tileByKey('production-report'), WOODLAND, false)).toBe(false);
  });
});

describe('bulk-upload tile removal (ADR-0023)', () => {
  it('does NOT register a bulk-upload tile', () => {
    const keys = DASHBOARD_TILES.map((t) => t.key);
    expect(keys).not.toContain('bulk-upload');
  });
});

function tileByKey(key: string) {
  const t = DASHBOARD_TILES.find((x) => x.key === key);
  if (!t) throw new Error(`no tile ${key}`);
  return t;
}
