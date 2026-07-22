// ADR-0057 §A.4 — the commodity-attachment renderer must SKIP inactive vendors.
// Covanta is seeded inactive (block/recovery % pending Rick); its name must never
// surface on the customer-facing commodity breakdown. Drives loadCommodityBreakdown
// against an in-memory `@/lib/prisma` mock.

import { describe, expect, it, vi } from 'vitest';

interface OutRow {
  ship_date: Date;
  commodity: string;
  weight_lbs: number;
  ticket_number: string | null;
  retrac_id: string | null;
  buyer: string | null;
  vendor: { name: string; is_active: boolean } | null;
  recycling_percent_applied: number | null;
  recycled_lbs: number | null;
  landfilled_lbs: number | null;
}

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const outboundRows: OutRow[] = [
  // active vendor → name shows
  { ship_date: D('2026-06-02'), commodity: 'metal', weight_lbs: 1000, ticket_number: 'T1', retrac_id: null, buyer: null, vendor: { name: 'Xtraction', is_active: true }, recycling_percent_applied: 0.81, recycled_lbs: 810, landfilled_lbs: 190 },
  // inactive vendor (Covanta), no buyer → suppressed to null
  { ship_date: D('2026-06-03'), commodity: 'metal', weight_lbs: 2000, ticket_number: 'T2', retrac_id: null, buyer: null, vendor: { name: 'Covanta', is_active: false }, recycling_percent_applied: null, recycled_lbs: null, landfilled_lbs: null },
  // inactive vendor but a free-text buyer present → falls through to buyer
  { ship_date: D('2026-06-04'), commodity: 'metal', weight_lbs: 500, ticket_number: 'T3', retrac_id: null, buyer: 'Walk-in buyer', vendor: { name: 'Covanta', is_active: false }, recycling_percent_applied: null, recycled_lbs: null, landfilled_lbs: null },
];

vi.mock('@/lib/prisma', () => ({
  prisma: {
    outboundMaterial: { findMany: async () => outboundRows },
    unitStatusMovement: { findMany: async () => [] },
  },
}));

const { loadCommodityBreakdown } = await import('./fetch');

describe('loadCommodityBreakdown — inactive vendor skip (§A.4)', () => {
  it('suppresses an inactive vendor’s name, shows active ones, falls to buyer', async () => {
    const model = await loadCommodityBreakdown({
      siteId: 'site-woodland',
      siteName: 'Woodland',
      billingMonthISO: '2026-06-01',
      windowStartISO: '2026-06-01',
      windowEndISO: '2026-06-30',
    });
    const metal = model.blocks.find((b) => b.key === 'metal')!;
    // vendorPct block columns: [Date, Recycler, Recovery %, Lbs, Recycled Lbs, Ticket #, Retrac ID]
    const recyclerCol = metal.rows.map((r) => r[1]);
    expect(recyclerCol).toEqual([
      'Xtraction', // active → shown
      '—', // Covanta inactive, no buyer → dash() of null
      'Walk-in buyer', // Covanta inactive but buyer present → buyer
    ]);
  });
});
