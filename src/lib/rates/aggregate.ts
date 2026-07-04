// ADR-0043 — server-side rate aggregation over a date window.
//
// The ONE place that turns DB rows into the two pure `RateResult`s. Shared by
// the audit leg-fetcher (nightly R1/R2 checks) and the dashboard rate tiles, so
// the number the manager sees on the tile is the exact number the check grades.
// Takes an injected `db` so it is testable with a fake Prisma client.

import type { PrismaClient } from '@prisma/client';
import { recoveryRate } from './recovery';
import { recyclingRate } from './recycling';
import type { RateResult } from './types';

export interface RateInputs {
  recycling: RateResult;
  recovery: RateResult;
}

const rangeDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const toNum = (v: unknown): number => (v == null ? 0 : typeof v === 'number' ? v : Number(v));
const toNumOrNull = (v: unknown): number | null => (v == null ? null : typeof v === 'number' ? v : Number(v));

/** Aggregate `[startISO, endISO)` for one site into the recycling + recovery rates. */
export async function aggregateSiteRates(
  db: PrismaClient,
  siteId: string,
  startISO: string,
  endISO: string,
): Promise<RateInputs> {
  const range = { gte: rangeDate(startISO), lt: rangeDate(endISO) };
  const [outboundByCommodity, renovation, landfilled, processed] = await Promise.all([
    db.outboundMaterial.groupBy({
      by: ['commodity'],
      _sum: { weight_lbs: true },
      where: { site_id: siteId, ship_date: range },
    }),
    db.outboundMaterial.aggregate({
      _sum: { whole_units: true },
      where: { site_id: siteId, sub_category: 'renovation', ship_date: range },
    }),
    db.landfilledUnit.aggregate({ _sum: { units: true }, where: { site_id: siteId, disposal_date: range } }),
    db.processedUnitsDaily.aggregate({
      _sum: { stripped_program: true, stripped_non_program: true },
      where: { site_id: siteId, production_date: range },
    }),
  ]);

  const outbound = outboundByCommodity.map((g) => ({
    commodity: g.commodity as string,
    weightLbs: toNumOrNull(g._sum.weight_lbs),
  }));
  const landfilledUnits = toNum(landfilled._sum.units);
  const processedUnits = toNum(processed._sum.stripped_program) + toNum(processed._sum.stripped_non_program);
  const renovatedWholeUnits = toNum(renovation._sum.whole_units);

  return {
    recycling: recyclingRate({ outbound, landfilledUnits }),
    recovery: recoveryRate({ processedUnits, renovatedWholeUnits, landfilledUnits }),
  };
}
