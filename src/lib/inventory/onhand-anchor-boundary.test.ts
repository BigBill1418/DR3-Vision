// ADR-0058 D4 — the money-safe backfill proof, as a unit test.
//
// `onHand` sums processed rows with `production_date > anchorDayKey` (`{ gt }`,
// anchorFlowBounds). So a bridged `processed_units_daily` row dated ON the anchor's
// Pacific day is EXCLUDED, while a row one Pacific day later is INCLUDED. This is
// exactly why backfilling all history (every row ≤ the latest anchor) changes the
// live floor by 0 — proven here with a WHERE-aware processed aggregate (the shared
// running-balance.test mock ignores the window; this one honors it).

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const D = (n: number | string) => new Prisma.Decimal(n);

// Woodland's real anchor: 2026-07-22 = 2,483 (measured, 1,597 / 886).
const ANCHOR_AT = new Date('2026-07-22T07:00:00Z'); // 00:00 PDT July 22

// Two bridged processed rows: one ON the anchor Pacific day, one the day AFTER.
const PROCESSED = [
  { production_date: new Date('2026-07-22T00:00:00.000Z'), stripped_program: D(800), stripped_non_program: D(0) },
  { production_date: new Date('2026-07-23T00:00:00.000Z'), stripped_program: D(750), stripped_non_program: D(0) },
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
    inboundLoad: { aggregate: async () => ({ _sum: { program_unit_count: 0, non_program_unit_count: 0 } }) },
    consumerDropoff: { aggregate: async () => ({ _sum: { units: 0 } }) },
    processedUnitsDaily: {
      // WHERE-aware: sum only rows in the `{ gt, lte }` production_date window.
      aggregate: async ({ where }: { where: { production_date: { gt: Date; lte: Date } } }) => {
        const { gt, lte } = where.production_date;
        let p = D(0);
        let np = D(0);
        for (const r of PROCESSED) {
          const t = r.production_date.getTime();
          if (t > gt.getTime() && t <= lte.getTime()) {
            p = p.plus(r.stripped_program);
            np = np.plus(r.stripped_non_program);
          }
        }
        return { _sum: { stripped_program: p, stripped_non_program: np } };
      },
    },
    outboundMaterial: { aggregate: async () => ({ _sum: { program_units: 0, non_program_units: 0 } }) },
    landfilledUnit: { aggregate: async () => ({ _sum: { program_units: 0, non_program_units: 0 } }) },
  },
}));

import { onHand } from './running-balance';

describe('onHand — bridged processed rows ≤ the anchor day are inert (ADR-0058 D4)', () => {
  it('as of end of the anchor day: the anchor-day processed row does NOT subtract — floor == anchor (2,483)', async () => {
    const asOf = new Date('2026-07-22T23:59:59.999Z');
    const b = await onHand('woodland', asOf);
    // The 800-unit row dated 2026-07-22 (the anchor Pacific day) is EXCLUDED by `{ gt }`.
    expect(b.program.toString()).toBe('1597');
    expect(b.nonProgram.toString()).toBe('886');
    expect(b.total.toString()).toBe('2483');
  });

  it('as of the next day: only the day-AFTER row subtracts (anchor-day row still inert)', async () => {
    const asOf = new Date('2026-07-23T23:59:59.999Z');
    const b = await onHand('woodland', asOf);
    // Only the 750-unit row dated 2026-07-23 subtracts; the 800-unit anchor-day row stays out.
    expect(b.program.toString()).toBe('847'); // 1597 − 750
    expect(b.nonProgram.toString()).toBe('886');
    expect(b.total.toString()).toBe('1733');
  });
});
