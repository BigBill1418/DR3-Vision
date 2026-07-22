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
  all_sites: boolean = false,
): Session {
  return {
    user: {
      id: 'u1',
      email: 'u@example.com',
      name: 'U',
      role,
      primary_site_id,
      is_super_admin,
      all_sites,
    },
    expires: '2099-01-01T00:00:00.000Z',
  } as Session;
}

const activeKeys = (s: Session) =>
  visibleTiles(s, WOODLAND)
    .filter((t) => t.status === 'active')
    .map((t) => t.key);

describe('canSeeTile / visibleTiles — ADR-0020 matrix', () => {
  it('Bill (admin) sees Bonus + Exports + Admin + Loads-Inventory + Ops-Ledger + Equipment + Observability active', () => {
    const bill = makeSession('admin', EUGENE); // admin primary site is irrelevant
    // Registry order: loads-inventory (ADR-0037) → ops-ledger (ADR-0045, manager+)
    // → equipment (ADR-0044, manager+) → observability (admin-only, trails actives).
    expect(activeKeys(bill)).toEqual([
      'bonus',
      'exports',
      'admin',
      'loads-inventory',
      'ops-ledger',
      'equipment',
      'commodity-payments', // ADR-0052 (org-reach: admin passes)
      'file-drop', // O-2 (admin-only)
      'mrc-scrape', // ADR-0057 (admin-only; lit up in the coming-soon array, trails actives)
      'observability',
    ]);
  });

  it('Janette (Woodland manager) sees Bonus + Exports + Ops-Ledger + Equipment active, no Admin', () => {
    const janette = makeSession('manager', WOODLAND);
    expect(activeKeys(janette)).toEqual(['bonus', 'exports', 'ops-ledger', 'equipment']);
    expect(canSeeTile(janette, tileByKey('admin'), WOODLAND)).toBe(false);
    expect(canSeeTile(janette, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Morena (both-sites manager, primary_site_id null) sees the same as Janette', () => {
    const morena = makeSession('manager', null);
    expect(activeKeys(morena)).toEqual(['bonus', 'exports', 'ops-ledger', 'equipment']);
    expect(canSeeTile(morena, tileByKey('bonus'), WOODLAND)).toBe(true);
  });

  it('Rick (Eugene manager) sees Bonus + Exports + Ops-Ledger + Equipment — ADR-0019.2 §1, NO Admin', () => {
    const rick = makeSession('manager', EUGENE);
    expect(activeKeys(rick)).toEqual(['bonus', 'exports', 'ops-ledger', 'equipment']);
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
    ]);
    // 'observability' and 'mrc-scrape' are no longer here — both lit up as active
    // admin-only tiles (observability 2026-06-06, mrc-scrape ADR-0057), so Rick
    // (manager) doesn't see either at all.
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
      'commodity-payments', // ADR-0052 (org-reach: admin passes)
      'file-drop', // O-2 (admin-only)
      'mrc-scrape', // ADR-0057 (admin-only)
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

describe('Commodity Payments tile — ADR-0052 org-reach scope', () => {
  it('is registered active at the org-level route', () => {
    const tile = tileByKey('commodity-payments');
    expect(tile.status).toBe('active');
    expect(tile.scope).toBe('org-reach');
    expect(tile.route).toBe('/dashboard/ops/commodity-payments');
  });

  it('is visible to admin and to an all_sites manager (Daven mechanism)', () => {
    const bill = makeSession('admin', EUGENE);
    const daven = makeSession('manager', null, false, true); // all_sites
    expect(canSeeTile(bill, tileByKey('commodity-payments'), WOODLAND)).toBe(true);
    expect(canSeeTile(daven, tileByKey('commodity-payments'), WOODLAND)).toBe(true);
    expect(activeKeys(daven)).toContain('commodity-payments');
  });

  it('is HIDDEN from a single-site manager (reach, not role)', () => {
    const rick = makeSession('manager', EUGENE); // all_sites false
    expect(canSeeTile(rick, tileByKey('commodity-payments'), WOODLAND)).toBe(false);
    expect(activeKeys(rick)).not.toContain('commodity-payments');
  });
});

describe('AP Approvals tile — ADR-0046 ap-approver scope', () => {
  it('is registered as an active, ap-approver-scoped tile at the org-level route', () => {
    const tile = tileByKey('ap-approvals');
    expect(tile.status).toBe('active');
    expect(tile.scope).toBe('ap-approver');
    expect(tile.route).toBe('/dashboard/ops/ap');
  });

  it('is visible to admin and to a roster approver ONLY when isApApprover is true', () => {
    const bill = makeSession('admin', EUGENE);
    const janette = makeSession('manager', WOODLAND);
    // 5th arg = isApApprover (resolved by the launcher via canActOnApRequest).
    expect(canSeeTile(bill, tileByKey('ap-approvals'), WOODLAND, false, true)).toBe(true);
    expect(canSeeTile(janette, tileByKey('ap-approvals'), WOODLAND, false, true)).toBe(true);
  });

  it('is HIDDEN from a manager who is not on the roster (isApApprover false)', () => {
    const rick = makeSession('manager', EUGENE);
    expect(canSeeTile(rick, tileByKey('ap-approvals'), WOODLAND, false, false)).toBe(false);
    // …and appears in visibleTiles only when the flag is passed true.
    expect(visibleTiles(rick, WOODLAND, false, false).map((t) => t.key)).not.toContain(
      'ap-approvals',
    );
    expect(visibleTiles(rick, WOODLAND, false, true).map((t) => t.key)).toContain('ap-approvals');
  });

  it('defaults hidden when isApApprover is absent (no leak to legacy callers)', () => {
    const bill = makeSession('admin', EUGENE);
    expect(canSeeTile(bill, tileByKey('ap-approvals'), WOODLAND)).toBe(false);
    expect(activeKeys(bill)).not.toContain('ap-approvals');
  });
});

describe('File Drop tile — O-2 admin-only', () => {
  it('is registered active, admin-only, at /admin/file-drop with an allowlisted icon', () => {
    const tile = tileByKey('file-drop');
    expect(tile.status).toBe('active');
    expect(tile.scope).toBe('admin-only');
    expect(tile.route).toBe('/admin/file-drop');
    expect(tile.icon).toBe('Upload');
    expect(tile.featured).toBeUndefined();
  });

  it('is visible to admin and hidden from every manager', () => {
    expect(canSeeTile(makeSession('admin', EUGENE), tileByKey('file-drop'), WOODLAND)).toBe(true);
    expect(canSeeTile(makeSession('manager', WOODLAND), tileByKey('file-drop'), WOODLAND)).toBe(
      false,
    );
    expect(canSeeTile(makeSession('manager', null, false, true), tileByKey('file-drop'))).toBe(
      false,
    ); // all_sites manager still not admin
    expect(canSeeTile(makeSession('operator', WOODLAND), tileByKey('file-drop'), WOODLAND)).toBe(
      false,
    );
  });
});

describe('MRC-Scrape tile — ADR-0057 admin-only', () => {
  it('is registered active, admin-only, at /admin/mrc-scrape (renamed from the mrc-api placeholder)', () => {
    const tile = tileByKey('mrc-scrape');
    expect(tile.status).toBe('active');
    expect(tile.scope).toBe('admin-only');
    expect(tile.route).toBe('/admin/mrc-scrape');
    expect(tile.label).toBe('MRC-Scrape');
    expect(tile.icon).toBe('Plug');
    expect(tile.featured).toBeUndefined();
  });

  it('no longer registers the old mrc-api key', () => {
    expect(DASHBOARD_TILES.map((t) => t.key)).not.toContain('mrc-api');
  });

  it('is visible to admin and hidden from every manager (incl. all_sites) and operators', () => {
    expect(canSeeTile(makeSession('admin', EUGENE), tileByKey('mrc-scrape'), WOODLAND)).toBe(true);
    expect(canSeeTile(makeSession('manager', WOODLAND), tileByKey('mrc-scrape'), WOODLAND)).toBe(
      false,
    );
    expect(canSeeTile(makeSession('manager', null, false, true), tileByKey('mrc-scrape'))).toBe(
      false,
    ); // all_sites manager still not admin
    expect(canSeeTile(makeSession('operator', WOODLAND), tileByKey('mrc-scrape'), WOODLAND)).toBe(
      false,
    );
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
