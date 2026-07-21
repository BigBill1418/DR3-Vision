// ADR-0041 D2 — the DB-fetch layer that resolves rates + operational rows into
// the PURE composer inputs (`generate.ts`). All money resolution goes through the
// ADR-0037/0040 named resolvers so a rate is NEVER hardcoded and a missing input
// fails LOUD (freight-unresolvable, missing-fuel-price) rather than billing $0.
//
// The events (B8 / event-freight) leg reads `collection_events` through
// `event-leg.ts` (wired at merge); OR collection-site-count lines read the
// stored `or_collection_site_counts` capture rows (entered once, never re-typed).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { INVOICE_STATUSES } from '@/lib/exports';
import { log } from '@/lib/observability/logger';
import { resolveRateCents } from '@/lib/program-rules/resolver';
import { resolveFreightCents } from '@/lib/billing-rates/freight-resolver';
import { computeFuelSurchargeCents } from '@/lib/billing-rates/fuel';
import { monthWindowUTC, billedRentalCents } from '@/lib/billing-rates/rental-billing';
import {
  dayKeyUTCFromISO,
  pacificDayKeyUTC,
  pacificDayStartInstant,
  pacificDayStartInstantPlus,
} from '@/lib/time';
import type {
  ProcessingGenerationInput,
  ProcessingKind,
  TransportationGenerationInput,
  TransportationKind,
  FreightLoadLeg,
  FuelLoadLeg,
  RentalLeg,
} from './generate';
import type { EventCostRow, JsonValue } from './types';
import { fetchEventCostRows } from './event-leg';

/** The events leg the composers consume, plus the pending flag. */
export interface EventLeg {
  events: EventCostRow[];
  pending: boolean;
}

/**
 * Load the collection-events cost leg for a window — wired to the capture
 * half's `collection_events` via `fetchEventCostRows` (the one-line integration
 * this seam was designed for).
 */
export async function loadEventLeg(
  siteId: string,
  windowStartISO: string,
  windowEndISO: string,
): Promise<EventLeg> {
  const events = await fetchEventCostRows(siteId, windowStartISO, windowEndISO);
  return { events, pending: false };
}

/**
 * OR collection-site-count lines from the STORED capture rows (the sibling's
 * `or_collection_site_counts` entry surface) for a billing month. Stored rows
 * are the canonical input; any request-supplied manual lines are appended after
 * (both carry manual provenance — D2's honest island, now entered once).
 */
export async function loadOrCountManualLines(
  siteId: string,
  billingMonthISO: string,
): Promise<import('./types').ManualLine[]> {
  const monthKey = dayKeyUTCFromISO(billingMonthISO.slice(0, 8) + '01');
  const [rows, rateCents] = await Promise.all([
    prisma.orCollectionSiteCount.findMany({
      where: { site_id: siteId, billing_month: monthKey },
      orderBy: { location: 'asc' },
    }),
    resolveRateCents(siteId, 'satellite_collection_rate', monthKey),
  ]);
  log.debug(
    {
      op: 'invoice.or_count_lines',
      site_id: siteId,
      billing_month: billingMonthISO,
      rows: rows.length,
    },
    '[invoices] OR collection-site-count lines loaded from stored capture rows',
  );
  return rows.map((r) => ({
    description: r.location,
    quantity: r.units,
    amountCents: r.units * rateCents,
    rateRef: { rule_kind: 'satellite_collection_rate', rate_cents: rateCents, count_row_id: r.id },
  }));
}

/** UTC bounds for a @db.Date column over an inclusive `YYYY-MM-DD` window. */
function dateColumnBounds(windowStartISO: string, windowEndISO: string): { gte: Date; lte: Date } {
  return { gte: dayKeyUTCFromISO(windowStartISO), lte: dayKeyUTCFromISO(windowEndISO) };
}

/** Pacific-day instant bounds `[start, endExclusive)` for an instant column. */
function instantBounds(windowStartISO: string, windowEndISO: string): { gte: Date; lt: Date } {
  const gte = pacificDayStartInstant(new Date(`${windowStartISO}T12:00:00Z`));
  const lt = pacificDayStartInstantPlus(1, new Date(`${windowEndISO}T12:00:00Z`));
  return { gte, lt };
}

function decToNumber(d: Prisma.Decimal | null): number {
  return d == null ? 0 : Number(d);
}

// ────────────────────────────────────────────────────────────────────────
// Processing inputs (B6/B7/B8 + CA-EOM offset)
// ────────────────────────────────────────────────────────────────────────

export async function resolveProcessingInputs(args: {
  siteId: string;
  kind: ProcessingKind;
  billingMonthISO: string;
  windowStartISO: string;
  windowEndISO: string;
}): Promise<ProcessingGenerationInput> {
  const { siteId, kind, windowStartISO, windowEndISO } = args;
  const asOf = dayKeyUTCFromISO(windowStartISO);
  const dateBounds = dateColumnBounds(windowStartISO, windowEndISO);

  const rate = await resolveRateCents(siteId, 'processing_rate', asOf);

  const stripped = await prisma.processedUnitsDaily.aggregate({
    _sum: { stripped_program: true, stripped_non_program: true },
    where: { site_id: siteId, production_date: dateBounds },
  });
  const strippedProgramUnits = decToNumber(stripped._sum.stripped_program);
  // §8.3 — the tracked-but-off-invoice basis (never billed; persisted for
  // reconciliation). Same window as the billable program units.
  const strippedNonProgramUnits = decToNumber(stripped._sum.stripped_non_program);

  // B7 incentives — key on the drop-off Date (the workbook Paid-Unpaid Date
  // column; incentives are paid at drop-off), kind=incentive only.
  const incentive = await prisma.consumerDropoff.aggregate({
    _sum: { incentive_cents: true, units: true },
    where: { site_id: siteId, kind: 'incentive', dropoff_date: dateBounds },
  });
  const incentiveCentsTotal = incentive._sum.incentive_cents ?? 0;
  const incentiveUnits = incentive._sum.units ?? 0;

  const eventLeg =
    kind === 'ca_processing_mid_month'
      ? { events: [], pending: false }
      : await loadEventLeg(siteId, windowStartISO, windowEndISO);

  const base: ProcessingGenerationInput = {
    kind,
    processingRateCents: rate,
    processingRateRef: { rule_kind: 'processing_rate', as_of: windowStartISO, rate_cents: rate },
    strippedProgramUnits,
    strippedNonProgramUnits,
    strippedSource: {
      table: 'processed_units_daily',
      window: [windowStartISO, windowEndISO],
      field: 'stripped_program',
    },
    incentiveCentsTotal,
    incentiveUnits,
    incentiveSource: {
      table: 'consumer_dropoffs',
      kind: 'incentive',
      window: [windowStartISO, windowEndISO],
      basis: 'dropoff_date',
    },
    events: eventLeg.events,
    eventsPending: eventLeg.pending,
  };

  if (kind !== 'ca_processing_eom') return base;

  // CA EOM offset (B20 → B22): prefer the actual mid-month invoice's total (what
  // was already invoiced — the honest QuickBooks subtraction). Fall back to a
  // recompute from the 1st–15th stripped units when no mid-month invoice is on file.
  const offset = await resolveMidMonthOffset(args.siteId, args.billingMonthISO, rate);
  return { ...base, ...offset };
}

async function resolveMidMonthOffset(
  siteId: string,
  billingMonthISO: string,
  rateCents: number,
): Promise<
  Pick<
    ProcessingGenerationInput,
    | 'midMonthOffsetCents'
    | 'midMonthOffsetUnits'
    | 'midMonthOffsetSource'
    | 'midMonthReferenceInvoiceId'
  >
> {
  const billingMonth = dayKeyUTCFromISO(billingMonthISO);
  // APPROVED only: a draft's total was never actually invoiced, and drafts
  // void on regenerate — persisting a draft's id/total into the new
  // trade_discount_* columns would freeze provenance pointing at a voided
  // number. No approved mid-month invoice ⇒ the recompute fallback below.
  const midInvoice = await prisma.invoice.findFirst({
    where: {
      site_id: siteId,
      kind: 'ca_processing_mid_month',
      billing_month: billingMonth,
      status: 'approved',
    },
    orderBy: [{ version: 'desc' }],
    include: { lines: true },
  });
  if (midInvoice) {
    const b20 = midInvoice.lines.find((l) => l.line_code === 'B20');
    return {
      midMonthOffsetCents: midInvoice.total_cents,
      midMonthOffsetUnits: b20?.quantity != null ? Number(b20.quantity) : null,
      midMonthOffsetSource: {
        basis: 'mid_month_invoice',
        invoice_id: midInvoice.id,
        version: midInvoice.version,
      },
      midMonthReferenceInvoiceId: midInvoice.id,
    };
  }

  // No mid-month invoice on file — recompute the 1st–15th processing total.
  const first = new Date(Date.UTC(billingMonth.getUTCFullYear(), billingMonth.getUTCMonth(), 1));
  const fifteenth = new Date(
    Date.UTC(billingMonth.getUTCFullYear(), billingMonth.getUTCMonth(), 15),
  );
  const stripped = await prisma.processedUnitsDaily.aggregate({
    _sum: { stripped_program: true },
    where: { site_id: siteId, production_date: { gte: first, lte: fifteenth } },
  });
  const units = decToNumber(stripped._sum.stripped_program);
  return {
    midMonthOffsetCents: Math.round(units * rateCents),
    midMonthOffsetUnits: units,
    midMonthOffsetSource: { basis: 'recomputed_no_mid_month_invoice', window: ['1st', '15th'] },
    midMonthReferenceInvoiceId: null,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Transportation inputs (B16 = freight + event freight + fuel + rentals)
// ────────────────────────────────────────────────────────────────────────

export async function resolveTransportationInputs(args: {
  siteId: string;
  kind: TransportationKind;
  billingMonthISO: string;
  windowStartISO: string;
  windowEndISO: string;
}): Promise<TransportationGenerationInput> {
  const { siteId, kind, windowStartISO, windowEndISO } = args;
  const jurisdiction = kind === 'or_transportation_eom' ? 'OR' : 'CA';
  const instant = instantBounds(windowStartISO, windowEndISO);

  // Transport-charged, billing-ready inbound loads in the window. The two
  // Inbound-tab split is `transport_charged`; billing-readiness is the canonical
  // `INVOICE_STATUSES` set (submitted+verified+submitted_to_mymrc+processed),
  // shared verbatim with the MRC Monthly Invoice export (`exports/mrc`) — same
  // status contract, one source of truth, so a load that bills here is never
  // silently dropped there. NOTE: only the STATUS set is shared, not the time
  // window — generation bounds loads by Pacific-day instants (`instantBounds`)
  // while `exports/mrc` uses a UTC calendar month, so a load arriving in the
  // ~07:00–08:00 UTC dead-zone on the 1st can land in different months on the
  // two surfaces. That month-edge boundary is pre-existing; do not read this as
  // a load-for-load 1:1 guarantee when debugging an edge discrepancy.
  // `submitted` IS billing-ready per that contract; this is the BILLING set and
  // deliberately differs from inventory's `VERIFIED_INBOUND_STATUSES`
  // (running-balance), which excludes `submitted` because an operator-submitted
  // load is not yet a manager-verified physical on-hand count.
  const loads = await prisma.inboundLoad.findMany({
    where: {
      site_id: siteId,
      transport_charged: true,
      status: { in: [...INVOICE_STATUSES] },
      arrived_at: { gte: instant.gte, lt: instant.lt },
    },
    select: {
      id: true,
      source_id: true,
      arrived_at: true,
      source: { select: { canonical_mileage: true } },
    },
    orderBy: { arrived_at: 'asc' },
  });

  const freightLoads: FreightLoadLeg[] = [];
  const fuelLoads: FuelLoadLeg[] = [];
  for (const load of loads) {
    if (!load.source_id || !load.arrived_at) {
      // Fail loud: a transport-charged load with no source/date can never price.
      throw new FreightInputError(load.id, 'missing source_id or arrived_at');
    }
    const priceDate = pacificDayKeyUTC(load.arrived_at);
    const freight = await resolveFreightCents({
      sourceId: load.source_id,
      date: priceDate,
      db: prisma,
    });
    freightLoads.push({
      loadId: load.id,
      cents: freight.cents,
      ref: freight.ref as unknown as JsonValue,
      dateISO: priceDate.toISOString().slice(0, 10),
    });

    // Fuel surcharge — CA only (OR is structurally disallowed; skip entirely).
    if (jurisdiction === 'CA') {
      // Fail loud, never $0 (D7): a CA transport-charged load with no canonical
      // mileage cannot price its surcharge. Overrides in account_haul_rates
      // price the FREIGHT without touching the source row, so mileage can be
      // legitimately absent there — before this guard that path silently
      // billed fuel = (price/mpg) × 0 with applied:true, forever.
      const miles = load.source?.canonical_mileage;
      if (miles == null) {
        throw new FreightInputError(
          load.id,
          `source ${load.source_id} has no canonical_mileage — CA fuel surcharge cannot price ` +
            `(set the mileage on the source, or zero it explicitly if the lane is truly 0 mi)`,
        );
      }
      const fuel = await computeFuelSurchargeCents({ siteId, date: priceDate, miles });
      fuelLoads.push({
        loadId: load.id,
        cents: fuel.cents,
        applied: fuel.applied,
        ref: fuel.ref as unknown as JsonValue,
      });
    }
  }

  const rentals = await resolveRentals(siteId, args.billingMonthISO);
  const eventLeg = await loadEventLeg(siteId, windowStartISO, windowEndISO);

  return {
    kind,
    freightLoads,
    events: eventLeg.events,
    eventsPending: eventLeg.pending,
    fuelLoads,
    rentals,
  };
}

/** A transport-charged load could not be priced (no source / no date). */
export class FreightInputError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly loadId: string,
    reason: string,
  ) {
    super(`transport-charged load ${loadId} cannot be priced: ${reason}`);
    this.name = 'FreightInputError';
  }
}

/**
 * Active container-rental rows in force for the billing month. The `where` mirrors the
 * pure `rentalOverlapsMonth` selection (rental-billing.ts) and each selected row bills
 * its FULL monthly rate via `billedRentalCents` — NEVER prorated by day (ADR-0040 §3.6,
 * C-10). A rental that starts on the 28th and spans into the next month is selected — and
 * billed in full — in BOTH months.
 */
async function resolveRentals(siteId: string, billingMonthISO: string): Promise<RentalLeg[]> {
  const { monthStart, monthEnd } = monthWindowUTC(dayKeyUTCFromISO(billingMonthISO));
  const rows = await prisma.containerRentalSite.findMany({
    where: {
      site_id: siteId,
      active: true,
      effective_from: { lte: monthEnd },
      OR: [{ effective_to: null }, { effective_to: { gte: monthStart } }],
    },
    select: { id: true, location_name: true, monthly_rate_cents: true },
    orderBy: { location_name: 'asc' },
  });
  return rows.map((r) => ({
    id: r.id,
    locationName: r.location_name,
    monthlyRateCents: billedRentalCents(r),
  }));
}
