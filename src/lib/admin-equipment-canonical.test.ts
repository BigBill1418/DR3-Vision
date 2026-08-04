// ADR-0075 D3 — the near-duplicate DETECTOR.
//
// `canonicalizeName` is what lets the app notice that "Terex Machine" and "Terex
// machine" are the same asset, in a world where the DATABASE deliberately does
// not (a case-insensitive unique index cannot be added: production holds a
// violating pair today, and migrations run in the deploy's init container, so a
// unique index that cannot build would crash-loop the deploy).
//
// Because the constraint is gone, this function IS the guard. Its exact
// behaviour — including the blindness it accepts — is pinned here.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Equip {
  id: string;
  site_id: string;
  display_name: string;
  category: string;
  is_active: boolean;
  merged_into_id: string | null;
}

const WOODLAND = 'site-woodland';
const EUGENE = 'site-eugene';
const equipment: Equip[] = [];

const fakePrisma = {
  equipment: {
    findMany: vi.fn(async ({ where }: { where?: { site_id?: string } } = {}) =>
      equipment
        .filter((e) => !where?.site_id || e.site_id === where.site_id)
        .map((e) => ({ ...e })),
    ),
  },
  site: {
    findMany: vi.fn(async () => [
      { id: EUGENE, code: 'eugene' },
      { id: WOODLAND, code: 'woodland' },
    ]),
  },
};

const holder = vi.hoisted(() => ({ current: null as unknown as Record<string, unknown> }));
vi.mock('@/lib/prisma', () => ({
  prisma: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => holder.current[prop],
  }),
}));
holder.current = fakePrisma as unknown as Record<string, unknown>;

import { canonicalizeName, findSimilarEquipment } from './admin-equipment';

describe('canonicalizeName', () => {
  it('folds case and collapses whitespace — the exact 2026-08-04 collision', () => {
    const canon = canonicalizeName('Terex Machine');
    expect(canonicalizeName('terex machine')).toBe(canon);
    expect(canonicalizeName('TEREX  MACHINE')).toBe(canon);
    expect(canonicalizeName('  Terex   Machine  ')).toBe(canon);
    expect(canon).toBe('terexmachine');
  });

  it('strips punctuation, including the em dash the seeded roster uses', () => {
    expect(canonicalizeName('EQ43 — Shear')).toBe(canonicalizeName('eq43 shear'));
    expect(canonicalizeName('EQ43 — Shear')).toBe('eq43shear');
    expect(canonicalizeName('EQ-43 Shear!')).toBe('eq43shear');
  });

  it('returns empty for a name with nothing alphanumeric in it', () => {
    expect(canonicalizeName('   ')).toBe('');
    expect(canonicalizeName('— · —')).toBe('');
  });

  it('does NOT conflate genuinely different assets — the accepted blind spot', () => {
    // "Terex" and "Terex 2" are different machines and must stay different. The
    // detector catches the typo-shaped duplicate; the merge tool catches the rest.
    expect(canonicalizeName('Terex')).not.toBe(canonicalizeName('Terex 2'));
    expect(canonicalizeName('Terex')).not.toBe(canonicalizeName('Terex Machine'));
  });
});

describe('findSimilarEquipment', () => {
  beforeEach(() => {
    equipment.length = 0;
    equipment.push(
      {
        id: 'a',
        site_id: WOODLAND,
        display_name: 'Terex Machine',
        category: 'terex',
        is_active: true,
        merged_into_id: null,
      },
      {
        id: 'b',
        site_id: WOODLAND,
        display_name: 'Terex machine',
        category: 'terex',
        is_active: false,
        merged_into_id: null,
      },
      {
        id: 'c',
        site_id: WOODLAND,
        display_name: 'Terex',
        category: 'terex',
        is_active: true,
        merged_into_id: null,
      },
      {
        id: 'd',
        site_id: WOODLAND,
        display_name: 'TEREX  MACHINE',
        category: 'terex',
        is_active: true,
        merged_into_id: 'a',
      },
      {
        id: 'e',
        site_id: EUGENE,
        display_name: 'Terex Machine',
        category: 'terex',
        is_active: true,
        merged_into_id: null,
      },
    );
  });

  it('finds every case-folded variant at the site, INCLUDING inactive and merged', async () => {
    const rows = await findSimilarEquipment(WOODLAND, 'terex machine');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'd']);
    // The inactive one must be visible or the operator forks it instead of
    // reactivating it; the merged one must be visible or its name looks lost.
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ isActive: false });
    expect(rows.find((r) => r.id === 'd')).toMatchObject({ mergedIntoId: 'a' });
  });

  it('does NOT reach across the site boundary (hard rule #2)', async () => {
    const rows = await findSimilarEquipment(WOODLAND, 'Terex Machine');
    expect(rows.map((r) => r.id)).not.toContain('e');
    expect(rows.every((r) => r.siteCode === 'woodland')).toBe(true);
  });

  it('excludes a name that merely SHARES a prefix', async () => {
    expect((await findSimilarEquipment(WOODLAND, 'Terex')).map((r) => r.id)).toEqual(['c']);
  });

  it('returns nothing for an empty or punctuation-only name — never the whole registry', async () => {
    expect(await findSimilarEquipment(WOODLAND, '')).toEqual([]);
    expect(await findSimilarEquipment(WOODLAND, ' — ')).toEqual([]);
    expect(await findSimilarEquipment('', 'Terex')).toEqual([]);
  });
});
