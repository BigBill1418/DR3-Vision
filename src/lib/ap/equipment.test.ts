// ADR-0046 Amendment 5 (D-M5-6), as REVISED 2026-07-28 by operator directive:
// the equipment option list and its server-side validator are now FLEET-WIDE,
// not site-filtered. Active-only still holds, and the validator is still a real
// trust boundary (exists + active).
//
// The pairing below is the load-bearing property: the picker and the validator
// must agree on scope. If one is fleet-wide and the other site-filtered, every
// cross-site pick renders fine and then 400s on save — a broken approval path.

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

describe('listSiteEquipment (fleet-wide as of 2026-07-28)', () => {
  it('returns ACTIVE equipment from EVERY site, alphabetical', async () => {
    const opts = await listSiteEquipment(fp(seed()));
    // "Baler A" < "Box Truck 12" < "Terex 900"
    expect(opts.map((o) => o.id)).toEqual(['eq-w2', 'eq-w1', 'eq-e1']);
  });

  it('still excludes INACTIVE equipment', async () => {
    const opts = await listSiteEquipment(fp(seed()));
    expect(opts.some((o) => o.id === 'eq-w3')).toBe(false);
  });

  it('REGRESSION: no longer excludes another site — that was the directive', async () => {
    const opts = await listSiteEquipment(fp(seed()));
    expect(opts.some((o) => o.id === 'eq-e1')).toBe(true);
  });

  it('carries display name and category through', async () => {
    const opts = await listSiteEquipment(fp(seed()));
    expect(opts.find((o) => o.id === 'eq-e1')).toEqual({
      id: 'eq-e1',
      displayName: 'Terex 900',
      category: 'terex',
    });
  });
});

describe('assertEquipmentForSite (server trust boundary)', () => {
  it('accepts ids that are active, regardless of site', async () => {
    await expect(
      assertEquipmentForSite(fp(seed()), ['eq-w1', 'eq-w2', 'eq-e1']),
    ).resolves.toBeUndefined();
  });

  it('is a no-op for an empty list', async () => {
    await expect(assertEquipmentForSite(fp(seed()), [])).resolves.toBeUndefined();
  });

  it('REGRESSION: accepts an id from a DIFFERENT site (was rejected pre-2026-07-28)', async () => {
    await expect(assertEquipmentForSite(fp(seed()), ['eq-e1'])).resolves.toBeUndefined();
  });

  it('still rejects an INACTIVE id', async () => {
    await expect(assertEquipmentForSite(fp(seed()), ['eq-w3'])).rejects.toBeInstanceOf(
      ApEquipmentInvalidError,
    );
  });

  it('still rejects an unknown id', async () => {
    await expect(assertEquipmentForSite(fp(seed()), ['nope'])).rejects.toBeInstanceOf(
      ApEquipmentInvalidError,
    );
  });

  it('dedupes before validating', async () => {
    await expect(
      assertEquipmentForSite(fp(seed()), ['eq-w1', 'eq-w1', 'eq-w1']),
    ).resolves.toBeUndefined();
  });
});

describe('picker and validator agree on scope', () => {
  // The invariant that keeps the approval path working: anything the picker
  // offers must survive the validator. A mismatch here is exactly the
  // "renders fine, 400s on save" failure this change had to avoid.
  it('every option the picker returns passes the validator', async () => {
    const db = seed();
    const opts = await listSiteEquipment(fp(db));
    await expect(
      assertEquipmentForSite(fp(db), opts.map((o) => o.id)),
    ).resolves.toBeUndefined();
  });
});
