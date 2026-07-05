// ADR-0044 D1 — equipment_events service tests. The load-bearing behaviors: the
// hours_down/kind + cost_cents validation shape, the audit row on every write,
// site scoping, freely-editable updates, and the soft-void (no hard delete).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

interface Row {
  id: string;
  site_id: string;
  equipment_code: string;
  event_date: Date;
  kind: string;
  hours_down: Prisma.Decimal | null;
  cost_cents: number | null;
  vendor: string | null;
  notes: string | null;
  source: string;
  created_by: string | null;
  voided_at: Date | null;
  voided_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const store = { rows: [] as Row[], audits: [] as { action: string; table_name: string; row_id: string }[] };

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.rows.find((r) => r.id === where.id) ?? null,
    findMany: async ({
      where,
      take,
    }: {
      where: { site_id: string; voided_at?: null; equipment_code?: string };
      orderBy?: unknown;
      take?: number;
    }) => {
      let rows = store.rows.filter((r) => r.site_id === where.site_id);
      if (where.voided_at === null) rows = rows.filter((r) => r.voided_at === null);
      if (where.equipment_code) rows = rows.filter((r) => r.equipment_code === where.equipment_code);
      rows = [...rows].sort((a, b) => b.event_date.getTime() - a.event_date.getTime());
      return take ? rows.slice(0, take) : rows;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: Row = {
        id: `e${store.rows.length + 1}`,
        vendor: null,
        notes: null,
        cost_cents: null,
        hours_down: null,
        voided_at: null,
        voided_by: null,
        created_at: now,
        updated_at: now,
        ...(data as Partial<Row>),
      } as Row;
      if (typeof (data as { hours_down?: unknown }).hours_down === 'number') {
        row.hours_down = new Prisma.Decimal((data as { hours_down: number }).hours_down);
      }
      store.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const r = store.rows.find((x) => x.id === where.id)!;
      const d: Record<string, unknown> = { ...data };
      const hd = d['hours_down'];
      if (typeof hd === 'number') d['hours_down'] = new Prisma.Decimal(hd);
      Object.assign(r, d);
      return r;
    },
  };
  const auditLog = {
    create: async ({ data }: { data: { action: string; table_name: string; row_id: string } }) => {
      store.audits.push({ action: data.action, table_name: data.table_name, row_id: data.row_id });
    },
  };
  return {
    prisma: {
      equipmentEvent: model,
      auditLog,
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ equipmentEvent: model, auditLog }),
    },
  };
});

import {
  assertEquipmentShape,
  createEquipmentEvent,
  updateEquipmentEvent,
  voidEquipmentEvent,
  listEquipmentEvents,
} from './service';
import { RecordValidationError, RecordNotFoundError } from '@/lib/loads/record-guards';

const SITE = 'S1';
const OTHER = 'S2';
const DAY = new Date('2026-07-05T00:00:00Z');

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
});

describe('assertEquipmentShape', () => {
  it('accepts hours_down on downtime/maintenance/repair', () => {
    expect(assertEquipmentShape('downtime', 4.5, null)).toEqual({ hoursDown: 4.5, costCents: null });
    expect(assertEquipmentShape('maintenance', 2, null)).toEqual({ hoursDown: 2, costCents: null });
    expect(assertEquipmentShape('repair', 8, 12000)).toEqual({ hoursDown: 8, costCents: 12000 });
  });

  it('rejects hours_down on a cost or note kind', () => {
    expect(() => assertEquipmentShape('cost', 3, 5000)).toThrow(RecordValidationError);
    expect(() => assertEquipmentShape('note', 1, null)).toThrow(RecordValidationError);
  });

  it('allows cost / note with no hours_down', () => {
    expect(assertEquipmentShape('cost', null, 5000)).toEqual({ hoursDown: null, costCents: 5000 });
    expect(assertEquipmentShape('note', null, null)).toEqual({ hoursDown: null, costCents: null });
  });

  it('rejects negative or over-range hours_down', () => {
    expect(() => assertEquipmentShape('downtime', -1, null)).toThrow(RecordValidationError);
    expect(() => assertEquipmentShape('downtime', 1000, null)).toThrow(RecordValidationError);
  });

  it('rejects a negative or non-integer cost_cents', () => {
    expect(() => assertEquipmentShape('cost', null, -1)).toThrow(RecordValidationError);
    expect(() => assertEquipmentShape('cost', null, 10.5)).toThrow(RecordValidationError);
  });

  it('accepts a zero-cost cost row', () => {
    expect(assertEquipmentShape('cost', null, 0)).toEqual({ hoursDown: null, costCents: 0 });
  });
});

describe('createEquipmentEvent', () => {
  it('creates a downtime row, defaults equipment_code=terex, writes one audit row', async () => {
    const v = await createEquipmentEvent({
      siteId: SITE,
      eventDate: DAY,
      kind: 'downtime',
      hoursDown: 3.5,
      notes: 'belt snapped',
      actorUserId: 'U1',
    });
    expect(v.equipmentCode).toBe('terex');
    expect(v.hoursDown).toBe('3.5');
    expect(v.notes).toBe('belt snapped');
    expect(v.voidedAt).toBeNull();
    expect(store.audits).toEqual([{ action: 'insert', table_name: 'equipment_events', row_id: v.id }]);
  });

  it('records a cost event with a vendor and no hours_down', async () => {
    const v = await createEquipmentEvent({
      siteId: SITE,
      eventDate: DAY,
      kind: 'cost',
      costCents: 45000,
      vendor: 'Acme Hydraulics',
      actorUserId: 'U1',
    });
    expect(v.costCents).toBe(45000);
    expect(v.hoursDown).toBeNull();
    expect(v.vendor).toBe('Acme Hydraulics');
  });

  it('rejects hours_down on a cost kind before touching the store', async () => {
    await expect(
      createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'cost', hoursDown: 2, actorUserId: 'U1' }),
    ).rejects.toThrow(RecordValidationError);
    expect(store.rows).toHaveLength(0);
    expect(store.audits).toHaveLength(0);
  });

  it('honors an explicit equipment_code for a second machine', async () => {
    const v = await createEquipmentEvent({
      siteId: SITE,
      eventDate: DAY,
      kind: 'note',
      equipmentCode: 'baler',
      notes: 'jam cleared',
      actorUserId: 'U1',
    });
    expect(v.equipmentCode).toBe('baler');
  });
});

describe('updateEquipmentEvent', () => {
  it('edits freely (no lock) and writes an update audit row', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'downtime', hoursDown: 2, actorUserId: 'U1' });
    store.audits.length = 0;
    const v = await updateEquipmentEvent({ id: c.id, siteId: SITE, hoursDown: 5, actorUserId: 'U2' });
    expect(v.hoursDown).toBe('5');
    expect(store.audits).toEqual([{ action: 'update', table_name: 'equipment_events', row_id: c.id }]);
  });

  it('re-validates the shape against the resolved kind (cost + leftover hours_down rejected)', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'downtime', hoursDown: 2, actorUserId: 'U1' });
    await expect(updateEquipmentEvent({ id: c.id, siteId: SITE, kind: 'cost', actorUserId: 'U2' })).rejects.toThrow(
      RecordValidationError,
    );
  });

  it('clears hours_down when kind changes to cost and hours_down is explicitly nulled', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'downtime', hoursDown: 2, actorUserId: 'U1' });
    const v = await updateEquipmentEvent({ id: c.id, siteId: SITE, kind: 'cost', hoursDown: null, costCents: 900, actorUserId: 'U2' });
    expect(v.kind).toBe('cost');
    expect(v.hoursDown).toBeNull();
    expect(v.costCents).toBe(900);
  });

  it('refuses a cross-site edit (site scoping)', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'note', notes: 'x', actorUserId: 'U1' });
    await expect(updateEquipmentEvent({ id: c.id, siteId: OTHER, actorUserId: 'U2' })).rejects.toThrow(RecordNotFoundError);
  });

  it('refuses to edit a voided row', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'note', notes: 'x', actorUserId: 'U1' });
    await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    await expect(updateEquipmentEvent({ id: c.id, siteId: SITE, notes: 'y', actorUserId: 'U1' })).rejects.toThrow(
      RecordValidationError,
    );
  });
});

describe('voidEquipmentEvent (soft-void, no hard delete)', () => {
  it('sets voided_at and writes a soft_delete audit row', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'downtime', hoursDown: 1, actorUserId: 'U1' });
    store.audits.length = 0;
    const v = await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    expect(v.voidedAt).toBeInstanceOf(Date);
    expect(store.audits).toEqual([{ action: 'soft_delete', table_name: 'equipment_events', row_id: c.id }]);
    // The row is retained (never deleted).
    expect(store.rows).toHaveLength(1);
  });

  it('is idempotent — re-voiding writes no second audit row', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'note', notes: 'x', actorUserId: 'U1' });
    await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    store.audits.length = 0;
    await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    expect(store.audits).toHaveLength(0);
  });
});

describe('listEquipmentEvents', () => {
  beforeEach(async () => {
    await createEquipmentEvent({ siteId: SITE, eventDate: new Date('2026-07-01T00:00:00Z'), kind: 'downtime', hoursDown: 2, actorUserId: 'U1' });
    await createEquipmentEvent({ siteId: SITE, eventDate: new Date('2026-07-03T00:00:00Z'), kind: 'cost', costCents: 100, actorUserId: 'U1' });
    await createEquipmentEvent({ siteId: OTHER, eventDate: new Date('2026-07-02T00:00:00Z'), kind: 'note', notes: 'other site', actorUserId: 'U1' });
  });

  it('returns only the requested site, newest-first, excluding voided by default', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: new Date('2026-07-04T00:00:00Z'), kind: 'note', notes: 'gone', actorUserId: 'U1' });
    await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    const rows = await listEquipmentEvents(SITE);
    expect(rows.map((r) => r.siteId)).toEqual([SITE, SITE]);
    expect(rows[0]!.eventDate.getTime()).toBeGreaterThan(rows[1]!.eventDate.getTime());
    expect(rows.some((r) => r.voidedAt !== null)).toBe(false);
  });

  it('surfaces voided rows when includeVoided is set', async () => {
    const c = await createEquipmentEvent({ siteId: SITE, eventDate: DAY, kind: 'note', notes: 'gone', actorUserId: 'U1' });
    await voidEquipmentEvent({ id: c.id, siteId: SITE, actorUserId: 'U1' });
    const rows = await listEquipmentEvents(SITE, { includeVoided: true });
    expect(rows.some((r) => r.voidedAt !== null)).toBe(true);
  });
});
