// ADR-0037 D5 (Addendum B4) — processed_units_daily service tests. The post-close
// edit BLOCK, the close-writes-audit path, and the derived close-confirmation
// (whole-units-sold + landfilled) are the load-bearing behaviors.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

interface Row {
  id: string;
  site_id: string;
  production_date: Date;
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
  saved_units: Prisma.Decimal | null;
  material_ticket_number: string | null;
  employees_count: number | null;
  processors_count: number | null;
  pocketcoil_estimate: number | null;
  source: string;
  entered_by: string | null;
  closed_at: Date | null;
  notes: string | null;
}
const store = {
  rows: [] as Row[],
  audits: [] as unknown[],
  // Derived-outflow aggregates (renovation outbound + landfilled).
  reno: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
  land: { program_units: 0, non_program_units: 0 } as Record<string, number | null>,
};

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id?: string; site_id_production_date?: { site_id: string; production_date: Date } } }) => {
      if (where.id) return store.rows.find((r) => r.id === where.id) ?? null;
      const k = where.site_id_production_date!;
      return (
        store.rows.find(
          (r) => r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
        ) ?? null
      );
    },
    findMany: async () => store.rows,
    upsert: async ({ where, create, update }: { where: { site_id_production_date: { site_id: string; production_date: Date } }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const k = where.site_id_production_date;
      const found = store.rows.find(
        (r) => r.site_id === k.site_id && r.production_date.getTime() === k.production_date.getTime(),
      );
      if (found) {
        Object.assign(found, update);
        return found;
      }
      const row = { id: `p${store.rows.length + 1}`, closed_at: null, notes: null, ...create } as Row;
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
      processedUnitsDaily: model,
      outboundMaterial: { aggregate: async () => ({ _sum: store.reno }) },
      landfilledUnit: { aggregate: async () => ({ _sum: store.land }) },
      auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ processedUnitsDaily: model, auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) } }),
    },
  };
});

import {
  upsertProcessedUnits,
  closeProcessedUnitsDay,
  listProcessedUnits,
  ProcessedUnitsError,
} from './processed-units';

const SITE = 'S1';
const DAY = new Date('2026-07-03T00:00:00Z');

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  store.reno = { program_units: 0, non_program_units: 0 };
  store.land = { program_units: 0, non_program_units: 0 };
});

describe('upsertProcessedUnits', () => {
  it('creates a row with stripped split + derived total, writes an audit', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 150,
      strippedNonProgram: 25,
      actorUserId: 'U1',
    });
    expect(v.strippedProgram).toBe('150');
    expect(v.strippedNonProgram).toBe('25');
    expect(v.totalStripped).toBe('175');
    expect(store.audits).toHaveLength(1);
  });

  it('persists the daily-close metadata + saved units (saved excluded from math)', async () => {
    const v = await upsertProcessedUnits({
      siteId: SITE,
      productionDate: DAY,
      strippedProgram: 100,
      strippedNonProgram: 0,
      savedUnits: 12.5,
      materialTicketNumber: 'M-004562',
      employeesCount: 6,
      processorsCount: 4,
      pocketcoilEstimate: 30,
      actorUserId: 'U1',
    });
    expect(v.savedUnits).toBe('12.5');
    expect(v.materialTicketNumber).toBe('M-004562');
    expect(v.employeesCount).toBe(6);
    expect(v.processorsCount).toBe(4);
    expect(v.pocketcoilEstimate).toBe(30);
  });

  it('surfaces the DERIVED whole-units-sold + landfilled for the day (never entered)', async () => {
    store.reno = { program_units: 8, non_program_units: 2 };
    store.land = { program_units: 3, non_program_units: 0 };
    const v = await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 100, strippedNonProgram: 0, actorUserId: 'U1' });
    expect(v.derived.wholeUnitsSold.total).toBe(10);
    expect(v.derived.landfilled.total).toBe(3);
  });

  it('updates the same day in place before close', async () => {
    await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 150, strippedNonProgram: 25, actorUserId: 'U1' });
    const v = await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 160, strippedNonProgram: 15, actorUserId: 'U1' });
    expect(v.strippedProgram).toBe('160');
    expect(store.rows).toHaveLength(1);
  });

  it('BLOCKS an edit after the day is closed (directs to amendment path)', async () => {
    const v = await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 150, strippedNonProgram: 25, actorUserId: 'U1' });
    await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
    try {
      await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 999, strippedNonProgram: 0, actorUserId: 'U1' });
      expect.unreachable('should have blocked');
    } catch (e) {
      expect(e).toBeInstanceOf(ProcessedUnitsError);
      expect((e as ProcessedUnitsError).reason).toBe('closed');
      expect((e as ProcessedUnitsError).status).toBe(409);
    }
  });

  it('rejects invalid quantities', async () => {
    await expect(
      upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: -1, strippedNonProgram: 0, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(ProcessedUnitsError);
  });
});

describe('closeProcessedUnitsDay', () => {
  it('stamps closed_at + writes an audit row, then refuses a second close', async () => {
    const v = await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 150, strippedNonProgram: 25, actorUserId: 'U1' });
    const closed = await closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' });
    expect(closed.closedAt).not.toBeNull();
    expect(store.audits.length).toBeGreaterThanOrEqual(2);
    await expect(closeProcessedUnitsDay({ id: v.id, siteId: SITE, actorUserId: 'U1' })).rejects.toBeInstanceOf(
      ProcessedUnitsError,
    );
  });

  it('404s a row at another site', async () => {
    const v = await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 1, strippedNonProgram: 0, actorUserId: 'U1' });
    await expect(closeProcessedUnitsDay({ id: v.id, siteId: 'OTHER', actorUserId: 'U1' })).rejects.toBeInstanceOf(
      ProcessedUnitsError,
    );
  });
});

describe('listProcessedUnits', () => {
  it('returns rows for the site', async () => {
    await upsertProcessedUnits({ siteId: SITE, productionDate: DAY, strippedProgram: 150, strippedNonProgram: 25, actorUserId: 'U1' });
    const rows = await listProcessedUnits(SITE);
    expect(rows).toHaveLength(1);
  });
});
