// ADR-0041 amendment (rollup §11) — commodity breakdown model (pure).

import { describe, expect, it } from 'vitest';
import {
  buildCommodityBreakdown,
  BLOCK_TAXONOMY,
  type CommodityBreakdownInput,
} from './breakdown';

function input(over: Partial<CommodityBreakdownInput> = {}): CommodityBreakdownInput {
  return {
    siteName: 'Woodland',
    periodLabel: 'June 2026',
    facilityLabel: 'Woodland',
    outbound: [],
    landfilledUnits: [],
    ...over,
  };
}

describe('buildCommodityBreakdown — block structure (§11)', () => {
  it('renders all 9 daily-log commodity blocks + the Landfilled Units block (10 total)', () => {
    const model = buildCommodityBreakdown(input());
    expect(model.blocks).toHaveLength(BLOCK_TAXONOMY.length + 1);
    expect(model.blocks.at(-1)!.key).toBe('landfilled_units');
  });

  it('empty period → every block present but marked empty; hasActivity false', () => {
    const model = buildCommodityBreakdown(input());
    expect(model.hasActivity).toBe(false);
    expect(model.blocks.every((b) => b.empty)).toBe(true);
  });

  it('buckets rows by commodity, per-transaction rows + per-block Lbs total', () => {
    const model = buildCommodityBreakdown(
      input({
        outbound: [
          { shipDateISO: '2026-06-03', commodity: 'foam', weightLbs: 1000, ticketNumber: 'T1', retracId: 'R1', recyclerName: null, recyclingPercentApplied: null, recycledLbs: null, landfilledLbs: null },
          { shipDateISO: '2026-06-10', commodity: 'foam', weightLbs: 500, ticketNumber: 'T2', retracId: null, recyclerName: null, recyclingPercentApplied: null, recycledLbs: null, landfilledLbs: null },
        ],
      }),
    );
    const foam = model.blocks.find((b) => b.key === 'foam')!;
    expect(foam.empty).toBe(false);
    expect(foam.rows).toHaveLength(2);
    expect(foam.totals[0]!.value).toBe('1,500 lb');
    expect(model.hasActivity).toBe(true);
  });

  it('metal block shows recycler + recovery-% + recycled-lbs columns (ADR-0055)', () => {
    const model = buildCommodityBreakdown(
      input({
        outbound: [
          { shipDateISO: '2026-06-05', commodity: 'metal', weightLbs: 10000, ticketNumber: 'M1', retracId: 'R9', recyclerName: 'Xtraction', recyclingPercentApplied: 0.81, recycledLbs: 8100, landfilledLbs: 1900 },
        ],
      }),
    );
    const metal = model.blocks.find((b) => b.key === 'metal')!;
    expect(metal.columns).toContain('Recovery %');
    expect(metal.columns).toContain('Recycled Lbs');
    expect(metal.rows[0]).toContain('Xtraction');
    expect(metal.rows[0]).toContain('81.00%');
    expect(metal.totals.find((t) => t.label === 'Total Recycled Lbs')!.value).toBe('8,100 lb');
  });

  it('Landfilled Units block: reason label mapping (water_logged → Wet) + unit total', () => {
    const model = buildCommodityBreakdown(
      input({
        landfilledUnits: [
          { movementDateISO: '2026-06-08', reason: 'bed_bug', units: 3, slipNumber: 'S1', retracId: null },
          { movementDateISO: '2026-06-09', reason: 'water_logged', units: 2, slipNumber: null, retracId: 'R2' },
        ],
      }),
    );
    const lf = model.blocks.at(-1)!;
    expect(lf.rows[0]).toContain('Bed Bug');
    expect(lf.rows[1]).toContain('Wet'); // water_logged → Wet (§11)
    expect(lf.totals[0]!.value).toBe('5');
  });
});
