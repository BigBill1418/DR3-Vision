// ADR-0041 — invoice engine shared types.
//
// These are PLAIN TypeScript interfaces, decoupled from Prisma (mirrors the
// ADR-0039 audit-engine `types.ts` discipline). The PURE math (`generate.ts`)
// consumes ONLY these shapes; the DB-fetch layer (`generation-inputs.ts`) maps
// the Prisma rows onto them. This keeps the money math unit-testable with no DB.
//
// Money is integer CENTS throughout. Unit counts are numbers (processed units
// are Decimal(7,1) — half-unit precision — which a JS number carries faithfully
// for these magnitudes; see `roundCents` in `generate.ts`). Dates crossing the
// pure boundary are `YYYY-MM-DD` Pacific business-day keys (per `src/lib/time.ts`).

// ────────────────────────────────────────────────────────────────────────
// Enum-ish string unions (mirror the Prisma enums, stay Prisma-free)
// ────────────────────────────────────────────────────────────────────────

/** The six invoice kinds (D1). No `or_processing_mid_month` — OR is EOM-only. */
export type InvoiceKind =
  | 'ca_processing_mid_month'
  | 'ca_processing_eom'
  | 'ca_transportation_eom'
  | 'or_processing_eom'
  | 'or_transportation_eom'
  | 'or_collection_site_count';

export type InvoiceStatus = 'draft' | 'approved' | 'void';

/**
 * ADR-0041 amendment §3.4 — the launch safety net. `pilot` (the DEFAULT) routes
 * invoice previews to the pilot recipients (Bill + Rick) and is STRUCTURALLY
 * incapable of reaching MRC (see `planInvoiceDelivery` in `delivery.ts`);
 * `production` is the only mode whose delivery plan resolves to MRC.
 */
export type InvoiceMode = 'pilot' | 'production';

/** CA|OR — the freight/rate jurisdiction key (distinct from the site enum). */
export type Jurisdiction = 'CA' | 'OR';

/** Which processing/transportation kinds are Oregon. */
export const OR_KINDS: readonly InvoiceKind[] = [
  'or_processing_eom',
  'or_transportation_eom',
  'or_collection_site_count',
];

export const PROCESSING_KINDS: readonly InvoiceKind[] = [
  'ca_processing_mid_month',
  'ca_processing_eom',
  'or_processing_eom',
];

export const TRANSPORTATION_KINDS: readonly InvoiceKind[] = [
  'ca_transportation_eom',
  'or_transportation_eom',
];

export function jurisdictionOfKind(kind: InvoiceKind): Jurisdiction {
  return OR_KINDS.includes(kind) ? 'OR' : 'CA';
}

// ────────────────────────────────────────────────────────────────────────
// Kind display labels (single source — render-xlsx + admin/manager surfaces)
// ────────────────────────────────────────────────────────────────────────

/**
 * Human labels for the six kinds. Lives here (the home of `InvoiceKind`) so
 * every surface Mary cross-checks — the xlsx render, the verify page, the
 * manager list — says the same words. (An earlier per-file copy had already
 * drifted: "EOM" vs "End of Month".)
 */
export const KIND_LABEL: Record<InvoiceKind, string> = {
  ca_processing_mid_month: 'CA Processing — Mid-Month',
  ca_processing_eom: 'CA Processing — End of Month',
  ca_transportation_eom: 'CA Transportation — End of Month',
  or_processing_eom: 'OR Processing — End of Month',
  or_transportation_eom: 'OR Transportation — End of Month',
  or_collection_site_count: 'OR Collection-Site Count',
};

// ────────────────────────────────────────────────────────────────────────
// Line-code map (workbook §3.1)
// ────────────────────────────────────────────────────────────────────────

/**
 * The workbook §3.1 line codes. B6/B7/B8 are the processing leaves whose sum is
 * B15; `B22.offset` is the explicit NEGATIVE mid-month subtraction that turns
 * B15 into B22 on the CA EOM invoice (the "$118,239 trade discount" artifact,
 * rendered as an honest offset). B15 and B22 themselves are DERIVED totals, not
 * stored summed lines — storing them too would double-count the invariant.
 */
export const LINE_CODE = {
  processing: 'B6',
  incentives: 'B7',
  eventMisc: 'B8',
  midMonthProcessing: 'B20',
  eomOffset: 'B22.offset',
  freight: 'B16.freight',
  eventFreight: 'B16.event_freight',
  fuel: 'B16.fuel',
  rentals: 'B16.rentals',
  satellite: 'satellite',
  manual: 'manual',
} as const;

// ────────────────────────────────────────────────────────────────────────
// JSON provenance value
// ────────────────────────────────────────────────────────────────────────

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

// ────────────────────────────────────────────────────────────────────────
// Pure math I/O
// ────────────────────────────────────────────────────────────────────────

/** A priced line, pre-persistence. `amountCents` may be negative (offset). */
export interface InvoiceLineDraft {
  lineCode: string;
  description: string;
  quantity: number | null;
  rateRef: JsonValue;
  amountCents: number;
  source: JsonValue;
  position: number;
}

/** The composed set of lines + the derived total (Σ amountCents). */
export interface InvoiceComposition {
  lines: InvoiceLineDraft[];
  totalCents: number;
  /**
   * ca_processing_eom only (rollup §1.3 / ADR-0041 addendum): the GP "Trade
   * discount" as data — the POSITIVE mid-month amount the stored B22.offset
   * line subtracts, plus the mid-month invoice it references (null when the
   * offset was recomputed with no mid-month invoice on file). Persisted to
   * `invoices.trade_discount_cents` / `trade_discount_reference_invoice_id`.
   */
  tradeDiscountCents?: number;
  tradeDiscountReferenceInvoiceId?: string | null;
  /**
   * ADR-0041 amendment §8.3 — the program/non-program split persisted on the
   * invoice row. `programUnitsProcessed` is the BILLABLE basis (it EQUALS the
   * B6/B20 processing-line quantity — MRC pays on program units only);
   * `nonProgramUnitsProcessed` is tracked for reconciliation but never billed.
   * Set on processing kinds only; undefined (→ null) on transportation /
   * collection-site-count.
   */
  programUnitsProcessed?: number;
  nonProgramUnitsProcessed?: number;
}

// ────────────────────────────────────────────────────────────────────────
// B8 events integration contract (wired 2026-07-04 — event-leg.ts reads collection_events)
// ────────────────────────────────────────────────────────────────────────

/**
 * The typed shape the invoice engine consumes for a collection event's cost
 * components (ADR-0041 D3 / split note). The sibling agent owns
 * `collection_events`; this engine reads events ONLY through this interface, so
 * the two halves compile independently. The fetch that maps a real
 * `collection_events` row onto this shape lives in
 * `event-leg.ts` and was wired at
 * merge. Until then the events leg is treated as zero-with-warning and the B8
 * line renders with `source.pending = 'events-integration'` — never silently
 * absent (D6).
 *
 * Cost split (mission §3.1):
 *   - B8 (event misc) = driver wages + labor wages + mileage + per diem + misc.
 *   - Event FREIGHT rides the B16 transportation invoice, NOT B8 — carried here
 *     separately so the transportation composer can pick it up.
 * All fields are integer cents; the mapping resolves any hours×rate at the
 * boundary (events store actuals per D3).
 */
export interface EventCostRow {
  id: string;
  eventDateISO: string;
  customer: string | null;
  driverWagesCents: number;
  laborWagesCents: number;
  mileageCents: number;
  perDiemCents: number;
  miscCents: number;
  /** Rides B16 transportation, not B8. */
  freightCents: number;
  retracId: string | null;
}

/** Sum the B8-contributing cost components of one event (freight excluded). */
export function eventMiscCents(e: EventCostRow): number {
  return e.driverWagesCents + e.laborWagesCents + e.mileageCents + e.perDiemCents + e.miscCents;
}

// ────────────────────────────────────────────────────────────────────────
// Manual lines (OR collection-site count — no capture feed yet, D2)
// ────────────────────────────────────────────────────────────────────────

/**
 * A manually-entered line for the OR collection-site-count invoice. The counts
 * come from MRC's remote sites and have no Vision capture surface yet (D2), so
 * this invoice kind is built from operator-entered lines with provenance
 * `source.manual = true`. The generator accepts these via parameter now; the
 * sibling builds the entry surface and the route wires it at merge.
 */
export interface ManualLine {
  description: string;
  /** e.g. the site count the $2.25 satellite rate is applied to. */
  quantity?: number | null;
  amountCents: number;
  /** Optional per-line rate provenance, e.g. { rule_kind, rate_cents }. */
  rateRef?: JsonValue;
}

// ────────────────────────────────────────────────────────────────────────
// Typed errors (money paths fail loud — D6)
// ────────────────────────────────────────────────────────────────────────

/**
 * A processing invoice generated a 0¢ total while the window had a NONZERO
 * stripped-program count — the ADR-0033 lesson at invoice scale: a zero that
 * should be a real number is a defect, never a silent pass. Carries the numbers.
 */
export class InvoiceZeroError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly context: {
      kind: InvoiceKind;
      strippedProgramUnits: number;
      totalCents: number;
    },
  ) {
    super(
      `invoice ${context.kind} computed a 0¢ total for a window with ` +
        `${context.strippedProgramUnits} stripped-program units — refusing to persist a silent zero`,
    );
    this.name = 'InvoiceZeroError';
  }
}

/**
 * A structural impossibility was requested of the composer — e.g. a fuel leg on
 * an Oregon transportation invoice (OR fuel surcharge is structurally disallowed,
 * ADR-0037 D1). Distinct from a data error: this can only arise from a caller
 * bug, so it fails loud rather than silently dropping the leg.
 */
export class InvoiceStructuralError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly reason:
      | 'or_transportation_no_fuel'
      | 'wrong_kind_for_composer'
      | 'negative_total_needs_credit_memo',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceStructuralError';
  }
}
