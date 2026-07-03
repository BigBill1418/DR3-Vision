// ADR-0039 — audit engine shared types.
//
// These are PLAIN TypeScript row interfaces, deliberately decoupled from Prisma.
// The comparators (C1–C7) and the workbook checks consume ONLY these interfaces.
// The DB-fetch layer that maps the sibling ADR-0037/0038 Prisma models onto
// these shapes lives in `leg-fetchers.INTEGRATION-PENDING.ts` and is NOT compiled
// into anything until the sibling tables land on main (see that file's header).
//
// Every leg row is shaped exactly per the sibling ADRs, incorporating their
// post-Addendum-B revisions:
//   - inbound program / non-program split (ADR-0037 D2)
//   - outbound commodity × sub-category with NULLABLE whole_units (ADR-0037 D4,
//     Addendum A §A4, Addendum B §B1)
//   - the §B4 daily-close ledger fields (processed/stripped, whole units sold,
//     landfilled, program vs NP ledgers separate, Saved excluded)
//
// Dates are `YYYY-MM-DD` business-day keys (Pacific calendar day, per
// `src/lib/time.ts`). Instants (submission times, close times) are ISO strings.
// Money is integer cents; weights integer lbs; unit counts are numbers
// (processed_units_daily is Decimal(7,1) — half-unit precision — so a plain
// number carries it faithfully for tolerance comparison).

// ────────────────────────────────────────────────────────────────────────
// Enum-ish string unions (mirror the Prisma enums but stay Prisma-free)
// ────────────────────────────────────────────────────────────────────────

export type CheckCode =
  | 'c1_inbound'
  | 'c2_processed'
  | 'c3_outbound'
  | 'c4_billing_basis'
  | 'c5_conservation'
  | 'c6_inventory_continuity'
  | 'c7_deadline'
  | 'summary_recompute';

export type FindingKind =
  | 'missing_counterpart'
  | 'value_mismatch'
  | 'date_mismatch'
  | 'unresolved_site'
  | 'dropped_row';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

/** Ascending order — index is the comparable rank. */
export const SEVERITY_ORDER: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export type LegSource = 'manual' | 'mymrc' | 'import';

/** outbound_materials commodity taxonomy (ADR-0037 D4 — the invoice/billing axis). */
export type Commodity =
  | 'landfill'
  | 'steel'
  | 'biomass'
  | 'wte'
  | 'wood'
  | 'toppers'
  | 'foam'
  | 'cardboard'
  | 'plastic'
  | 'cotton';

/** Addendum B §B1 sub-categories. `renovation` splits the renovator channel. */
export type OutboundSubCategory = 'renovation' | 'baled' | 'shredded';

// Minimal JSON value type for `expected`/`actual`/`detail` payloads.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

// ────────────────────────────────────────────────────────────────────────
// Window + config
// ────────────────────────────────────────────────────────────────────────

/** A half-open day window `[startISO, endISO)` scoped to one site. */
export interface AuditWindow {
  siteId: string;
  startISO: string; // inclusive 'YYYY-MM-DD'
  endISO: string; // exclusive 'YYYY-MM-DD'
  /**
   * The "as of" business day the run evaluates against (Pacific). Set to today
   * for a live sweep so grace windows (C3 EOD+1, C7 not-yet-late) suppress
   * discrepancies that are still within their contract clock. Left undefined for
   * a purely historical / retro run, where every clock has long since elapsed
   * and no grace suppression applies.
   */
  asOfISO?: string;
}

/** Runtime-resolved per-check config (a row of `audit_check_config`). */
export interface CheckConfig {
  checkCode: CheckCode;
  enabled: boolean;
  severity: Severity;
  /** Absolute unit tolerance before a count gap becomes a finding. */
  unitTolerance: number;
  /** Absolute weight tolerance (lbs). */
  weightToleranceLbs: number;
  /** Business-day grace before a same-day gap is a finding (C3 EOD+1 ⇒ 1). */
  graceBusinessDays: number;
  /** Long open window for slow-settling legs (vendor invoices ⇒ 45). */
  openWindowDays: number | null;
  /** Whether findings from this check feed the P2 billing trust gate. */
  blocksBilling: boolean;
  params: Record<string, JsonValue>;
}

// ────────────────────────────────────────────────────────────────────────
// Finding (comparator output, pre-persistence)
// ────────────────────────────────────────────────────────────────────────

export interface Finding {
  checkCode: CheckCode;
  siteId: string;
  windowStartISO: string;
  windowEndISO: string;
  severity: Severity;
  kind: FindingKind;
  /** Opaque reference into leg A (Vision row id / cell ref). */
  legARef: string | null;
  /** Opaque reference into leg B (external id / mirror id / summary ref). */
  legBRef: string | null;
  expected: JsonValue | null;
  actual: JsonValue | null;
  detail: JsonValue | null;
  /** Stable across runs — same discrepancy always yields the same string. */
  fingerprint: string;
}

// ────────────────────────────────────────────────────────────────────────
// Site alias resolution (precondition for historical joins — ADR-0039 D4)
// ────────────────────────────────────────────────────────────────────────

/**
 * Resolves a verbatim (drift-prone) workbook site name to a canonical site.
 * Wired to ADR-0037's `source_aliases` post-merge; the parser tests use an
 * in-memory implementation. An unresolvable name is never dropped — it emits an
 * `unresolved_site` finding.
 */
export interface SiteAliasResolver {
  resolve(rawName: string): { siteId: string; canonicalName: string; isNonProgram: boolean } | null;
}

// ────────────────────────────────────────────────────────────────────────
// Leg rows — Vision operational data (ADR-0037)
// ────────────────────────────────────────────────────────────────────────

/** Verified `inbound_loads` (C1 leg A / rollups / inventory). */
export interface InboundLegRow {
  id: string;
  retracId: string | null;
  externalHaulId: string | null;
  businessDateISO: string; // arrival business day
  totalUnits: number;
  programUnits: number | null;
  nonProgramUnits: number | null;
  slipNumber: string | null;
  transportCharged: boolean;
  source: LegSource;
  sourceSiteName: string | null;
  verifiedAtISO: string | null;
  /** When the load was entered into MyMRC (drives the C7 inbound clock). */
  mymrcSubmittedAtISO: string | null;
}

/** `consumer_dropoffs` (inbound rollups, non-program ledger, inventory). */
export interface ConsumerDropoffLegRow {
  id: string;
  dropoffDateISO: string;
  units: number;
  sourceType: 'unpaid_consumer_dropoff' | 'cip_consumer' | 'illegal_dropoff' | 'event';
  isNonProgram: boolean;
  source: LegSource;
}

/** `processed_units_daily` (+ post-B4 program/NP split) — the billing basis. */
export interface ProcessedLegRow {
  id: string;
  productionDateISO: string;
  unitsProcessed: number; // total
  programUnitsProcessed: number | null;
  nonProgramUnitsProcessed: number | null;
  source: LegSource;
  closedAtISO: string | null;
  /** When processed units were submitted to MyMRC (drives the C7 processed clock). */
  mymrcSubmittedAtISO: string | null;
}

/** `outbound_materials` — commodity × sub-category, NULLABLE whole_units (A4). */
export interface OutboundLegRow {
  id: string;
  shipDateISO: string;
  commodity: Commodity;
  subCategory: OutboundSubCategory | null;
  weightLbs: number | null;
  wholeUnits: number | null;
  baleCount: number | null;
  ticketNumber: string | null; // Material # (MyMRC-owned, EOD)
  retracId: string | null;
  buyer: string | null;
  source: LegSource;
  /** End-of-day close instant — the C7 outbound lateness clock starts here. */
  eodClosedAtISO: string | null;
  mymrcSubmittedAtISO: string | null;
}

/** `landfilled_units` — whole-unit disposal (distinct from weight commodities). */
export interface LandfilledLegRow {
  id: string;
  disposalDateISO: string;
  units: number;
  slipNumber: string | null;
  reason: string;
  source: LegSource;
}

// ────────────────────────────────────────────────────────────────────────
// Leg rows — MyMRC mirrors (ADR-0038)
// ────────────────────────────────────────────────────────────────────────

export interface MirrorHaulRow {
  externalHaulId: string;
  retracId: string | null;
  businessDateISO: string; // docking / haul date
  units: number | null;
  weightLbs: number | null;
  status: string;
  /** When the haul row was entered / finalized in MyMRC. */
  entryDateISO: string | null;
  firstSeenAtISO: string | null;
}

export interface MirrorProcessedRow {
  externalMaterialsId: string;
  processedDateISO: string;
  units: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  entryDateISO: string | null;
}

export interface MirrorOutboundRow {
  externalMaterialsId: string;
  shipDateISO: string;
  entryDateISO: string | null;
  weightLbs: number | null;
  units: number | null;
  ticketNumber: string | null; // Material #
  materialType: string | null;
  vendor: string | null;
}

// ────────────────────────────────────────────────────────────────────────
// Leg rows — billing (P2 invoices; historical workbook summaries stand in)
// ────────────────────────────────────────────────────────────────────────

export interface BillingLegRow {
  windowStartISO: string;
  windowEndISO: string;
  programUnitsBilled: number;
  ref: string; // invoice id or workbook Summary tab/cell ref
  source: 'workbook_summary' | 'invoice';
}

// ────────────────────────────────────────────────────────────────────────
// Internal-invariant inputs (C5 conservation, C6 continuity)
// ────────────────────────────────────────────────────────────────────────

/**
 * C5 conservation — one row per day. Program & non-program are conserved
 * SEPARATELY. Encodes Rick Q11's worked example directly: a 200-unit floor of
 * 150 program + 50 non-program, processing 150P + 25NP is legal; 151P is not.
 */
export interface ConservationRow {
  dateISO: string;
  inboundProgram: number;
  priorProcessedProgram: number;
  programRenovationOutflow: number;
  programProcessed: number;
  inboundNonProgram: number;
  priorProcessedNonProgram: number;
  nonProgramRenovationOutflow: number;
  nonProgramProcessed: number;
}

/**
 * C6 inventory continuity — one row per day. The equation is Addendum B §B4
 * verbatim: `End = Start + Inbound − Stripped − WholeUnitsSold − Landfilled`.
 * The NP ledger is checked separately; `Saved` is excluded (B10-2). Also
 * carries the recorded start (to catch the DAY6 hardcoded-roll break and the
 * Friday→Monday carryover class) and an optional physical snapshot for the
 * reconciliation delta.
 */
export interface InventoryDayRow {
  dateISO: string;
  /** The value stored as this day's starting balance (roll input). */
  recordedStart: number | null;
  inbound: number;
  stripped: number; // processed / deconstructed
  wholeUnitsSold: number; // renovator whole units out
  landfilled: number;
  /** The value the log/system stored as End (compared to the computed End). */
  recordedEnd: number | null;
  // Non-program ledger (separate).
  npRecordedStart: number | null;
  npInbound: number;
  npSold: number;
  npLandfilled: number;
  npRecordedEnd: number | null;
  /** Physical count for reconciliation delta (null when none that day). */
  physicalSnapshot: number | null;
}

// ────────────────────────────────────────────────────────────────────────
// Comparator function type (documentation aid)
// ────────────────────────────────────────────────────────────────────────

export type Comparator<LegA, LegB> = (
  window: AuditWindow,
  legA: LegA,
  legB: LegB,
  config: CheckConfig,
) => Finding[];
