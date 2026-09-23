// ADR-0075 D3 — the near-duplicate DETECTOR, as reworked by ADR-0135.
//
// `canonicalizeName` is what lets the app notice that "Terex Machine" and "Terex
// machine" are the same asset. ADR-0135 made `findSimilarEquipment` a thin
// wrapper over the shared unit-aware matcher (`@/lib/equipment/match`, pinned
// in its own test): it now searches the WHOLE FLEET (trailers move between
// yards), and a merged loser is replaced by its survivor instead of being
// returned as itself. The database also now refuses a live case/whitespace-only
// duplicate (`equipment_live_name_ci_key`), proven in `admin-equipment.db.test.ts`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface Equip {
  id: string;
  site_id: string | null;
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

  it('finds every case-folded variant FLEET-WIDE, including inactive; a merged row resolves to its survivor', async () => {
    const rows = await findSimilarEquipment('terex machine');
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'e']);
    // The inactive one must be visible or the operator forks it instead of
    // reactivating it. The merged `d` is NOT returned as itself — its name still
    // finds its survivor `a`.
    expect(rows.find((r) => r.id === 'b')).toMatchObject({ isActive: false });
    expect(rows.every((r) => r.mergedIntoId === null)).toBe(true);
  });

  it('reaches across sites (ADR-0135: the same trailer is filed at both yards)', async () => {
    const rows = await findSimilarEquipment('Terex Machine');
    expect(rows.find((r) => r.id === 'e')).toMatchObject({ siteCode: 'eugene' });
  });

  it('excludes a name that merely SHARES a word — a word hit is search, not a duplicate', async () => {
    expect((await findSimilarEquipment('Terex')).map((r) => r.id)).toEqual(['c']);
  });

  it('returns nothing for an empty or punctuation-only name — never the whole registry', async () => {
    expect(await findSimilarEquipment('')).toEqual([]);
    expect(await findSimilarEquipment(' — ')).toEqual([]);
  });
});
