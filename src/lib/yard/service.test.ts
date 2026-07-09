// handoff §1.8 — yard service tests. Proves create/edit of a trailer, the label
// validation guard, the not-found / cross-site guard, and that an append-only audit
// row is written inside the mutation transaction (hard rule #6). Mocked prisma in
// the dropoffs-service style (no real DB).

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface TrailerRow {
  id: string;
  site_id: string;
  label: string;
  location_note: string | null;
  status: string;
  created_by: string | null;
  updated_by: string | null;
}
const store = { rows: [] as TrailerRow[], audits: [] as Record<string, unknown>[] };

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: { where?: { site_id?: string } }) =>
      store.rows.filter((r) => where?.site_id === undefined || r.site_id === where.site_id),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `t${store.rows.length + 1}`, ...data } as TrailerRow;
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = store.rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return r;
    },
  };
  const auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => void store.audits.push(data),
  };
  return {
    prisma: {
      yardTrailer: model,
      containerRentalSite: { findMany: async () => [] },
      auditLog,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ yardTrailer: model, auditLog }),
    },
  };
});

import { createTrailer, updateTrailer, listTrailers } from './service';
import { RecordNotFoundError, RecordValidationError } from '@/lib/loads/record-guards';

const SITE = 'S1';

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
});

describe('createTrailer', () => {
  it('creates a trailer, defaults status to on_yard, and writes one audit row', async () => {
    const v = await createTrailer({ siteId: SITE, label: '  T-14  ', actorUserId: 'U1' });
    expect(v.label).toBe('T-14'); // trimmed
    expect(v.status).toBe('on_yard');
    expect(v.siteId).toBe(SITE);
    expect(v.locationNote).toBeNull();
    expect(store.rows).toHaveLength(1);
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0]?.['action']).toBe('insert');
    expect(store.audits[0]?.['table_name']).toBe('yard_trailers');
  });

  it('honors an explicit status and location note', async () => {
    const v = await createTrailer({
      siteId: SITE,
      label: 'T-2',
      locationNote: 'north fence',
      status: 'at_account',
      actorUserId: 'U1',
    });
    expect(v.status).toBe('at_account');
    expect(v.locationNote).toBe('north fence');
  });

  it('rejects a blank label and writes nothing', async () => {
    await expect(
      createTrailer({ siteId: SITE, label: '   ', actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordValidationError);
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });
});

describe('updateTrailer', () => {
  it('updates fields and writes an update audit row with before/after', async () => {
    const v = await createTrailer({ siteId: SITE, label: 'T-9', actorUserId: 'U1' });
    const upd = await updateTrailer({
      id: v.id,
      siteId: SITE,
      label: 'T-9b',
      status: 'in_service',
      actorUserId: 'U2',
    });
    expect(upd.label).toBe('T-9b');
    expect(upd.status).toBe('in_service');
    expect(store.audits).toHaveLength(2);
    const audit = store.audits[1]!;
    expect(audit['action']).toBe('update');
    expect(audit['before']).toMatchObject({ label: 'T-9', status: 'on_yard' });
    expect(audit['after']).toMatchObject({ label: 'T-9b', status: 'in_service' });
    expect(store.rows[0]?.updated_by).toBe('U2');
  });

  it('rejects a blank label on edit', async () => {
    const v = await createTrailer({ siteId: SITE, label: 'T-1', actorUserId: 'U1' });
    await expect(
      updateTrailer({ id: v.id, siteId: SITE, label: '  ', actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordValidationError);
  });

  it('throws RecordNotFoundError for an unknown id', async () => {
    await expect(
      updateTrailer({ id: 'nope', siteId: SITE, label: 'x', actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it('throws RecordNotFoundError for a cross-site id (hard rule #2)', async () => {
    const v = await createTrailer({ siteId: SITE, label: 'T-7', actorUserId: 'U1' });
    await expect(
      updateTrailer({ id: v.id, siteId: 'OTHER', label: 'T-7b', actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });
});

describe('listTrailers', () => {
  it('returns the site trailers as flattened views', async () => {
    await createTrailer({ siteId: SITE, label: 'A', actorUserId: 'U1' });
    await createTrailer({ siteId: SITE, label: 'B', actorUserId: 'U1' });
    const rows = await listTrailers(SITE);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label)).toEqual(['A', 'B']);
  });
});
