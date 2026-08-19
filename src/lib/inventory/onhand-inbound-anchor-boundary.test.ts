// ADR-0059 D5 — the money-safe inbound backfill proof, as a unit test.
//
// `onHand` sums verified inbound with `arrived_at >= inboundSince`, where
// `inboundSince = pacificMidnightInstantOfDayISO(dayAfter(anchorPacificDay))`
// (anchorFlowBounds). So a bridged `mymrc_haul` inbound row whose `arrived_at` is
// Pacific-midnight of the anchor's OWN Pacific day is EXCLUDED (a physical count is that
// day's closing position — the day's inbound is already inside the count), while a row
// one Pacific day later is INCLUDED. This is exactly why backfilling all dated Delivered
// General history (every haul ≤ 2026-07-21 ≤ the 2026-07-22 anchor) changes the live
// floor by 0 — proven here with a WHERE-aware inbound aggregate. Mirror of the processed
// leg's onhand-anchor-boundary.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { pacificMidnightInstantOfDayISO } from '@/lib/time';

const D = (n: number | string) => new Prisma.Decimal(n);

// Woodland's real anchor: 2026-07-22 = 2,483 (measured, 1,597 / 886).
const ANCHOR_AT = new Date('2026-07-22T07:00:00Z'); // 00:00 PDT July 22

// Two bridged mymrc_haul inbound rows: arrived_at ON the anchor Pacific day, and the day
// AFTER — both at Pacific-midnight (the exact instant the bridge writes).
const INBOUND = [
  {
    arrived_at: pacificMidnightInstantOfDayISO('2026-07-22'),
    program_unit_count: 561,
    non_program_unit_count: 0,
  },
  {
    arrived_at: pacificMidnightInstantOfDayISO('2026-07-23'),
    program_unit_count: 527,
    non_program_unit_count: 0,
  },
];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    siteInventorySnapshot: {
      findFirst: async () => ({
        snapshot_at: ANCHOR_AT,
        units_indoor: 2483,
        units_total: null,
        units_in_processing: 0,
        program_units: D(1597),
        non_program_units: D(886),
        pool_attribution: 'measured',
      }),
    },
    // WHERE-aware: sum only inbound rows in the `{ gte, lte }` arrived_at window.
    inboundLoad: {
      aggregate: async ({ where }: { where: { arrived_at: { gte: Date; lte: Date } } }) => {
        const { gte, lte } = where.arrived_at;
        let p = 0;
        let np = 0;
        for (const r of INBOUND) {
          const t = r.arrived_at.getTime();
          if (t >= gte.getTime() && t <= lte.getTime()) {
            p += r.program_unit_count;
            np += r.non_program_unit_count;
          }
        }
        return { _sum: { program_unit_count: p, non_program_unit_count: np } };
      },
    },
    consumerDropoff: { groupBy: async () => [] },
    processedUnitsDaily: {
      aggregate: async () => ({ _sum: { stripped_program: 0, stripped_non_program: 0 } }),
    },
    outboundMaterial: {
      aggregate: async () => ({ _sum: { program_units: 0, non_program_units: 0 } }),
    },
    landfilledUnit: {
      aggregate: async () => ({ _sum: { program_units: 0, non_program_units: 0 } }),
    },
  },
}));

import { onHand } from './running-balance';

describe('onHand — bridged mymrc_haul inbound rows ≤ the anchor day are inert (ADR-0059 D5)', () => {
  it('as of end of the anchor day: the anchor-day inbound row does NOT add — floor == anchor (2,483)', async () => {
    const asOf = new Date('2026-07-22T23:59:59.999Z');
    const b = await onHand('woodland', asOf);
    // The 561-unit row arrived_at 2026-07-22 00:00 PT (the anchor Pacific day) is EXCLUDED
    // by `{ gte: dayAfter }` — the anchor already reflects that day's inbound.
    expect(b.program.toString()).toBe('1597');
    expect(b.nonProgram.toString()).toBe('886');
    expect(b.total.toString()).toBe('2483');
  });

  it('as of the next day: only the day-AFTER inbound row adds (anchor-day row still inert)', async () => {
    const asOf = new Date('2026-07-23T23:59:59.999Z');
    const b = await onHand('woodland', asOf);
    // Only the 527-unit row arrived_at 2026-07-23 adds; the 561-unit anchor-day row stays out.
    expect(b.program.toString()).toBe('2124'); // 1597 + 527
    expect(b.nonProgram.toString()).toBe('886');
    expect(b.total.toString()).toBe('3010');
  });
});
