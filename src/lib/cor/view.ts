// ADR-0042 — COR read-model + the typed error taxonomy (shared by the service,
// the lifecycle, and the render so none imports another).
//
// A certificate mirrors the ADR-0041 invoice immutability discipline: a FINALIZED
// certificate never mutates — a correction is a NEW version in a `supersedes_id`
// chain, both rows retained. Immutability is enforced at the SERVICE layer (this
// module only carries the errors + the row→view mapper, Prisma-free by structural
// input). No PII lives on a COR by design (D5), so nothing here is redaction-bound.

/** D1 — draft regenerates freely; finalized is immutable; void discards. */
export type CorStatus = 'draft' | 'finalized' | 'void';

/**
 * ADR-0042 amendment (2026-07-18) — the filing period. `end_of_month` is the full
 * reconciled close (inventory + FT/PT required, D3 tripwire + capacity banner);
 * `mid_month` is Rick's blank-figures filing (inventory/FT/PT left blank). Mirrors
 * the Prisma `CorPeriod` enum as a Prisma-free string union.
 */
export type CorPeriod = 'end_of_month' | 'mid_month';

/** JSON value type for the provenance blobs (no `any`). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CorView {
  id: string;
  siteId: string;
  coverMonth: Date;
  version: number;
  supersedesId: string | null;
  status: CorStatus;
  /** ADR-0042 amendment — end-of-month vs mid-month filing. */
  period: CorPeriod;
  /** Null on a `mid_month` certificate (inventory is filed blank). */
  inventoryUnits: number | null;
  inventorySource: JsonValue;
  ftHeadcount: number | null;
  ptHeadcount: number | null;
  headcountSource: JsonValue;
  signerName: string;
  signerTitle: string;
  preparedBy: string | null;
  preparedAt: Date;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  pdfStorageKey: string | null;
  notes: string | null;
}

/** Lite list row for the list surface (no provenance blobs). */
export interface CorListItem {
  id: string;
  coverMonth: Date;
  version: number;
  status: CorStatus;
  period: CorPeriod;
  inventoryUnits: number | null;
  ftHeadcount: number | null;
  ptHeadcount: number | null;
  supersedesId: string | null;
  preparedAt: Date;
  finalizedAt: Date | null;
}

// ── typed error taxonomy (D5: typed errors carry numbers) ───────────────────

/** No Exhibit 5 exists in Oregon — a COR is a CA-jurisdiction-only artifact. */
export class CorJurisdictionError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly siteId: string,
    readonly jurisdiction: string,
  ) {
    super(
      `COR (Exhibit 5) is a California-only certificate — site ${siteId} is ${jurisdiction}; no Oregon equivalent exists (ADR-0042 D1)`,
    );
    this.name = 'CorJurisdictionError';
  }
}

export class CorNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(readonly certId: string) {
    super(`cor certificate ${certId} not found`);
    this.name = 'CorNotFoundError';
  }
}

/** A finalized certificate may never be mutated — corrections are a new version. */
export class CorImmutableError extends Error {
  readonly status = 409 as const;
  constructor(readonly certId: string) {
    super(
      `cor certificate ${certId} is finalized and immutable — correct it with a superseding new version`,
    );
    this.name = 'CorImmutableError';
  }
}

/** An illegal COR status transition was attempted. */
export class CorTransitionError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly reason: 'not_draft' | 'not_finalized' | 'already_void',
    message: string,
  ) {
    super(message);
    this.name = 'CorTransitionError';
  }
}

/** Finalize requires BOTH FT and PT headcount to be entered at review (D2.2). */
export class CorHeadcountRequiredError extends Error {
  readonly status = 422 as const;
  constructor(readonly certId: string) {
    super(
      `cor certificate ${certId} cannot be finalized: the FT/PT headcount split must be entered at review before a human signs (ADR-0042 D2.2)`,
    );
    this.name = 'CorHeadcountRequiredError';
  }
}

/** The caller is not authorized to finalize this certificate (D3). */
export class CorFinalizeForbiddenError extends Error {
  readonly status = 403 as const;
  constructor() {
    super('finalizer must be an admin or the manager of this site');
    this.name = 'CorFinalizeForbiddenError';
  }
}

/**
 * Pre-render reconciliation tripwire (ADR-0033 style, D2.1/D3): the stored
 * `inventory_units` no longer equals the freshly-recomputed running balance for
 * the cover month. Carries BOTH numbers so the office sees the drift and the
 * refusal is provable. Nothing is finalized or rendered on this error.
 */
export class CorReconcileMismatchError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly context: { certId: string; storedUnits: number | null; recomputedUnits: number },
  ) {
    super(
      `cor certificate ${context.certId} inventory reconcile FAILED: stored ${context.storedUnits} units != recomputed ${context.recomputedUnits} units — ` +
        `the running balance moved since the draft was generated; regenerate the draft before finalizing (ADR-0042 D2.1/D3)`,
    );
    this.name = 'CorReconcileMismatchError';
  }
}

// ── DB-row → view (structural input keeps this module Prisma-free) ──────────

interface CorRow {
  id: string;
  site_id: string;
  cover_month: Date;
  version: number;
  supersedes_id: string | null;
  status: string;
  period: string;
  inventory_units: number | null;
  inventory_source: unknown;
  ft_headcount: number | null;
  pt_headcount: number | null;
  headcount_source: unknown;
  signer_name: string;
  signer_title: string;
  prepared_by: string | null;
  prepared_at: Date;
  finalized_by: string | null;
  finalized_at: Date | null;
  pdf_storage_key: string | null;
  notes: string | null;
}

export function toCorView(row: CorRow): CorView {
  return {
    id: row.id,
    siteId: row.site_id,
    coverMonth: row.cover_month,
    version: row.version,
    supersedesId: row.supersedes_id,
    status: row.status as CorStatus,
    period: row.period as CorPeriod,
    inventoryUnits: row.inventory_units,
    inventorySource: (row.inventory_source ?? null) as JsonValue,
    ftHeadcount: row.ft_headcount,
    ptHeadcount: row.pt_headcount,
    headcountSource: (row.headcount_source ?? null) as JsonValue,
    signerName: row.signer_name,
    signerTitle: row.signer_title,
    preparedBy: row.prepared_by,
    preparedAt: row.prepared_at,
    finalizedBy: row.finalized_by,
    finalizedAt: row.finalized_at,
    pdfStorageKey: row.pdf_storage_key,
    notes: row.notes,
  };
}
