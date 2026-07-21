// ADR-0041 amendment (rollup §11) — DB reads for the commodity breakdown.
//
// Reads the two source tables for the invoice window and maps them onto the PURE
// model inputs (breakdown.ts): `outbound_materials` (the commodity blocks) and
// `unit_status_movements` where `to_status = landfilled` (the whole-unit
// Landfilled Units block). Read-only; the pure builder + renderer do the rest.

import { prisma } from '@/lib/prisma';
import { dayISO, dayKeyUTCFromISO } from '@/lib/time';
import {
  buildCommodityBreakdown,
  renderCommodityBreakdownPdf,
} from '.';
import type { CommodityBreakdownModel } from './breakdown';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "June 2026" from a first-of-month ISO date. */
export function periodLabelFromMonthISO(billingMonthISO: string): string {
  const d = dayKeyUTCFromISO(billingMonthISO);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface CommodityBreakdownFetchArgs {
  siteId: string;
  siteName: string;
  billingMonthISO: string; // first-of-month
  windowStartISO: string; // inclusive YYYY-MM-DD
  windowEndISO: string; // inclusive YYYY-MM-DD
}

/**
 * Build the commodity-breakdown model for a site + billing window from the DB.
 * The window bounds are inclusive `@db.Date` keys; the queries use a half-open
 * upper bound (< endExclusive) so the last day is fully included.
 */
export async function loadCommodityBreakdown(
  args: CommodityBreakdownFetchArgs,
): Promise<CommodityBreakdownModel> {
  const start = dayKeyUTCFromISO(args.windowStartISO);
  const endInclusive = dayKeyUTCFromISO(args.windowEndISO);
  const endExclusive = dayKeyUTCFromISO(
    dayISO(new Date(Date.UTC(endInclusive.getUTCFullYear(), endInclusive.getUTCMonth(), endInclusive.getUTCDate() + 1))),
  );

  const [outbound, landfilled] = await Promise.all([
    prisma.outboundMaterial.findMany({
      where: { site_id: args.siteId, ship_date: { gte: start, lt: endExclusive } },
      orderBy: [{ commodity: 'asc' }, { ship_date: 'asc' }],
      select: {
        ship_date: true,
        commodity: true,
        weight_lbs: true,
        ticket_number: true,
        retrac_id: true,
        buyer: true,
        vendor: { select: { name: true } },
        recycling_percent_applied: true,
        recycled_lbs: true,
        landfilled_lbs: true,
      },
    }),
    prisma.unitStatusMovement.findMany({
      where: {
        site_id: args.siteId,
        to_status: 'landfilled',
        movement_date: { gte: start, lt: endExclusive },
      },
      orderBy: [{ movement_date: 'asc' }],
      select: {
        movement_date: true,
        landfilled_reason: true,
        units: true,
        slip_number: true,
        retrac_id: true,
      },
    }),
  ]);

  return buildCommodityBreakdown({
    siteName: args.siteName,
    periodLabel: periodLabelFromMonthISO(args.billingMonthISO),
    facilityLabel: args.siteName,
    outbound: outbound.map((r) => ({
      shipDateISO: dayISO(r.ship_date),
      commodity: r.commodity,
      weightLbs: r.weight_lbs,
      ticketNumber: r.ticket_number,
      retracId: r.retrac_id,
      recyclerName: r.vendor?.name ?? r.buyer ?? null,
      recyclingPercentApplied: r.recycling_percent_applied != null ? Number(r.recycling_percent_applied) : null,
      recycledLbs: r.recycled_lbs,
      landfilledLbs: r.landfilled_lbs,
    })),
    landfilledUnits: landfilled.map((r) => ({
      movementDateISO: dayISO(r.movement_date),
      reason: r.landfilled_reason ?? 'other',
      units: r.units,
      slipNumber: r.slip_number,
      retracId: r.retrac_id,
    })),
  });
}

/**
 * Produce the commodity-breakdown PDF bytes for an invoice window (the EOM
 * processing companion attachment, §5.1). Convenience entry that fetches the
 * model and renders it. `generatedAt` pins reproducible metadata.
 */
export async function buildInvoiceCommodityBreakdownPdf(
  args: CommodityBreakdownFetchArgs,
  generatedAt?: Date,
): Promise<Buffer> {
  const model = await loadCommodityBreakdown(args);
  return renderCommodityBreakdownPdf(model, generatedAt);
}
