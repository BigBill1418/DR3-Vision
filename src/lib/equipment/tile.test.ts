// ADR-0044 D3 — equipment tile provider. Two numbers: last (non-voided) event +
// 7-day units/day mean, site-scoped.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const store = {
  lastEvent: null as
    | null
    | { event_date: Date; kind: string; hours_down: Prisma.Decimal | null; cost_cents: number | null; notes: string | null },
  closes: [] as { stripped_program: Prisma.Decimal; stripped_non_program: Prisma.Decimal }[],
};

vi.mock('@/lib/prisma', () => ({
  prisma: {
    equipmentEvent: {
      findFirst: async ({ where }: { where: { voided_at: null } }) => {
        expect(where.voided_at).toBeNull(); // never surfaces a voided event
        return store.lastEvent;
      },
    },
    processedUnitsDaily: { findMany: async () => store.closes },
  },
}));

import { computeEquipmentTile } from './tile';

function dec(n: number): Prisma.Decimal {
  return new Prisma.Decimal(n);
}

beforeEach(() => {
  store.lastEvent = null;
  store.closes.length = 0;
});

describe('computeEquipmentTile', () => {
  it('returns the last event + the 7-day units/day mean', async () => {
    store.lastEvent = {
      event_date: new Date('2026-07-05T00:00:00Z'),
      kind: 'downtime',
      hours_down: dec(3.5),
      cost_cents: null,
      notes: 'hydraulic line',
    };
    store.closes.push(
      { stripped_program: dec(150), stripped_non_program: dec(10) },
      { stripped_program: dec(120), stripped_non_program: dec(0) },
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
  });

  it('is null-safe with no events and no closes', async () => {
    const tile = await computeEquipmentTile('S1', { nowISO: '2026-07-05' });
    expect(tile.lastEvent).toBeNull();
    expect(tile.last7UnitsPerDay).toBeNull();
  });
});
