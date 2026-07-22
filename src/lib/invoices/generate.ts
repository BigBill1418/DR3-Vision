// ADR-0041 D2 — the invoice math, §3.1 verbatim, as PURE functions.
//
// Every composer here takes already-fetched, typed inputs and returns a set of
// priced lines + their derived total. No DB, no clock, no I/O — so the money
// math is exhaustively unit-testable (mirrors the ADR-0039 comparators). The
// DB-fetch layer (`generation-inputs.ts`) resolves rates/rows and calls these.
//
// The workbook §3.1 map:
//   Processing (monthly): B6 = strippedProgram × processingRate · B7 = Σ incentives
//   · B8 = event misc (driver+labor+mileage+per-diem+misc) · B15 = B6+B7+B8.
//   Mid-month: B20 = strippedProgram(1st–15th) × rate.
//   EOM processing: B22 = B15 − B20, the B20 subtraction rendered as an explicit
//   NEGATIVE offset line (the honest "trade discount"): stored leaves are B6,B7,B8
//   and the offset; B15/B22 are DERIVED totals, never stored summed lines (storing
//   them too would double-count the total_cents invariant).
//   Transportation (separate invoice): B16 = freight + event freight + fuel
//   surcharge + container rentals. OR carries NO fuel line (structural guard).
//   OR collection-site count: manual $2.25 × site-count lines (no capture feed).

import {
  type EventCostRow,
  type InvoiceComposition,
  type InvoiceKind,
  type InvoiceLineDraft,
  InvoiceStructuralError,
  InvoiceZeroError,
  type JsonValue,
  LINE_CODE,
  type ManualLine,
  eventMiscCents,
  jurisdictionOfKind,
} from './types';

/**
 * Integer cents for `units × rateCents`. Units carry at most one decimal place
 * (`processed_units_daily` is Decimal(7,1)) and `rateCents` is an integer, so the
 * product has at most one decimal place and is far below 2^53 — `Math.round`
 * yields the exact cent with no float drift for any real DR3 volume.
 */
export function roundCents(units: number, rateCents: number): number {
  return Math.round(units * rateCents);
}

function sum(lines: readonly InvoiceLineDraft[]): number {
  return lines.reduce((acc, l) => acc + l.amountCents, 0);
}

// ────────────────────────────────────────────────────────────────────────
// Processing (B6/B7/B8 → B15; mid-month B20; EOM offset → B22)
// ────────────────────────────────────────────────────────────────────────

export type ProcessingKind = 'ca_processing_mid_month' | 'ca_processing_eom' | 'or_processing_eom';

export interface ProcessingGenerationInput {
  kind: ProcessingKind;
  /** Resolved `processing_rate` for the window (CA 1650¢, OR 1700¢). */
  processingRateCents: number;
  processingRateRef: JsonValue;
  /** stripped_program units over the invoice window (mid-month = 1st–15th). */
  strippedProgramUnits: number;
  strippedSource: JsonValue;
  /**
   * ADR-0041 amendment §8.3 — Σ stripped_non_program over the SAME window. Tracked
   * for reconciliation, never billed (persisted to `non_program_units_processed`).
   * Defaults to 0 when the caller omits it.
   */
  strippedNonProgramUnits?: number;
  /** Σ incentive_cents of paid-in-window incentive drop-offs (B7). */
  incentiveCentsTotal: number;
  incentiveUnits: number;
  incentiveSource: JsonValue;
  /** Event cost rows for B8 (empty when none / integration pending). */
  events: readonly EventCostRow[];
  /** True until the sibling's collection_events feed is wired at merge (D3). */
  eventsPending: boolean;
  /** CA EOM only — the mid-month processing amount already invoiced (positive). */
  midMonthOffsetCents?: number;
  midMonthOffsetUnits?: number | null;
  midMonthOffsetSource?: JsonValue;
  /**
   * CA EOM only — the mid-month invoice the offset subtracts (rollup §1.3).
   * Null when the offset was recomputed with no mid-month invoice on file.
   */
  midMonthReferenceInvoiceId?: string | null;
}

/**
 * Compose a processing invoice. Throws {@link InvoiceZeroError} when the
 * processing CHARGE (B6/B20) is 0¢ despite nonzero stripped-program units — a
 * rate/config defect, never a silent zero (D6). The CA-EOM *net* (B22) may be a
 * legitimate 0 when everything was pre-billed mid-month, so the guard is on the
 * charge basis, not the net.
 */
export function composeProcessing(input: ProcessingGenerationInput): InvoiceComposition {
  const lines: InvoiceLineDraft[] = [];
  let position = 0;

  // ADR-0041 amendment §8.3 — the program/non-program split, attached to EVERY
  // processing return path (mid-month, CA EOM, OR EOM). `programUnitsProcessed`
  // is the billable basis (== the B6/B20 line quantity); `nonProgramUnitsProcessed`
  // is tracked-only. MRC never bills on the non-program figure.
  const split = {
    programUnitsProcessed: input.strippedProgramUnits,
    nonProgramUnitsProcessed: input.strippedNonProgramUnits ?? 0,
  };

  if (input.kind === 'ca_processing_mid_month') {
    // Mid-month invoice = the B20 processing total only (incentives + events
    // settle at EOM). One line.
    const amount = roundCents(input.strippedProgramUnits, input.processingRateCents);
    lines.push({
      lineCode: LINE_CODE.midMonthProcessing,
      description: 'Mid-month processing (units 1st–15th × processing rate)',
      quantity: input.strippedProgramUnits,
      rateRef: input.processingRateRef,
      amountCents: amount,
      source: input.strippedSource,
      position: position++,
    });
    guardProcessingCharge(input, amount);
    return { ...finalize(lines), ...split };
  }

  // EOM processing (CA or OR): B6 + B7 + B8, then (CA only) the B20 offset.
  const b6 = roundCents(input.strippedProgramUnits, input.processingRateCents);
  lines.push({
    lineCode: LINE_CODE.processing,
    description: 'Processing (program units processed × processing rate)',
    quantity: input.strippedProgramUnits,
    rateRef: input.processingRateRef,
    amountCents: b6,
    source: input.strippedSource,
    position: position++,
  });

  if (input.incentiveUnits > 0 || input.incentiveCentsTotal !== 0) {
    lines.push({
      lineCode: LINE_CODE.incentives,
      description: 'Collector incentive payments (paid in window)',
      quantity: input.incentiveUnits,
      rateRef: null,
      amountCents: input.incentiveCentsTotal,
      source: input.incentiveSource,
      position: position++,
    });
  }

  // B8 event misc. When the integration is pending, the line ALWAYS renders (0¢,
  // source.pending) so the events leg is never silently absent (D3/D6).
  if (input.eventsPending || input.events.length > 0) {
    const b8 = input.events.reduce((acc, e) => acc + eventMiscCents(e), 0);
    lines.push({
      lineCode: LINE_CODE.eventMisc,
      description: 'Event misc (driver + labor wages, mileage, per diem, misc)',
      quantity: input.events.length,
      rateRef: null,
      amountCents: input.eventsPending ? 0 : b8,
      source: eventB8Source(input.events, input.eventsPending),
      position: position++,
    });
  }

  guardProcessingCharge(input, b6);

  if (input.kind === 'ca_processing_eom') {
    const offset = input.midMonthOffsetCents ?? 0;
    // GP terminology (rollup §1.3): the EOM invoice's subtraction line is the
    // literal GP "Trade discount" field Mary types. Line code stays B22.offset
    // (workbook §3.1); only the label speaks GP so her entry maps one-to-one.
    // NOTE: rows generated before 2026-07-09 carry the older wording ("Less:
    // mid-month processing already invoiced (offset)") — `line_code =
    // 'B22.offset'` is the ONLY stable join key; never match on description.
    lines.push({
      lineCode: LINE_CODE.eomOffset,
      description: 'Trade discount — mid-month processing already invoiced',
      quantity: input.midMonthOffsetUnits ?? null,
      rateRef: input.processingRateRef,
      amountCents: -offset,
      source: input.midMonthOffsetSource ?? { offset: true },
      position: position++,
    });
    // The trade-discount FIELDS are data about a REAL mid-month amount: a 0¢
    // offset with no referenced invoice (first month live, no 1st–15th
    // production) stores NULLs, not a phantom "$0.00 Trade discount" line for
    // Mary to look for in GP. The 0-amount offset LINE still renders (honest
    // subtraction, §3.1 parity).
    const hasRealDiscount = offset > 0 || input.midMonthReferenceInvoiceId != null;
    const composition = {
      ...finalize(lines),
      ...split,
      ...(hasRealDiscount
        ? {
            tradeDiscountCents: offset,
            tradeDiscountReferenceInvoiceId: input.midMonthReferenceInvoiceId ?? null,
          }
        : {}),
    };
    // A NEGATIVE net (mid-month exceeded the revised month total — e.g. the
    // workbook-wins sync revised 1st–15th units DOWN after the mid-month
    // invoice was approved) is not an invoice GP can take; per rollup §1.4 the
    // over-billed correction is a CREDIT MEMO against the mid-month invoice.
    // Refuse loud instead of composing a negative invoice someone could approve.
    if (composition.totalCents < 0) {
      throw new InvoiceStructuralError(
        'negative_total_needs_credit_memo',
        `CA EOM net is ${composition.totalCents}¢ (mid-month ${offset}¢ exceeds the month's ` +
          `gross ${composition.totalCents + offset}¢) — a negative invoice cannot be issued; ` +
          `raise a credit memo against the mid-month invoice instead (rollup §1.4)`,
      );
    }
    return composition;
  }

  return { ...finalize(lines), ...split };
}

/** Zero-guard on the processing charge basis (see {@link composeProcessing}). */
function guardProcessingCharge(input: ProcessingGenerationInput, chargeCents: number): void {
  if (input.strippedProgramUnits > 0 && chargeCents === 0) {
    throw new InvoiceZeroError({
      kind: input.kind,
      strippedProgramUnits: input.strippedProgramUnits,
      totalCents: 0,
    });
  }
}

function eventB8Source(events: readonly EventCostRow[], pending: boolean): JsonValue {
  const eventRefs: JsonValue = events.map((e) => ({
    id: e.id,
    date: e.eventDateISO,
    customer: e.customer,
    misc_cents: eventMiscCents(e),
  }));
  return pending ? { pending: 'events-integration', events: eventRefs } : { events: eventRefs };
}

// ────────────────────────────────────────────────────────────────────────
// Transportation (B16 = freight + event freight + fuel + rentals)
// ────────────────────────────────────────────────────────────────────────

export type TransportationKind = 'ca_transportation_eom' | 'or_transportation_eom';

export interface FreightLoadLeg {
  loadId: string;
  cents: number;
  /** The freight rate_ref the resolver returned ({kind:'tier'|'override', id}). */
  ref: JsonValue;
  dateISO: string;
}

export interface FuelLoadLeg {
  loadId: string;
  cents: number;
  applied: boolean;
  ref: JsonValue;
}

export interface RentalLeg {
  id: string;
  locationName: string;
  monthlyRateCents: number;
}

export interface TransportationGenerationInput {
  kind: TransportationKind;
  /** Resolved freight per transport-charged verified load (per-load ref in source). */
  freightLoads: readonly FreightLoadLeg[];
  /** Event rows carrying B16 event freight (empty when none / pending). */
  events: readonly EventCostRow[];
  eventsPending: boolean;
  /** CA-only per-load fuel surcharge. MUST be empty for OR (structural guard). */
  fuelLoads: readonly FuelLoadLeg[];
  /** Active container-rental rows in force for the month. */
  rentals: readonly RentalLeg[];
}

/**
 * Compose a transportation invoice. OR carries NO fuel line by construction:
 * passing any `fuelLoads` for an OR kind throws {@link InvoiceStructuralError}
 * (`or_transportation_no_fuel`) — the ADR-0037 D1 impossibility, exercised in
 * tests. Freight-resolution failure (e.g. OR tiers unseeded) is a typed throw
 * in the DB layer BEFORE composition; this pure function only assembles.
 */
export function composeTransportation(input: TransportationGenerationInput): InvoiceComposition {
  const jurisdiction = jurisdictionOfKind(input.kind);
  if (jurisdiction === 'OR' && input.fuelLoads.length > 0) {
    throw new InvoiceStructuralError(
      'or_transportation_no_fuel',
      'Oregon transportation invoices cannot carry a fuel surcharge (ADR-0037 D1)',
    );
  }

  const lines: InvoiceLineDraft[] = [];
  let position = 0;

  if (input.freightLoads.length > 0) {
    const freight = input.freightLoads.reduce((acc, l) => acc + l.cents, 0);
    lines.push({
      lineCode: LINE_CODE.freight,
      description: 'Freight (transport-charged inbound loads)',
      quantity: input.freightLoads.length,
      rateRef: null,
      amountCents: freight,
      source: {
        loads: input.freightLoads.map((l) => ({
          load_id: l.loadId,
          date: l.dateISO,
          cents: l.cents,
          ref: l.ref,
        })),
      },
      position: position++,
    });
  }

  if (input.eventsPending || input.events.length > 0) {
    // ADR-0056 amendment §A.3 — the two-haul-mode gate. Event freight rides
    // `event_transportation_total` (→ MILES 0) ONLY for events DR3 actually hauled
    // (Mode A, `dr3_hauled`). A Mode-B "someone else hauled" event contributes $0
    // freight here even though its labor still bills via the EVENTO/B8 line (which
    // is NOT gated — see composeProcessing). Full provenance for every event is
    // still recorded in `source`, each stamped with its `dr3_hauled` flag.
    const hauledEvents = input.events.filter((e) => e.dr3Hauled);
    const eventFreight = hauledEvents.reduce((acc, e) => acc + e.freightCents, 0);
    lines.push({
      lineCode: LINE_CODE.eventFreight,
      description: 'Event freight',
      quantity: input.eventsPending ? input.events.length : hauledEvents.length,
      rateRef: null,
      amountCents: input.eventsPending ? 0 : eventFreight,
      source: input.eventsPending
        ? { pending: 'events-integration' }
        : {
            events: input.events.map((e) => ({
              id: e.id,
              freight_cents: e.freightCents,
              dr3_hauled: e.dr3Hauled,
            })),
          },
      position: position++,
    });
  }

  // Fuel surcharge — CA only (guarded above). One rolled-up line; per-load refs
  // in source. `applied:false` loads contribute 0 but are recorded for evidence.
  if (jurisdiction === 'CA' && input.fuelLoads.length > 0) {
    const fuel = input.fuelLoads.reduce((acc, l) => acc + l.cents, 0);
    lines.push({
      lineCode: LINE_CODE.fuel,
      description: 'Fuel surcharge (CA weekly diesel index above trigger)',
      quantity: input.fuelLoads.length,
      rateRef: null,
      amountCents: fuel,
      source: {
        loads: input.fuelLoads.map((l) => ({
          load_id: l.loadId,
          cents: l.cents,
          applied: l.applied,
          ref: l.ref,
        })),
      },
      position: position++,
    });
  }

  if (input.rentals.length > 0) {
    const rentals = input.rentals.reduce((acc, r) => acc + r.monthlyRateCents, 0);
    lines.push({
      lineCode: LINE_CODE.rentals,
      description: 'Container / trailer rentals (active for the month)',
      quantity: input.rentals.length,
      rateRef: null,
      amountCents: rentals,
      source: {
        rentals: input.rentals.map((r) => ({
          id: r.id,
          location: r.locationName,
          monthly_rate_cents: r.monthlyRateCents,
        })),
      },
      position: position++,
    });
  }

  return finalize(lines);
}

// ────────────────────────────────────────────────────────────────────────
// OR collection-site count (manual lines only — D2)
// ────────────────────────────────────────────────────────────────────────

/**
 * Compose the OR collection-site-count invoice from operator-entered manual
 * lines ($2.25 × site counts). Every line is stamped `source.manual = true`
 * provenance — there is no Vision capture feed for these counts yet (D2). The
 * generator accepts the lines via parameter; the sibling builds the entry surface.
 */
export function composeCollectionSiteCount(manualLines: readonly ManualLine[]): InvoiceComposition {
  const lines: InvoiceLineDraft[] = manualLines.map((m, i) => ({
    lineCode: LINE_CODE.satellite,
    description: m.description,
    quantity: m.quantity ?? null,
    rateRef: m.rateRef ?? null,
    amountCents: m.amountCents,
    source: { manual: true },
    position: i,
  }));
  return finalize(lines);
}

// ────────────────────────────────────────────────────────────────────────
// Kind dispatch (for the service; keeps the six kinds in one exhaustive switch)
// ────────────────────────────────────────────────────────────────────────

export type GenerationInput =
  | { kind: ProcessingKind; processing: ProcessingGenerationInput }
  | { kind: TransportationKind; transportation: TransportationGenerationInput }
  | { kind: 'or_collection_site_count'; manualLines: readonly ManualLine[] };

export function composeInvoice(input: GenerationInput): InvoiceComposition {
  if ('processing' in input) return composeProcessing(input.processing);
  if ('transportation' in input) return composeTransportation(input.transportation);
  return composeCollectionSiteCount(input.manualLines);
}

export function assertKindHasComposer(kind: InvoiceKind): void {
  // Exhaustiveness guard: a new kind must be wired here before it can generate.
  const known: Record<InvoiceKind, true> = {
    ca_processing_mid_month: true,
    ca_processing_eom: true,
    ca_transportation_eom: true,
    or_processing_eom: true,
    or_transportation_eom: true,
    or_collection_site_count: true,
  };
  if (!known[kind]) {
    throw new InvoiceStructuralError(
      'wrong_kind_for_composer',
      `no composer for invoice kind ${kind}`,
    );
  }
}

function finalize(lines: InvoiceLineDraft[]): InvoiceComposition {
  return { lines, totalCents: sum(lines) };
}
