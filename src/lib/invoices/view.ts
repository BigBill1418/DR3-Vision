// ADR-0041 — invoice read-model + the total_cents invariant (shared by the
// service and the lifecycle so neither imports the other).
//
// `total_cents` is a DERIVED denormalization (Σ line amount_cents) stored on the
// row for list-surface query efficiency. `assertTotalMatchesLines` is the
// service-layer invariant enforced on EVERY write and re-asserted at approval
// (ADR-0033 tripwire philosophy): a stored total that silently disagrees with
// its lines is a defect, caught loud, never a rounding footnote.

import type { InvoiceKind, InvoiceMode, InvoiceStatus, JsonValue } from './types';

export interface InvoiceLineView {
  id: string;
  lineCode: string;
  description: string;
  quantity: string | null; // Decimal rendered as string (no float drift)
  rateRef: JsonValue;
  amountCents: number;
  source: JsonValue;
  position: number;
}

export interface InvoiceView {
  id: string;
  siteId: string;
  kind: InvoiceKind;
  billingMonth: Date;
  windowStart: Date;
  windowEnd: Date;
  version: number;
  supersedesId: string | null;
  status: InvoiceStatus;
  /** ADR-0041 amendment §3.4 — pilot (default) never reaches MRC; production may. */
  mode: InvoiceMode;
  totalCents: number;
  /** §8.3 — billable basis (processing kinds only; == B6/B20 quantity). */
  programUnitsProcessed: number | null;
  /** §8.3 — tracked-but-off-invoice (processing kinds only). */
  nonProgramUnitsProcessed: number | null;
  generatedBy: string | null;
  generatedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  voidedBy: string | null;
  voidedAt: Date | null;
  gateOverrideNote: string | null;
  /** rollup §1.3 — GP Trade discount (ca_processing_eom only; else null). */
  tradeDiscountCents: number | null;
  tradeDiscountReferenceInvoiceId: string | null;
  notes: string | null;
  lines: InvoiceLineView[];
}

/** Lite list row (no lines) for the list surface — the stored total avoids N+1. */
export interface InvoiceListItem {
  id: string;
  kind: InvoiceKind;
  billingMonth: Date;
  version: number;
  status: InvoiceStatus;
  totalCents: number;
  supersedesId: string | null;
  generatedAt: Date;
  approvedAt: Date | null;
}

/** The `total_cents` == Σ lines invariant was violated (a denormalization bug). */
export class InvoiceInvariantError extends Error {
  readonly status = 500 as const;
  constructor(readonly context: { invoiceId: string; storedTotal: number; lineSum: number }) {
    super(
      `invoice ${context.invoiceId} total_cents (${context.storedTotal}¢) != Σ lines (${context.lineSum}¢) — ` +
        `refusing to proceed with a total that disagrees with its lines`,
    );
    this.name = 'InvoiceInvariantError';
  }
}

/** An approved invoice may never be mutated — corrections are a new version. */
export class InvoiceImmutableError extends Error {
  readonly status = 409 as const;
  constructor(readonly invoiceId: string) {
    super(
      `invoice ${invoiceId} is approved and immutable — correct it with a superseding new version`,
    );
    this.name = 'InvoiceImmutableError';
  }
}

export class InvoiceNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(readonly invoiceId: string) {
    super(`invoice ${invoiceId} not found`);
    this.name = 'InvoiceNotFoundError';
  }
}

/**
 * Assert `storedTotal === Σ lines.amountCents`, else throw
 * {@link InvoiceInvariantError}. Pure; call on every write + at approval.
 */
export function assertTotalMatchesLines(
  invoiceId: string,
  storedTotal: number,
  lines: readonly { amountCents: number }[],
): void {
  const lineSum = lines.reduce((acc, l) => acc + l.amountCents, 0);
  if (lineSum !== storedTotal) {
    throw new InvoiceInvariantError({ invoiceId, storedTotal, lineSum });
  }
}

// ── DB-row → view (structural input keeps this module Prisma-free) ──────────

interface LineRow {
  id: string;
  line_code: string;
  description: string;
  quantity: { toString(): string } | null;
  rate_ref: unknown;
  amount_cents: number;
  source: unknown;
  position: number;
}

interface InvoiceRow {
  id: string;
  site_id: string;
  kind: string;
  billing_month: Date;
  window_start: Date;
  window_end: Date;
  version: number;
  supersedes_id: string | null;
  status: string;
  mode: string;
  total_cents: number;
  program_units_processed: { toString(): string } | null;
  non_program_units_processed: { toString(): string } | null;
  generated_by: string | null;
  generated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  voided_by: string | null;
  voided_at: Date | null;
  gate_override_note: string | null;
  trade_discount_cents?: number | null;
  trade_discount_reference_invoice_id?: string | null;
  notes: string | null;
  lines: LineRow[];
}

export function toInvoiceView(row: InvoiceRow): InvoiceView {
  return {
    id: row.id,
    siteId: row.site_id,
    kind: row.kind as InvoiceKind,
    billingMonth: row.billing_month,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    version: row.version,
    supersedesId: row.supersedes_id,
    status: row.status as InvoiceStatus,
    mode: row.mode as InvoiceMode,
    totalCents: row.total_cents,
    programUnitsProcessed:
      row.program_units_processed != null ? Number(row.program_units_processed.toString()) : null,
    nonProgramUnitsProcessed:
      row.non_program_units_processed != null
        ? Number(row.non_program_units_processed.toString())
        : null,
    generatedBy: row.generated_by,
    generatedAt: row.generated_at,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
    gateOverrideNote: row.gate_override_note,
    tradeDiscountCents: row.trade_discount_cents ?? null,
    tradeDiscountReferenceInvoiceId: row.trade_discount_reference_invoice_id ?? null,
    notes: row.notes,
    lines: [...row.lines]
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        id: l.id,
        lineCode: l.line_code,
        description: l.description,
        quantity: l.quantity != null ? l.quantity.toString() : null,
        rateRef: (l.rate_ref ?? null) as JsonValue,
        amountCents: l.amount_cents,
        source: (l.source ?? null) as JsonValue,
        position: l.position,
      })),
  };
}
