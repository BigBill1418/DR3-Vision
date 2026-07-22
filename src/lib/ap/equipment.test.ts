// ADR-0046 Amendment 5 (D-M5-6) — equipment listing (site-filtered, active-only)
// and the server-side validation that rejects equipment ids not on the site.

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { makeFakePrisma, newFakeDb, type FakeDb } from './__testutils__/fake-prisma';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));

import { ApEquipmentInvalidError, assertEquipmentForSite, listSiteEquipment } from './equipment';

const fp = (db: FakeDb) => makeFakePrisma(db) as unknown as PrismaClient;

const seed = () =>
  newFakeDb({
    equipment: [
      { id: 'eq-w1', site_id: 'site-w', display_name: 'Box Truck 12', category: 'vehicle', is_active: true },
      { id: 'eq-w2', site_id: 'site-w', display_name: 'Baler A', category: 'baler', is_active: true },
      { id: 'eq-w3', site_id: 'site-w', display_name: 'Retired Forklift', category: 'forklift', is_active: false },
      { id: 'eq-e1', site_id: 'site-e', display_name: 'Terex 900', category: 'terex', is_active: true },
    ],
  });

describe('listSiteEquipment', () => {
  it('returns only ACTIVE equipment for the site, alphabetical', async () => {
    const opts = await listSiteEquipment(fp(seed()), 'site-w');
    expect(opts.map((o) => o.id)).toEqual(['eq-w2', 'eq-w1']); // "Baler A" < "Box Truck 12"
    expect(opts.some((o) => o.id === 'eq-w3')).toBe(false); // inactive excluded
    expect(opts.some((o) => o.id === 'eq-e1')).toBe(false); // other site excluded
  });
});

describe('assertEquipmentForSite (server trust boundary)', () => {
  it('accepts ids that are active and on the site', async () => {
    await expect(assertEquipmentForSite(fp(seed()), 'site-w', ['eq-w1', 'eq-w2'])).resolves.toBeUndefined();
  });

  it('is a no-op for an empty list', async () => {
    await expect(assertEquipmentForSite(fp(seed()), 'site-w', [])).resolves.toBeUndefined();
  });

  it('rejects an id from a DIFFERENT site', async () => {
    await expect(assertEquipmentForSite(fp(seed()), 'site-w', ['eq-e1'])).rejects.toBeInstanceOf(
      ApEquipmentInvalidError,
    );
  });

  it('rejects an INACTIVE id', async () => {
    await expect(assertEquipmentForSite(fp(seed()), 'site-w', ['eq-w3'])).rejects.toBeInstanceOf(
      ApEquipmentInvalidError,
    );
  });

  it('rejects an unknown id', async () => {
    await expect(assertEquipmentForSite(fp(seed()), 'site-w', ['nope'])).rejects.toBeInstanceOf(
      ApEquipmentInvalidError,
    );
  });
});
