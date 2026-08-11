// ADR-0048 D1/D2 — staging→operational promotion (one-shot, idempotent, audited).
//
// The ADR-0023 historical-import discipline (SHA gate + idempotency + provenance +
// audit) applied to loads/inventory. Reads a workbook's parsed staging rows
// (ADR-0039 `workbook_import_rows`) and promotes them, in ONE transaction, into
// the operational tables with `source = 'import'` and the promotion id stamped in
// each row's `import_id`. Re-runs are no-ops (the `workbook_promotions.import_id`
// UNIQUE guard); a re-run whose staged content changed is REFUSED (SHA mismatch);
// any live (non-import) row in the scope window is REFUSED (no silent merge); and
// the whole thing REFUSES COMMIT unless the recomputed June-close balance matches
// the known figure (D2 live assertion, via the shared `computeRunningBalance`).
//
// ── The promotion staging contract ──────────────────────────────────────
// The ADR-0039 parser is deliberately structural and thin (source-type rollups).
// This promotion consumes a RICHER, DOCUMENTED per-record staging shape — the
// shape the finalized daily-log parser will emit once Bill supplies the real
// `JUNE 2026 DAILY LOG WOODLAND.xlsm` (ADR-0048 D4). Until then it is exercised
// against Addendum-B-shaped fixtures built directly as staging rows. Each
// promotable `WorkbookImportRow` carries:
//   - `section`   — the target selector (see PROMOTION_SECTIONS)
//   - `raw_value` — a JSON object of the record's full field-set (decoded strictly)
//   - `numeric_value` — the headline quantity (units/weight), for cheap sums
//   - `site_name_raw` — the inbound source name (resolved via `source_aliases`)
//   - `provenance` — { tab, row, col } evidence
// A row whose section/shape is unrecognized is a typed PromotionParseError listing
// its provenance — never a silently guessed row.

import { createHash } from 'node:crypto';
import {
  Prisma,
  type PrismaClient,
  type OutboundCommodity,
  type OutboundSubCategory,
  type ConsumerDropoffKind,
  type LandfilledReason,
  type LoadSourceType,
} from '@prisma/client';
import { dayKeyUTCFromISO, pacificMidnightInstantOfDayISO } from '@/lib/time';
import {
  computeRunningBalance,
  snapshotTotalUnits,
  type RunningBalance,
} from '@/lib/inventory/running-balance';
import { computeInventoryClose, type InventoryClosePools } from '@/lib/inventory/inventory-close';
import { notVoidedSnapshotWhere } from '@/lib/inventory/snapshot-void';
import { notVoidedLoadWhere } from '@/lib/loads/not-voided';
import type { SiteAliasResolver } from './types';

const D = Prisma.Decimal;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────
// Scope + result
// ─────────────────────────────────────────────────────────────────────────

/** The hard scope a promotion runs under. `from`/`to` are inclusive ISO days. */
export interface PromotionScope {
  siteId: string;
  from: string; // YYYY-MM-DD inclusive
  to: string; // YYYY-MM-DD inclusive
  /**
   * D2 live assertion — the known June-close on-hand TOTAL for this site/window.
   * The promotion recomputes the close via `computeRunningBalance` and REFUSES
   * COMMIT if it disagrees. Null skips the assertion (a window with no anchor).
   */
  expectedCloseTotal?: number | null;
}

export type PromotedTable =
  | 'processed_units_daily'
  | 'inbound_loads'
  | 'outbound_materials'
  | 'landfilled_units'
  | 'consumer_dropoffs'
  | 'site_inventory_snapshots';

export type PromotionCounts = Record<PromotedTable, number>;

export interface PromotionResult {
  promotionId: string;
  importId: string;
  /** True when this call actually wrote rows; false when it was a re-run no-op. */
  promoted: boolean;
  counts: PromotionCounts;
  /** Rows dropped because their date fell outside the scope window. */
  clippedRowCount: number;
  computedClose: { program: string; nonProgram: string; total: string } | null;
  sha256: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Typed errors
// ─────────────────────────────────────────────────────────────────────────

export class PromotionParseError extends Error {
  readonly status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = 'PromotionParseError';
  }
}

/** One or more workbook source names did not resolve to a known Source. */
export class PromotionUnresolvedSourceError extends Error {
  readonly status = 422 as const;
  readonly names: string[];
  constructor(names: string[]) {
    super(`unresolved workbook source name(s): ${names.join(', ')}`);
    this.name = 'PromotionUnresolvedSourceError';
    this.names = names;
  }
}

export interface PromotionConflict {
  table: PromotedTable;
  dates: string[];
}

/** A live (non-import) row exists in the scope window — refuse (no silent merge). */
export class PromotionConflictError extends Error {
  readonly status = 409 as const;
  readonly conflicts: PromotionConflict[];
  constructor(conflicts: PromotionConflict[]) {
    super(
      `promotion refused — live rows exist in the scope window: ${conflicts
        .map((c) => `${c.table}[${c.dates.join(',')}]`)
        .join('; ')}`,
    );
    this.name = 'PromotionConflictError';
    this.conflicts = conflicts;
  }
}

/** The import was already promoted, but the staged content has since changed. */
export class PromotionShaMismatchError extends Error {
  readonly status = 409 as const;
  constructor(
    readonly importId: string,
    readonly priorSha: string,
    readonly currentSha: string,
  ) {
    super(
      `import ${importId} was already promoted under a different staged content SHA (tampered staging?)`,
    );
    this.name = 'PromotionShaMismatchError';
  }
}

/** The D2 close-balance assertion failed — commit refused. */
export class PromotionBalanceAssertionError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly expected: number,
    readonly computed: string,
  ) {
    super(`promotion refused — recomputed close balance ${computed} != expected ${expected}`);
    this.name = 'PromotionBalanceAssertionError';
  }
}

/**
 * The inbound rows a promotion would insert do NOT sum to the workbook's own
 * authoritative Processed-ledger inbound. Promoting the raw DAY per-shipment grid
 * as-is (which can over-sum — e.g. June DAY23 Recology Healdsburg's 85-unit
 * non-program row, netted out of the billing close by the workbook's F=I38−L39
 * accounting; see the `[inbound-reconciliation]` flag) while the close is computed
 * from the ledger would leave the live query-backed on-hand floor ABOVE the billed
 * close — the "two competing totals" divergence `running-balance.ts` exists to kill.
 * Refused rather than committed (422): the office reconciles the grid, then re-promotes.
 */
export class PromotionInboundReconciliationError extends Error {
  readonly status = 422 as const;
  constructor(
    readonly expected: { program: string; nonProgram: string },
    readonly promoted: { program: string; nonProgram: string },
  ) {
    super(
      `promotion refused — promoted inbound (program ${promoted.program} / non-program ` +
        `${promoted.nonProgram}) does not reconcile to the workbook's authoritative Processed ` +
        `ledger inbound (program ${expected.program} / non-program ${expected.nonProgram}). ` +
        `The raw DAY per-shipment grid over-sums the billing inbound; see the ` +
        `[inbound-reconciliation] flag. Committing it would push the live on-hand floor above ` +
        `the billed close.`,
    );
    this.name = 'PromotionInboundReconciliationError';
  }
}

export class PromotionImportNotFoundError extends Error {
  readonly status = 404 as const;
  constructor(importId: string) {
    super(`workbook import ${importId} not found`);
    this.name = 'PromotionImportNotFoundError';
  }
}

export class PromotionScopeMismatchError extends Error {
  readonly status = 422 as const;
  constructor(message: string) {
    super(message);
    this.name = 'PromotionScopeMismatchError';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Staging decode (strict — never guesses)
// ─────────────────────────────────────────────────────────────────────────

export const PROMOTION_SECTIONS = [
  'opening_inventory',
  'daily_close',
  'inbound',
  'outbound',
  'landfilled',
  'dropoff',
] as const;
export type PromotionSection = (typeof PROMOTION_SECTIONS)[number];

const OUTBOUND_COMMODITIES = new Set<OutboundCommodity>([
  'trash',
  'toppers',
  'foam',
  'metal',
  'wood',
  'cardboard',
  'plastic',
  'shoddy',
  'cotton',
]);
const OUTBOUND_SUBCATEGORIES = new Set<OutboundSubCategory>(['renovation', 'baled', 'shredded']);
const DROPOFF_KINDS = new Set<ConsumerDropoffKind>(['incentive', 'unpaid', 'illegal']);
const LANDFILLED_REASONS = new Set<LandfilledReason>([
  'bed_bug',
  'soiled',
  'water_logged',
  'other',
]);
const LOAD_SOURCE_TYPES = new Set<LoadSourceType>(['b2b_haul', 'cip_consumer', 'event']);

/** A staging row as read from `workbook_import_rows` (the subset the promotion reads). */
export interface StagingRowInput {
  section: string | null;
  raw_value: string | null;
  numeric_value: Prisma.Decimal | number | null;
  site_name_raw: string | null;
  provenance: unknown;
}

export interface OpeningInventoryCandidate {
  date: string;
  unitsIndoor: number | null;
  unitsTotal: number | null;
  unitsInProcessing: number;
}
export interface DailyCloseCandidate {
  date: string;
  strippedProgram: number;
  strippedNonProgram: number;
  savedUnits: number | null;
  materialTicketNumber: string | null;
  employeesCount: number | null;
  processorsCount: number | null;
  pocketcoilEstimate: number | null;
  notes: string | null;
}
export interface InboundCandidate {
  date: string;
  sourceNameRaw: string;
  /**
   * ADR-0037 amendment (rollup §12) — the resolved `sources.id` the raw name
   * matched (canonical name or `source_aliases`, case/whitespace-insensitive),
   * written to the promoted `inbound_loads.source_id`. Null only when the test
   * double resolver carries no id.
   */
  sourceId: string | null;
  slipNumber: string | null;
  units: number;
  programUnits: number;
  nonProgramUnits: number;
  retracId: string | null;
  loadSourceType: LoadSourceType;
  bolNumber: string | null;
}
export interface OutboundCandidate {
  date: string;
  commodity: OutboundCommodity;
  subCategory: OutboundSubCategory;
  weightLbs: number;
  wholeUnits: number | null;
  programUnits: number | null;
  nonProgramUnits: number | null;
  ticketNumber: string | null;
  retracId: string | null;
  baleCount: number | null;
  buyer: string | null;
}
export interface LandfilledCandidate {
  date: string;
  units: number;
  programUnits: number;
  nonProgramUnits: number;
  reason: LandfilledReason;
  slipNumber: string | null;
}
export interface DropoffCandidate {
  date: string;
  kind: ConsumerDropoffKind;
  personName: string;
  units: number;
  slipNumber: string | null;
  incentiveCents: number | null;
  checkNumber: string | null;
  retracId: string | null;
}

export interface PromotionCandidates {
  opening: OpeningInventoryCandidate | null;
  dailyCloses: DailyCloseCandidate[];
  inbound: InboundCandidate[];
  outbound: OutboundCandidate[];
  landfilled: LandfilledCandidate[];
  dropoffs: DropoffCandidate[];
  /**
   * ADR-0037 amendment (rollup §2.3) — the workbook's OWN authoritative pool-level
   * inventory ledger (Processed sheet F/G/D/E/H/I + opening + saved). When present, the
   * close (D2 assertion) is computed from it via §2.3 CORRECT arithmetic — reconciling to
   * the workbook's billing totals EXACTLY (June F40 19451 / G40 229 → 3977). When absent
   * (legacy/synthetic imports without a Processed sheet), the close falls back to the
   * per-record flow recompute. NOT a promotable table — pure close metadata.
   */
  inventoryLedger: InventoryClosePools | null;
  clippedRowCount: number;
}

type Payload = Record<string, unknown>;

function provLabel(prov: unknown): string {
  if (prov && typeof prov === 'object') {
    const p = prov as { tab?: unknown; row?: unknown; col?: unknown };
    return `${String(p.tab ?? '?')}!${String(p.col ?? '?')}${String(p.row ?? '?')}`;
  }
  return '<no-provenance>';
}

function decodePayload(raw: string | null, where: string): Payload {
  if (raw === null || raw.trim() === '')
    throw new PromotionParseError(`empty staging payload at ${where}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PromotionParseError(`staging payload at ${where} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PromotionParseError(`staging payload at ${where} must be a JSON object`);
  }
  return parsed as Payload;
}

function reqDay(p: Payload, key: string, where: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !ISO_DAY.test(v)) {
    throw new PromotionParseError(
      `${where}: field "${key}" must be a YYYY-MM-DD date (got ${String(v)})`,
    );
  }
  return v;
}
function reqNum(p: Payload, key: string, where: string): number {
  const v = p[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new PromotionParseError(
      `${where}: field "${key}" must be a finite number (got ${String(v)})`,
    );
  }
  return v;
}
function optNum(p: Payload, key: string, where: string): number | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new PromotionParseError(
      `${where}: field "${key}" must be a finite number when present (got ${String(v)})`,
    );
  }
  return v;
}
function optInt(p: Payload, key: string, where: string): number | null {
  const v = optNum(p, key, where);
  if (v === null) return null;
  if (!Number.isInteger(v))
    throw new PromotionParseError(`${where}: field "${key}" must be a whole number`);
  return v;
}
function reqInt(p: Payload, key: string, where: string): number {
  const v = reqNum(p, key, where);
  if (!Number.isInteger(v))
    throw new PromotionParseError(`${where}: field "${key}" must be a whole number`);
  return v;
}
function optStr(p: Payload, key: string): string | null {
  const v = p[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return String(v);
  const t = v.trim();
  return t === '' ? null : t;
}
function reqStr(p: Payload, key: string, where: string): string {
  const v = optStr(p, key);
  if (v === null) throw new PromotionParseError(`${where}: field "${key}" is required`);
  return v;
}

/**
 * Resolve an inbound row's program/non-program split (payload wins; else source
 * pool). `resolved` is null when the source name did not resolve — the caller
 * has already recorded it as unresolved and will refuse the promotion; the
 * placeholder zeros are never used.
 */
function resolveInboundSplit(
  p: Payload,
  units: number,
  where: string,
  resolved: { isNonProgram: boolean } | null,
): { programUnits: number; nonProgramUnits: number } {
  const program = optInt(p, 'programUnits', where);
  const nonProgram = optInt(p, 'nonProgramUnits', where);
  if (program !== null || nonProgram !== null) {
    const pr = program ?? 0;
    const np = nonProgram ?? 0;
    if (pr + np !== units) {
      throw new PromotionParseError(
        `${where}: programUnits(${pr}) + nonProgramUnits(${np}) must equal units(${units})`,
      );
    }
    if (pr < 0 || np < 0) throw new PromotionParseError(`${where}: unit split cannot be negative`);
    return { programUnits: pr, nonProgramUnits: np };
  }
  if (!resolved) return { programUnits: 0, nonProgramUnits: 0 }; // placeholder; caller throws before use
  return resolved.isNonProgram
    ? { programUnits: 0, nonProgramUnits: units }
    : { programUnits: units, nonProgramUnits: 0 };
}

/**
 * Decode + scope-clip the staging rows into typed operational candidates. Rows
 * whose date falls outside [scope.from, scope.to] are clipped (dropped + counted).
 * Unrecognized shapes throw PromotionParseError; unresolved inbound source names
 * throw PromotionUnresolvedSourceError (all names, once).
 */
export function decodeStagingRows(
  rows: readonly StagingRowInput[],
  scope: PromotionScope,
  resolver: SiteAliasResolver,
): PromotionCandidates {
  const out: PromotionCandidates = {
    opening: null,
    dailyCloses: [],
    inbound: [],
    outbound: [],
    landfilled: [],
    dropoffs: [],
    inventoryLedger: null,
    clippedRowCount: 0,
  };
  const unresolved = new Set<string>();
  const inWindow = (d: string): boolean => d >= scope.from && d <= scope.to;

  for (const row of rows) {
    const section = row.section;
    // ADR-0037 amendment — the authoritative inventory ledger (close metadata, not a
    // promotable table). Decoded into candidates.inventoryLedger; the close reads it.
    if (section === 'inventory_ledger') {
      const where = `inventory_ledger@${provLabel(row.provenance)}`;
      const p = decodePayload(row.raw_value, where);
      if (out.inventoryLedger)
        throw new PromotionParseError(`${where}: more than one inventory_ledger row in the import`);
      out.inventoryLedger = {
        programOpen: reqNum(p, 'programOpen', where),
        nonProgramOpen: reqNum(p, 'nonProgramOpen', where),
        programInbound: reqNum(p, 'programInbound', where),
        nonProgramInbound: reqNum(p, 'nonProgramInbound', where),
        programStripped: reqNum(p, 'programStripped', where),
        nonProgramStripped: reqNum(p, 'nonProgramStripped', where),
        savedUnits: reqNum(p, 'savedUnits', where),
        sold: reqNum(p, 'sold', where),
        landfilled: reqNum(p, 'landfilled', where),
      };
      continue;
    }
    if (section === null || !PROMOTION_SECTIONS.includes(section as PromotionSection)) {
      // Non-promotable staging rows (summary/detail evidence) are ignored, not errors.
      if (section && ['summary', 'detail'].includes(section)) continue;
      if (section === null) continue;
      throw new PromotionParseError(
        `unrecognized promotion section "${section}" at ${provLabel(row.provenance)}`,
      );
    }
    const where = `${section}@${provLabel(row.provenance)}`;
    const p = decodePayload(row.raw_value, where);

    if (section === 'opening_inventory') {
      const date = reqDay(p, 'date', where);
      // The anchor is date-fixed to the window opening; still validated to be at/before `from`.
      if (date > scope.to) {
        out.clippedRowCount++;
        continue;
      }
      if (out.opening)
        throw new PromotionParseError(
          `${where}: more than one opening_inventory row in the import`,
        );
      out.opening = {
        date,
        unitsIndoor: optInt(p, 'unitsIndoor', where),
        unitsTotal: optInt(p, 'unitsTotal', where),
        unitsInProcessing: optInt(p, 'unitsInProcessing', where) ?? 0,
      };
      continue;
    }

    const date = reqDay(p, 'date', where);
    if (!inWindow(date)) {
      out.clippedRowCount++;
      continue;
    }

    switch (section as Exclude<PromotionSection, 'opening_inventory'>) {
      case 'daily_close': {
        out.dailyCloses.push({
          date,
          strippedProgram: reqNum(p, 'strippedProgram', where),
          strippedNonProgram: optNum(p, 'strippedNonProgram', where) ?? 0,
          savedUnits: optNum(p, 'savedUnits', where),
          materialTicketNumber: optStr(p, 'materialTicketNumber'),
          employeesCount: optInt(p, 'employeesCount', where),
          processorsCount: optInt(p, 'processorsCount', where),
          pocketcoilEstimate: optInt(p, 'pocketcoilEstimate', where),
          notes: optStr(p, 'notes'),
        });
        break;
      }
      case 'inbound': {
        const units = reqInt(p, 'units', where);
        const sourceNameRaw = row.site_name_raw?.trim() || reqStr(p, 'sourceNameRaw', where);
        // ADR-0037 amendment (rollup §12) — EVERY inbound name is resolved via the
        // canonical-name + source_aliases resolver (case/whitespace-insensitive),
        // even when the payload carries an explicit program split: the resolution
        // also links the promoted row to its Source (`inbound_loads.source_id`).
        // A resolution landing on another site's source is NOT a match (hard rule
        // #2 site scoping). Unresolved names are collected and refused below —
        // never guessed (PromotionUnresolvedSourceError lists them for the
        // operator to seed an alias and re-run).
        const hit = resolver.resolve(sourceNameRaw);
        const resolved = hit && hit.siteId === scope.siteId ? hit : null;
        if (!resolved) unresolved.add(sourceNameRaw.trim());
        const split = resolveInboundSplit(p, units, where, resolved);
        const lst = optStr(p, 'loadSourceType');
        if (lst !== null && !LOAD_SOURCE_TYPES.has(lst as LoadSourceType)) {
          throw new PromotionParseError(`${where}: invalid loadSourceType "${lst}"`);
        }
        out.inbound.push({
          date,
          sourceNameRaw,
          sourceId: resolved?.sourceId ?? null,
          slipNumber: optStr(p, 'slipNumber'),
          units,
          programUnits: split.programUnits,
          nonProgramUnits: split.nonProgramUnits,
          retracId: optStr(p, 'retracId'),
          loadSourceType: (lst as LoadSourceType) ?? 'b2b_haul',
          bolNumber: optStr(p, 'bolNumber'),
        });
        break;
      }
      case 'outbound': {
        const commodity = reqStr(p, 'commodity', where);
        const subCategory = reqStr(p, 'subCategory', where);
        if (!OUTBOUND_COMMODITIES.has(commodity as OutboundCommodity)) {
          throw new PromotionParseError(`${where}: invalid commodity "${commodity}"`);
        }
        if (!OUTBOUND_SUBCATEGORIES.has(subCategory as OutboundSubCategory)) {
          throw new PromotionParseError(`${where}: invalid sub_category "${subCategory}"`);
        }
        const weightLbs = reqInt(p, 'weightLbs', where);
        const isReno = subCategory === 'renovation';
        let wholeUnits: number | null = null;
        let programUnits: number | null = null;
        let nonProgramUnits: number | null = null;
        if (isReno) {
          wholeUnits = reqInt(p, 'wholeUnits', where);
          programUnits = optInt(p, 'programUnits', where) ?? wholeUnits;
          nonProgramUnits = optInt(p, 'nonProgramUnits', where) ?? 0;
          if (programUnits + nonProgramUnits !== wholeUnits) {
            throw new PromotionParseError(
              `${where}: programUnits + nonProgramUnits must equal wholeUnits(${wholeUnits})`,
            );
          }
        } else if (p['wholeUnits'] !== undefined || p['programUnits'] !== undefined) {
          throw new PromotionParseError(
            `${where}: baled/shredded rows are weight-only (no unit split)`,
          );
        }
        out.outbound.push({
          date,
          commodity: commodity as OutboundCommodity,
          subCategory: subCategory as OutboundSubCategory,
          weightLbs,
          wholeUnits,
          programUnits,
          nonProgramUnits,
          ticketNumber: optStr(p, 'ticketNumber'),
          retracId: optStr(p, 'retracId'),
          baleCount: optInt(p, 'baleCount', where),
          buyer: optStr(p, 'buyer'),
        });
        break;
      }
      case 'landfilled': {
        const units = reqInt(p, 'units', where);
        const reason = reqStr(p, 'reason', where);
        if (!LANDFILLED_REASONS.has(reason as LandfilledReason)) {
          throw new PromotionParseError(`${where}: invalid landfilled reason "${reason}"`);
        }
        const programUnits = optInt(p, 'programUnits', where) ?? units;
        const nonProgramUnits = optInt(p, 'nonProgramUnits', where) ?? 0;
        if (programUnits + nonProgramUnits !== units) {
          throw new PromotionParseError(
            `${where}: programUnits + nonProgramUnits must equal units(${units})`,
          );
        }
        out.landfilled.push({
          date,
          units,
          programUnits,
          nonProgramUnits,
          reason: reason as LandfilledReason,
          slipNumber: optStr(p, 'slipNumber'),
        });
        break;
      }
      case 'dropoff': {
        const kind = reqStr(p, 'kind', where);
        if (!DROPOFF_KINDS.has(kind as ConsumerDropoffKind)) {
          throw new PromotionParseError(`${where}: invalid dropoff kind "${kind}"`);
        }
        out.dropoffs.push({
          date,
          kind: kind as ConsumerDropoffKind,
          personName: reqStr(p, 'personName', where),
          units: reqInt(p, 'units', where),
          slipNumber: optStr(p, 'slipNumber'),
          incentiveCents: kind === 'incentive' ? optInt(p, 'incentiveCents', where) : null,
          checkNumber: optStr(p, 'checkNumber'),
          retracId: optStr(p, 'retracId'),
        });
        break;
      }
    }
  }

  if (unresolved.size > 0) throw new PromotionUnresolvedSourceError([...unresolved].sort());
  return out;
}

function countCandidates(c: PromotionCandidates): PromotionCounts {
  return {
    processed_units_daily: c.dailyCloses.length,
    inbound_loads: c.inbound.length,
    outbound_materials: c.outbound.length,
    landfilled_units: c.landfilled.length,
    consumer_dropoffs: c.dropoffs.length,
    site_inventory_snapshots: c.opening ? 1 : 0,
  };
}

/**
 * Recompute the scope-close on-hand balance from the promoted candidate set (D2).
 *
 * ADR-0037 amendment: when the workbook carried its OWN authoritative inventory ledger
 * (the Processed sheet's pool-level F/G/D/E/H/I + opening + saved), the close is computed
 * from THAT via §2.3 correct arithmetic — the billing-authoritative path that reconciles
 * to the workbook's totals EXACTLY (June → 3977). The raw per-shipment DAY grid over-sums
 * inbound (e.g. by 85 on June DAY23, whose non-program row the workbook nets out), so it
 * is NOT the close basis. When no ledger is present (legacy/synthetic imports), the close
 * falls back to the per-record flow recompute via the shared `computeRunningBalance`,
 * where the candidate set maps 1:1 onto the inserted rows. Anchor pool follows `onHand`'s
 * default (all program).
 */
export function computeCloseFromCandidates(c: PromotionCandidates): RunningBalance {
  if (c.inventoryLedger) {
    const close = computeInventoryClose(c.inventoryLedger);
    return { program: close.program, nonProgram: close.nonProgram, total: close.total };
  }
  const anchorUnits = c.opening
    ? snapshotTotalUnits({
        units_indoor: c.opening.unitsIndoor,
        units_total: c.opening.unitsTotal,
        units_in_processing: c.opening.unitsInProcessing,
      })
    : 0;

  const sum = (arr: readonly { programUnits: number; nonProgramUnits: number }[]) =>
    arr.reduce(
      (a, r) => ({
        program: a.program + r.programUnits,
        nonProgram: a.nonProgram + r.nonProgramUnits,
      }),
      { program: 0, nonProgram: 0 },
    );

  const inbound = sum(c.inbound);
  const stripped = c.dailyCloses.reduce(
    (a, r) => ({
      program: a.program.plus(r.strippedProgram),
      nonProgram: a.nonProgram.plus(r.strippedNonProgram),
    }),
    { program: new D(0), nonProgram: new D(0) },
  );
  const reno = c.outbound
    .filter((o) => o.subCategory === 'renovation')
    .reduce(
      (a, r) => ({
        program: a.program + (r.programUnits ?? 0),
        nonProgram: a.nonProgram + (r.nonProgramUnits ?? 0),
      }),
      { program: 0, nonProgram: 0 },
    );
  const landfilled = sum(c.landfilled);
  const dropoffs = c.dropoffs.reduce((a, r) => a + r.units, 0);
  // ADR-0037 amendment (§A.2) — saved units subtract from the non-program pool.
  const savedUnits = c.dailyCloses.reduce((a, r) => a.plus(r.savedUnits ?? 0), new D(0));

  return computeRunningBalance({
    anchor: { program: anchorUnits, nonProgram: 0 },
    verifiedInbound: { program: inbound.program, nonProgram: inbound.nonProgram },
    dropoffUnits: dropoffs,
    stripped: { program: stripped.program, nonProgram: stripped.nonProgram },
    wholeUnitsSold: { program: reno.program, nonProgram: reno.nonProgram },
    landfilled: { program: landfilled.program, nonProgram: landfilled.nonProgram },
    savedUnits,
  });
}

/**
 * Money-safe reconciliation guard (finding 1). When the workbook carries its OWN
 * authoritative Processed ledger, the inbound rows the promotion inserts into
 * `inbound_loads` MUST sum to the ledger's billing-authoritative inbound. The close
 * (D2 assertion) is computed from the ledger, but `onHand` re-derives the live floor
 * from the inserted rows — so if the promoted grid over-sums inbound (the DAY23
 * netted-out non-program row), the stored close and the live query-backed balance
 * diverge. Refuse the promotion instead of committing that split. No-op without a
 * ledger: the close is then the per-record recompute, which equals the inserted rows
 * by construction, so no divergence is possible.
 */
export function assertPromotedInboundReconciles(c: PromotionCandidates): void {
  if (!c.inventoryLedger) return;
  const grid = c.inbound.reduce(
    (a, i) => ({
      program: a.program.plus(i.programUnits),
      nonProgram: a.nonProgram.plus(i.nonProgramUnits),
    }),
    { program: new D(0), nonProgram: new D(0) },
  );
  const ledProgram = new D(c.inventoryLedger.programInbound);
  const ledNonProgram = new D(c.inventoryLedger.nonProgramInbound);
  if (!grid.program.equals(ledProgram) || !grid.nonProgram.equals(ledNonProgram)) {
    throw new PromotionInboundReconciliationError(
      { program: ledProgram.toString(), nonProgram: ledNonProgram.toString() },
      { program: grid.program.toString(), nonProgram: grid.nonProgram.toString() },
    );
  }
}

/**
 * SHA-256 over the canonical serialization of the staged content promoted — a
 * stable, id-independent digest, so re-hashing the same staging rows reproduces
 * the SHA (ADR-0023 gate). Sorted by (section, provenance, raw_value).
 */
export function stagedContentSha(rows: readonly StagingRowInput[]): string {
  const canonical = rows
    .map((r) => ({
      section: r.section,
      raw: r.raw_value,
      num: r.numeric_value === null ? null : r.numeric_value.toString(),
      site: r.site_name_raw,
      prov: provLabel(r.provenance),
    }))
    .sort((a, b) =>
      `${a.section}|${a.prov}|${a.raw}`.localeCompare(`${b.section}|${b.prov}|${b.raw}`),
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// The promotion
// ─────────────────────────────────────────────────────────────────────────

export interface PromoteArgs {
  db: PrismaClient;
  importId: string;
  scope: PromotionScope;
  promotedByUserId: string;
  resolver: SiteAliasResolver;
  notes?: string | null;
}

/** Minimal transactional client surface the promotion writes through. */
type Tx = Prisma.TransactionClient;

const CONFLICT_TABLES: {
  table: PromotedTable;
  find: (tx: Tx, siteId: string, from: Date, to: Date) => Promise<{ date: Date }[]>;
}[] = [
  {
    table: 'processed_units_daily',
    find: (tx, siteId, from, to) =>
      tx.processedUnitsDaily
        .findMany({
          where: {
            site_id: siteId,
            production_date: { gte: from, lte: to },
            source: { not: 'import' },
          },
          select: { production_date: true },
        })
        .then((r) => r.map((x) => ({ date: x.production_date }))),
  },
  {
    // NB: `inbound_loads.source` is the Source RELATION (where mattresses come
    // from), NOT a RecordSource provenance column. Inbound promotion provenance
    // rides on `import_id` alone — so a live (non-promoted) inbound row is exactly
    // `import_id IS NULL`. This is why ADR-0048 adds the bare `import_id` column.
    table: 'inbound_loads',
    // INSTANT column: bound by the Pacific-day window [midnight(from),
    // midnight(to+1)), not the @db.Date UTC-midnight keys — the old bounds
    // missed live loads captured after 5 PM UTC-offset on the window's last
    // day (a promotion could then double-count that day) and falsely matched
    // late-evening loads from the day before the window.
    find: (tx, siteId, from, to) =>
      tx.inboundLoad
        .findMany({
          // ADR-0090 C — a voided load is not a live row, so it must not be
          // reported as a conflict that blocks a workbook import. The snapshot
          // leg below already does the equivalent via `notVoidedSnapshotWhere`.
          where: notVoidedLoadWhere({
            site_id: siteId,
            arrived_at: {
              gte: pacificMidnightInstantOfDayISO(isoOf(from)),
              lt: pacificMidnightInstantOfDayISO(isoOf(new Date(to.getTime() + 86_400_000))),
            },
            import_id: null,
          }),
          select: { arrived_at: true },
        })
        .then((r) => r.map((x) => ({ date: x.arrived_at as Date }))),
  },
  {
    table: 'outbound_materials',
    find: (tx, siteId, from, to) =>
      tx.outboundMaterial
        .findMany({
          where: { site_id: siteId, ship_date: { gte: from, lte: to }, source: { not: 'import' } },
          select: { ship_date: true },
        })
        .then((r) => r.map((x) => ({ date: x.ship_date }))),
  },
  {
    table: 'landfilled_units',
    find: (tx, siteId, from, to) =>
      tx.landfilledUnit
        .findMany({
          where: {
            site_id: siteId,
            disposal_date: { gte: from, lte: to },
            source: { not: 'import' },
          },
          select: { disposal_date: true },
        })
        .then((r) => r.map((x) => ({ date: x.disposal_date }))),
  },
  {
    table: 'consumer_dropoffs',
    find: (tx, siteId, from, to) =>
      tx.consumerDropoff
        .findMany({
          where: {
            site_id: siteId,
            dropoff_date: { gte: from, lte: to },
            source: { not: 'import' },
          },
          select: { dropoff_date: true },
        })
        .then((r) => r.map((x) => ({ date: x.dropoff_date }))),
  },
  {
    table: 'site_inventory_snapshots',
    // INSTANT column — same Pacific-day bounds as inbound_loads above.
    //
    // ADR-0084 — a VOIDED count must not block a promotion. This scan exists to
    // refuse importing over hand-entered work; a withdrawn count is not work to
    // protect, and leaving it here would wedge the workbook import behind a row
    // the site has already disowned, with the conflict message naming a count
    // nobody can find on any surface.
    //
    // `notVoidedSnapshotWhere` rather than a spread because this clause is BUILT
    // from `from`/`to` arguments — one greppable way to carry the filter either
    // way (see snapshot-void.ts).
    find: (tx, siteId, from, to) =>
      tx.siteInventorySnapshot
        .findMany({
          where: notVoidedSnapshotWhere({
            site_id: siteId,
            snapshot_at: {
              gte: pacificMidnightInstantOfDayISO(isoOf(from)),
              lt: pacificMidnightInstantOfDayISO(isoOf(new Date(to.getTime() + 86_400_000))),
            },
            source: { not: 'import' },
          }),
          select: { snapshot_at: true },
        })
        .then((r) => r.map((x) => ({ date: x.snapshot_at }))),
  },
];

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function detectConflicts(
  tx: Tx,
  siteId: string,
  from: Date,
  to: Date,
): Promise<PromotionConflict[]> {
  const conflicts: PromotionConflict[] = [];
  for (const c of CONFLICT_TABLES) {
    const rows = await c.find(tx, siteId, from, to);
    if (rows.length > 0) {
      conflicts.push({
        table: c.table,
        dates: [...new Set(rows.map((r) => isoOf(r.date)))].sort(),
      });
    }
  }
  return conflicts;
}

export interface PromotionPreview {
  importId: string;
  alreadyPromoted: boolean;
  counts: PromotionCounts;
  clippedRowCount: number;
  conflicts: PromotionConflict[];
  computedClose: { program: string; nonProgram: string; total: string };
  expectedCloseTotal: number | null;
  balanceOk: boolean;
  sha256: string;
}

/**
 * Read-only dry-run of a promotion (D5 preview): decode staged rows, count per
 * table, scan for conflicts, and recompute the close — WITHOUT writing anything.
 * Throws the same parse/unresolved-source errors a real promotion would, so the
 * operator sees them before committing.
 */
export async function previewPromotion(args: PromoteArgs): Promise<PromotionPreview> {
  const { db, importId, scope, resolver } = args;
  const imp = await db.workbookImport.findUnique({
    where: { id: importId },
    select: { id: true, site_id: true },
  });
  if (!imp) throw new PromotionImportNotFoundError(importId);
  if (imp.site_id !== scope.siteId) {
    throw new PromotionScopeMismatchError(
      `import site ${imp.site_id} does not match scope site ${scope.siteId}`,
    );
  }

  const stagingRows = (await db.workbookImportRow.findMany({
    where: { import_id: importId },
    select: {
      section: true,
      raw_value: true,
      numeric_value: true,
      site_name_raw: true,
      provenance: true,
    },
  })) as StagingRowInput[];
  const sha = stagedContentSha(stagingRows);
  const existing = await db.workbookPromotion.findUnique({ where: { import_id: importId } });

  const candidates = decodeStagingRows(stagingRows, scope, resolver);
  const close = computeCloseFromCandidates(candidates);
  const conflicts = await detectConflicts(
    db as unknown as Tx,
    scope.siteId,
    dayKeyUTCFromISO(scope.from),
    dayKeyUTCFromISO(scope.to),
  );
  const balanceOk =
    scope.expectedCloseTotal === undefined || scope.expectedCloseTotal === null
      ? true
      : close.total.equals(new D(scope.expectedCloseTotal));

  return {
    importId,
    alreadyPromoted: existing !== null,
    counts: countCandidates(candidates),
    clippedRowCount: candidates.clippedRowCount,
    conflicts,
    computedClose: {
      program: close.program.toString(),
      nonProgram: close.nonProgram.toString(),
      total: close.total.toString(),
    },
    expectedCloseTotal: scope.expectedCloseTotal ?? null,
    balanceOk,
    sha256: sha,
  };
}

/**
 * Promote a workbook import's staged rows into the operational tables. One
 * transaction, all-or-nothing. See the file header for the full contract.
 */
export async function promoteWorkbookImport(args: PromoteArgs): Promise<PromotionResult> {
  const { db, importId, scope, resolver } = args;
  if (!ISO_DAY.test(scope.from) || !ISO_DAY.test(scope.to)) {
    throw new PromotionScopeMismatchError('scope.from / scope.to must be YYYY-MM-DD');
  }
  if (scope.from > scope.to)
    throw new PromotionScopeMismatchError('scope.from must be <= scope.to');

  const imp = await db.workbookImport.findUnique({
    where: { id: importId },
    select: { id: true, site_id: true },
  });
  if (!imp) throw new PromotionImportNotFoundError(importId);
  if (imp.site_id !== scope.siteId) {
    throw new PromotionScopeMismatchError(
      `import site ${imp.site_id} does not match scope site ${scope.siteId}`,
    );
  }

  const stagingRows = (await db.workbookImportRow.findMany({
    where: { import_id: importId },
    select: {
      section: true,
      raw_value: true,
      numeric_value: true,
      site_name_raw: true,
      provenance: true,
    },
  })) as StagingRowInput[];

  const sha = stagedContentSha(stagingRows);

  // Re-run guard (idempotency): the (import_id) UNIQUE ledger row.
  const existing = await db.workbookPromotion.findUnique({ where: { import_id: importId } });
  if (existing) {
    if (existing.sha256 !== sha)
      throw new PromotionShaMismatchError(importId, existing.sha256, sha);
    const counts = existing.counts as unknown as PromotionCounts;
    return {
      promotionId: existing.id,
      importId,
      promoted: false,
      counts,
      clippedRowCount: 0,
      computedClose:
        existing.computed_close_total !== null
          ? {
              program: existing.computed_close_program?.toString() ?? '0',
              nonProgram: new D(existing.computed_close_total)
                .minus(existing.computed_close_program ?? 0)
                .toString(),
              total: existing.computed_close_total.toString(),
            }
          : null,
      sha256: sha,
    };
  }

  const candidates = decodeStagingRows(stagingRows, scope, resolver);
  const counts = countCandidates(candidates);
  const close = computeCloseFromCandidates(candidates);
  // Finding 1 (money-safe): the inserted inbound rows must reconcile to the ledger the
  // close was computed from, or the live `onHand` floor would diverge from the stored
  // close. Fail fast, before any write — nothing to roll back.
  assertPromotedInboundReconciles(candidates);

  const fromDate = dayKeyUTCFromISO(scope.from);
  const toDate = dayKeyUTCFromISO(scope.to);

  const result = await db.$transaction(async (tx) => {
    // 1. Conflict refusal — no silent merge over any live row in the window.
    const conflicts = await detectConflicts(tx, scope.siteId, fromDate, toDate);
    if (conflicts.length > 0) throw new PromotionConflictError(conflicts);

    // 2. The promotion ledger row (its id stamps every promoted row's import_id).
    const promotion = await tx.workbookPromotion.create({
      data: {
        import_id: importId,
        scope: scope as unknown as Prisma.InputJsonValue,
        sha256: sha,
        promoted_by: args.promotedByUserId,
        counts: counts as unknown as Prisma.InputJsonValue,
        computed_close_program: close.program,
        computed_close_total: close.total,
        notes: args.notes ?? null,
      },
      select: { id: true },
    });
    const pid = promotion.id;

    // 3. Anchor snapshot (D2) — the opening inventory as a physical anchor, dated
    // to just-before the window opening so the window's own flows count forward.
    if (candidates.opening) {
      const anchorAt = new Date(fromDate.getTime() - 1);
      await tx.siteInventorySnapshot.create({
        data: {
          site_id: scope.siteId,
          snapshot_at: anchorAt,
          snapshot_kind: 'physical',
          source: 'import',
          import_id: pid,
          units_indoor: candidates.opening.unitsIndoor,
          units_total: candidates.opening.unitsTotal,
          units_in_processing: candidates.opening.unitsInProcessing,
        },
      });
    }

    // 4. Operational flow rows (source='import', import_id stamped).
    if (candidates.dailyCloses.length > 0) {
      await tx.processedUnitsDaily.createMany({
        data: candidates.dailyCloses.map((d) => ({
          site_id: scope.siteId,
          production_date: dayKeyUTCFromISO(d.date),
          stripped_program: new D(d.strippedProgram),
          stripped_non_program: new D(d.strippedNonProgram),
          saved_units: d.savedUnits === null ? null : new D(d.savedUnits),
          material_ticket_number: d.materialTicketNumber,
          employees_count: d.employeesCount,
          processors_count: d.processorsCount,
          pocketcoil_estimate: d.pocketcoilEstimate,
          notes: d.notes,
          source: 'import' as const,
          import_id: pid,
          closed_at: new Date(),
        })),
      });
    }
    if (candidates.inbound.length > 0) {
      await tx.inboundLoad.createMany({
        data: candidates.inbound.map((i) => ({
          site_id: scope.siteId,
          // ADR-0037 amendment (rollup §12) — link the resolved Source so the
          // MyMRC reconciliation join works on promoted June/July loads too.
          source_id: i.sourceId,
          load_source_type: i.loadSourceType,
          status: 'verified' as const,
          // INSTANT column: Pacific midnight of the workbook day, NOT the
          // @db.Date UTC-midnight key (which is 4/5 PM Pacific the PREVIOUS
          // day — it excluded day-1 loads from their own month's Pacific
          // billing window and priced fuel off the prior ISO week).
          arrived_at: pacificMidnightInstantOfDayISO(i.date),
          bol_number: i.bolNumber,
          slip_number: i.slipNumber,
          total_units: i.units,
          program_unit_count: i.programUnits,
          non_program_unit_count: i.nonProgramUnits,
          retrac_id: i.retracId,
          source: 'import' as const,
          import_id: pid,
        })),
      });
    }
    if (candidates.outbound.length > 0) {
      await tx.outboundMaterial.createMany({
        data: candidates.outbound.map((o) => ({
          site_id: scope.siteId,
          ship_date: dayKeyUTCFromISO(o.date),
          commodity: o.commodity,
          sub_category: o.subCategory,
          weight_lbs: o.weightLbs,
          whole_units: o.wholeUnits,
          program_units: o.programUnits,
          non_program_units: o.nonProgramUnits,
          ticket_number: o.ticketNumber,
          retrac_id: o.retracId,
          bale_count: o.baleCount,
          buyer: o.buyer,
          source: 'import' as const,
          import_id: pid,
        })),
      });
    }
    if (candidates.landfilled.length > 0) {
      await tx.landfilledUnit.createMany({
        data: candidates.landfilled.map((l) => ({
          site_id: scope.siteId,
          disposal_date: dayKeyUTCFromISO(l.date),
          units: l.units,
          program_units: l.programUnits,
          non_program_units: l.nonProgramUnits,
          reason: l.reason,
          slip_number: l.slipNumber,
          source: 'import' as const,
          import_id: pid,
        })),
      });
    }
    if (candidates.dropoffs.length > 0) {
      await tx.consumerDropoff.createMany({
        data: candidates.dropoffs.map((d) => ({
          site_id: scope.siteId,
          dropoff_date: dayKeyUTCFromISO(d.date),
          kind: d.kind,
          person_name: d.personName,
          units: d.units,
          slip_number: d.slipNumber,
          incentive_cents: d.incentiveCents,
          check_number: d.checkNumber,
          retrac_id: d.retracId,
          source: 'import' as const,
          import_id: pid,
        })),
      });
    }

    // 5. ONE audit row per table with counts (append-only; hard rule #6).
    const audited: [PromotedTable, number][] = [
      ['site_inventory_snapshots', counts.site_inventory_snapshots],
      ['processed_units_daily', counts.processed_units_daily],
      ['inbound_loads', counts.inbound_loads],
      ['outbound_materials', counts.outbound_materials],
      ['landfilled_units', counts.landfilled_units],
      ['consumer_dropoffs', counts.consumer_dropoffs],
    ];
    for (const [table, count] of audited) {
      if (count === 0) continue;
      await tx.auditLog.create({
        data: {
          actor_user_id: args.promotedByUserId,
          action: 'insert',
          table_name: table,
          row_id: pid,
          after: {
            promotion_id: pid,
            import_id: importId,
            promoted_rows: count,
            window: { from: scope.from, to: scope.to },
            source: 'import',
          },
        },
      });
    }

    // 6. D2 live assertion — REFUSE COMMIT if the close disagrees with the known
    // figure. Throwing here rolls the whole promotion back.
    if (scope.expectedCloseTotal !== undefined && scope.expectedCloseTotal !== null) {
      if (!close.total.equals(new D(scope.expectedCloseTotal))) {
        throw new PromotionBalanceAssertionError(scope.expectedCloseTotal, close.total.toString());
      }
    }

    return pid;
  });

  return {
    promotionId: result,
    importId,
    promoted: true,
    counts,
    clippedRowCount: candidates.clippedRowCount,
    computedClose: {
      program: close.program.toString(),
      nonProgram: close.nonProgram.toString(),
      total: close.total.toString(),
    },
    sha256: sha,
  };
}
