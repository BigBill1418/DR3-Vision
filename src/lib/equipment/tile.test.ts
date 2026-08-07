// ADR-0044 D3 / ADR-0079 D3 — equipment tile provider. Two numbers: last
// (non-voided) event + the 7-day ENTERED units/day mean, site-scoped.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const MACHINE = { id: 'eq-terex-1', display_name: 'Terex' };

/** The ADR-0077 identity-rule where-clause the resolver must issue. */
interface EquipmentWhere {
  site_id: string;
  category: string;
  is_active: boolean;
  merged_into_id: null;
  links: { some: Record<string, never> };
}

const store = {
  lastEvent: null as null | {
    event_date: Date;
    kind: string;
    hours_down: Prisma.Decimal | null;
    cost_cents: number | null;
    notes: string | null;
  },
  /** ADR-0079 — the manager's entered days. Real `Prisma.Decimal` run hours. */
  entered: [] as { throughput_date: Date; units_processed: number; run_hours: Prisma.Decimal }[],
  machine: MACHINE as { id: string; display_name: string } | null,
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    equipmentEvent: {
      findFirst: async ({ where }: { where: { voided_at: null } }) => {
        expect(where.voided_at).toBeNull(); // never surfaces a voided event
        return store.lastEvent;
      },
    },
    equipment: {
      findFirst: async ({ where }: { where: EquipmentWhere }) => {
        // The ADR-0077 identity rule, not a hardcoded id.
        expect(where.category).toBe('terex');
        expect(where.links).toEqual({ some: {} });
        return store.machine;
      },
    },
    equipmentDailyThroughput: {
      findMany: async ({ where }: { where: { voided_at: null } }) => {
        expect(where.voided_at).toBeNull(); // a voided entry is not throughput
        return store.entered;
      },
    },
    // Deliberately ABSENT: `processedUnitsDaily`. The tile used to average
    // `stripped_program + stripped_non_program` here and call it the machine's.
    // Leaving the model off the mock means any regression back to the floor-wide
    // source fails loudly ("cannot read properties of undefined") instead of
    // quietly producing a plausible-looking number again.
  },
}));

import { computeEquipmentTile } from './tile';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

beforeEach(() => {
  store.lastEvent = null;
  store.entered.length = 0;
  store.machine = MACHINE;
});

describe('computeEquipmentTile', () => {
  it('returns the last event + the 7-day ENTERED units/day mean', async () => {
    store.lastEvent = {
      event_date: new Date('2026-07-05T00:00:00Z'),
      kind: 'downtime',
      hours_down: dec(3.5),
      cost_cents: null,
      notes: 'hydraulic line',
    };
    store.entered.push(
      {
        throughput_date: new Date('2026-07-04T00:00:00Z'),
        units_processed: 160,
        run_hours: dec(8),
      },
      {
        throughput_date: new Date('2026-07-05T00:00:00Z'),
        units_processed: 120,
        run_hours: dec(6),
      },
    );
    const tile = await computeEquipmentTile('S1', { nowISO: '2026-07-05' });
    expect(tile.lastEvent).toEqual({
      dateISO: '2026-07-05',
      kind: 'downtime',
      hoursDown: '3.5',
      costCents: null,
      notes: 'hydraulic line',
    });
    expect(tile.last7UnitsPerDay).toBe(140); // (160 + 120) / 2
    expect(tile.recordedDays).toBe(2);
  });

  // ADR-0079 D3 — the tile is where Bill actually SEES this number, so the
  // "not recorded ≠ zero" rule has to hold here, not just in the series.
  it('is null — NOT 0 — when the manager has entered nothing', async () => {
    store.lastEvent = {
      event_date: new Date('2026-07-05T00:00:00Z'),
      kind: 'repair',
      hours_down: null,
      cost_cents: 45_000,
      notes: null,
    };
    const tile = await computeEquipmentTile('S1', { nowISO: '2026-07-05' });
    // There ARE events — so this is not "nothing happened", it is "nobody
    // recorded what the machine processed".
    expect(tile.lastEvent).not.toBeNull();
    expect(tile.last7UnitsPerDay).toBeNull();
    expect(tile.last7UnitsPerDay).not.toBe(0);
    expect(tile.recordedDays).toBe(0);
  });

  it('keeps a recorded zero as 0', async () => {
    store.entered.push({
      throughput_date: new Date('2026-07-05T00:00:00Z'),
      units_processed: 0,
      run_hours: dec(2),
    });
    const tile = await computeEquipmentTile('S1', { nowISO: '2026-07-05' });
    expect(tile.last7UnitsPerDay).toBe(0);
    expect(tile.last7UnitsPerDay).not.toBeNull();
    expect(tile.recordedDays).toBe(1);
  });

  it('is null-safe with no events and no entries', async () => {
    const tile = await computeEquipmentTile('S1', { nowISO: '2026-07-05' });
    expect(tile.lastEvent).toBeNull();
    expect(tile.last7UnitsPerDay).toBeNull();
    expect(tile.recordedDays).toBe(0);
  });

  it('reports not-recorded at a site with no registered machine', async () => {
    store.machine = null;
    const tile = await computeEquipmentTile('S2', { nowISO: '2026-07-05' });
    expect(tile.last7UnitsPerDay).toBeNull();
    expect(tile.recordedDays).toBe(0);
  });
});
