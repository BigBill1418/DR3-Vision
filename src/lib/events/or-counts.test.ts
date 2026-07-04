// ADR-0041 D3 — OR collection-site counts service. Proves the OR-only
// jurisdiction gate (CA refused), first-of-month anchoring, validation, and the
// edit-before-lock guard.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CountRow {
  id: string;
  site_id: string;
  billing_month: Date;
  location: string;
  units: number;
  source: string;
  locked_at: Date | null;
}
const store = {
  rows: [] as CountRow[],
  audits: [] as unknown[],
  sites: new Map<string, { jurisdiction: string }>(),
};

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.rows.find((r) => r.id === where.id) ?? null,
    findMany: async () => store.rows,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `c${store.rows.length + 1}`,
        locked_at: null,
        ...data,
      } as unknown as CountRow;
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = store.rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
  };
  return {
    prisma: {
      site: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          store.sites.get(where.id) ?? null,
      },
      orCollectionSiteCount: model,
      auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          orCollectionSiteCount: model,
          auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
        }),
    },
  };
});

import { createOrCount, updateOrCount, JurisdictionNotAllowedError } from './or-counts';
import {
  RecordLockedError,
  RecordNotFoundError,
  RecordValidationError,
} from '@/lib/loads/record-guards';

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  store.sites.clear();
  store.sites.set('EUG', { jurisdiction: 'oregon' });
  store.sites.set('WDL', { jurisdiction: 'california' });
});

describe('createOrCount — OR-only jurisdiction gate', () => {
  it('creates a count for an Oregon site, anchoring billing_month to the first of the month', async () => {
    const row = await createOrCount({
      siteId: 'EUG',
      billingMonth: new Date('2026-06-15T00:00:00Z'),
      location: 'Springfield MRF',
      units: 120,
      actorUserId: 'U1',
    });
    expect(row.units).toBe(120);
    expect(row.billingMonth.toISOString().slice(0, 10)).toBe('2026-06-01');
  });

  it('REFUSES a California site with a typed jurisdiction error', async () => {
    await expect(
      createOrCount({
        siteId: 'WDL',
        billingMonth: new Date('2026-06-01T00:00:00Z'),
        location: 'x',
        units: 1,
        actorUserId: 'U1',
      }),
    ).rejects.toBeInstanceOf(JurisdictionNotAllowedError);
    expect(store.rows).toHaveLength(0);
  });

  it('refuses an unknown site', async () => {
    await expect(
      createOrCount({
        siteId: 'NOPE',
        billingMonth: new Date('2026-06-01T00:00:00Z'),
        location: 'x',
        units: 1,
        actorUserId: 'U1',
      }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('rejects negative or non-integer units', async () => {
    await expect(
      createOrCount({
        siteId: 'EUG',
        billingMonth: new Date('2026-06-01T00:00:00Z'),
        location: 'x',
        units: -1,
        actorUserId: 'U1',
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);
  });

  it('rejects a blank location', async () => {
    await expect(
      createOrCount({
        siteId: 'EUG',
        billingMonth: new Date('2026-06-01T00:00:00Z'),
        location: '  ',
        units: 1,
        actorUserId: 'U1',
      }),
    ).rejects.toBeInstanceOf(RecordValidationError);
  });
});

describe('updateOrCount — edit before lock', () => {
  it('updates an unlocked row', async () => {
    const row = await createOrCount({
      siteId: 'EUG',
      billingMonth: new Date('2026-06-01T00:00:00Z'),
      location: 'x',
      units: 1,
      actorUserId: 'U1',
    });
    const upd = await updateOrCount({ id: row.id, siteId: 'EUG', units: 5, actorUserId: 'U1' });
    expect(upd.units).toBe(5);
  });

  it('refuses to edit a locked row', async () => {
    const row = await createOrCount({
      siteId: 'EUG',
      billingMonth: new Date('2026-06-01T00:00:00Z'),
      location: 'x',
      units: 1,
      actorUserId: 'U1',
    });
    store.rows[0]!.locked_at = new Date();
    await expect(
      updateOrCount({ id: row.id, siteId: 'EUG', units: 5, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordLockedError);
  });
});
