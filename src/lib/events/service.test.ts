// ADR-0041 D3 — collection_events service. Proves the wage-default contract
// (blank wages default from the resolved B5 rate; typed wages stored as entered;
// a missing rule leaves the wage null rather than blocking capture), the
// edit-before-lock guard, and the EventCostRow projection.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface EventRow {
  id: string;
  site_id: string;
  event_date: Date;
  customer: string;
  county: string | null;
  slip_number: string | null;
  units: number | null;
  freight_cents: number | null;
  driver_hours: unknown;
  driver_wages_cents: number | null;
  labor_hours: unknown;
  labor_wages_cents: number | null;
  mileage: number | null;
  mileage_cents: number | null;
  per_diem_cents: number | null;
  misc_cents: number | null;
  retrac_id: string | null;
  notes: string | null;
  source: string;
  locked_at: Date | null;
}
const store = { rows: [] as EventRow[], audits: [] as unknown[] };

vi.mock('@/lib/prisma', () => {
  const model = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      store.rows.find((r) => r.id === where.id) ?? null,
    findMany: async () => store.rows,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `e${store.rows.length + 1}`,
        locked_at: null,
        ...data,
      } as unknown as EventRow;
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
      collectionEvent: model,
      auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          collectionEvent: model,
          auditLog: { create: async ({ data }: { data: unknown }) => store.audits.push(data) },
        }),
    },
  };
});

vi.mock('@/lib/program-rules/resolver', async (orig) => {
  const actual = await orig<typeof import('@/lib/program-rules/resolver')>();
  return { ...actual, resolveRateCents: vi.fn() };
});

import { resolveRateCents, NoActiveProgramRuleError } from '@/lib/program-rules/resolver';
import { createEvent, updateEvent, computeWageDefaultCents, toEventCostRow } from './service';
import { RecordLockedError } from '@/lib/loads/record-guards';

const rateMock = resolveRateCents as unknown as ReturnType<typeof vi.fn>;

/** Route each B5 rate kind to a fixed cents value; NoActiveProgramRuleError otherwise. */
function seedRates(
  rates: Partial<Record<'driver_hourly' | 'general_labor_hourly' | 'per_diem_nightly', number>>,
) {
  rateMock.mockImplementation(async (_siteId: string, kind: string) => {
    const v = (rates as Record<string, number | undefined>)[kind];
    if (v == null) throw new NoActiveProgramRuleError('S1', kind as never, new Date());
    return v;
  });
}

beforeEach(() => {
  store.rows.length = 0;
  store.audits.length = 0;
  rateMock.mockReset();
});

describe('computeWageDefaultCents — pure hours × rate', () => {
  it('multiplies hours by the hourly cents rate, rounding to the nearest cent', () => {
    expect(computeWageDefaultCents(2.5, 12500)).toBe(31250); // 2.5h × $125 = $312.50
    expect(computeWageDefaultCents(1, 9000)).toBe(9000);
    expect(computeWageDefaultCents(0.3333, 9000)).toBe(3000); // rounds 2999.7 → 3000
  });
});

describe('createEvent — wage defaults', () => {
  it('defaults blank wages from the resolved B5 rates (driver + labor)', async () => {
    seedRates({ driver_hourly: 12500, general_labor_hourly: 9000 });
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      driverHours: 2,
      laborHours: 3,
      actorUserId: 'U1',
    });
    expect(ev.driverWagesCents).toBe(25000); // 2 × $125
    expect(ev.laborWagesCents).toBe(27000); // 3 × $90
  });

  it('stores a TYPED wage as entered — the default never overwrites it', async () => {
    seedRates({ driver_hourly: 12500 });
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      driverHours: 2,
      driverWagesCents: 30000, // operator override (would-be default is 25000)
      actorUserId: 'U1',
    });
    expect(ev.driverWagesCents).toBe(30000);
  });

  it('leaves the wage null (does NOT throw) when no wage rule is in force', async () => {
    seedRates({}); // every rate kind → NoActiveProgramRuleError (e.g. an OR site)
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'Eugene run',
      driverHours: 4,
      actorUserId: 'U1',
    });
    expect(ev.driverWagesCents).toBeNull();
  });

  it('does not default a wage when hours are absent', async () => {
    seedRates({ driver_hourly: 12500 });
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      actorUserId: 'U1',
    });
    expect(ev.driverWagesCents).toBeNull();
  });
});

describe('updateEvent — edit before lock', () => {
  it('updates an unlocked row and audits before/after', async () => {
    seedRates({});
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      actorUserId: 'U1',
    });
    const upd = await updateEvent({ id: ev.id, siteId: 'S1', miscCents: 500, actorUserId: 'U1' });
    expect(upd.miscCents).toBe(500);
    expect(store.audits.length).toBe(2); // insert + update
  });

  it('refuses to edit a locked row', async () => {
    seedRates({});
    const ev = await createEvent({
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      actorUserId: 'U1',
    });
    store.rows[0]!.locked_at = new Date();
    await expect(
      updateEvent({ id: ev.id, siteId: 'S1', miscCents: 500, actorUserId: 'U1' }),
    ).rejects.toBeInstanceOf(RecordLockedError);
  });
});

describe('toEventCostRow — sibling B8 projection', () => {
  it('projects exactly the money terms + event_date + site_id', () => {
    const projected = toEventCostRow({
      id: 'e1',
      site_id: 'S1',
      event_date: new Date('2026-06-15T00:00:00Z'),
      customer: 'GVCC',
      county: null,
      slip_number: null,
      units: 10,
      freight_cents: 92500,
      driver_hours: null,
      driver_wages_cents: 25000,
      labor_hours: null,
      labor_wages_cents: 27000,
      mileage: 67,
      mileage_cents: 5000,
      per_diem_cents: 27500,
      misc_cents: 250,
      retrac_id: null,
      notes: null,
      source: 'manual',
      locked_at: null,
    });
    expect(projected).toEqual({
      id: 'e1',
      siteId: 'S1',
      eventDate: new Date('2026-06-15T00:00:00Z'),
      freightCents: 92500,
      driverWagesCents: 25000,
      laborWagesCents: 27000,
      mileageCents: 5000,
      perDiemCents: 27500,
      miscCents: 250,
    });
  });
});
