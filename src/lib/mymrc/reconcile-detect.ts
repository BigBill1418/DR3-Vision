// ADR-0057 D4 — reconciliation CLASSIFIER (new_record detection).
//
// Pure, side-effect-free, DB-free. This module lives under `src/lib/mymrc` and is
// therefore ALSO compiled standalone by `tsconfig.mymrc.json` (the cron-worker
// bundle) — so it may NOT import `@/…`, `@prisma/client`, or the app singleton.
// It takes plain rows in and returns candidate rows out; the caller
// (`reconcile-feed.ts`) turns each candidate into a `mymrc_reconciliation_queue`
// row and does the cross-run dedup against the existing queue (D4).
//
// Scope (Phase 1, ADR-0057 Phase 0 catalog): the source/site discriminators the
// real portal exposes are:
//   - Materials__c.Account__r.Name  (processed + outbound) — `detectProcessedRecordChanges`
//   - Haul_Request__c.Collection_Site__c / Collection_Source__c — `detectHaulRecordChanges`
// Both emit ONLY `new_record` candidates for the `sources` operational target.
// `field_update` / `disappeared` change_kinds still wait on the linked-entity
// design (a later wave); this classifier surfaces UNKNOWN source names only.
//
// new_record rule (ADR-0057 D4): a mirror record whose source name matches NEITHER
// `sources.name` (verbatim) NOR any `source_aliases.alias` (normalized) — the SAME
// two-step fallback the upsert path uses (upsert.ts:188-195). A verbatim OR alias
// hit is a known source ⇒ NO candidate.

/** A raw MyMRC mirror record (e.g. a `mymrc_processed_mirror` row). */
export interface ProcessedMirrorRecord {
  /** The mirror row PK (Salesforce record id) — becomes `mirror_record_id`. */
  id: string;
  /** Full raw Salesforce RecordRepresentation (the mirror's `payload` JSON column). */
  payload: unknown;
}

/** A raw MyMRC hauls-mirror record — same shape, distinct source fields. */
export type HaulMirrorRecord = ProcessedMirrorRecord;

/** A `sources` row (only the fields the match needs). */
export interface SourceRow {
  id: string;
  name: string;
}

/** A `source_aliases` row (only the fields the match needs). */
export interface SourceAliasRow {
  alias: string;
  source_id: string;
}

/** Which mirror table a candidate originated from (drives apply.ts site scoping). */
export type MirrorTable = 'mymrc_processed_mirror' | 'mymrc_hauls_mirror';

/**
 * A candidate change the classifier detected. The caller maps this 1:1 onto a
 * `mymrc_reconciliation_queue` insert (mymrc_value is REQUIRED; vision_value is
 * NULL for new_record — there is no matched Vision row yet).
 */
export interface ReconciliationCandidate {
  change_kind: 'new_record';
  mirror_table: MirrorTable;
  mirror_record_id: string;
  target_table: 'sources';
  target_record_id: null;
  field_name: 'name';
  /** The verbatim MyMRC source name that missed both verbatim + alias. */
  mymrc_value: string;
  /** Normalized form — a ready-to-use alias/name suggestion for the operator. */
  suggested_alias: string;
}

/**
 * Ordered FLAT candidate keys that may carry the source name on a processed
 * mirror payload. The REAL discriminator (Materials__c.Account__r.Name, a
 * relationship) is checked FIRST in {@link extractSourceName}; these remain as
 * harmless flat fallbacks. NOTE: the bare `Name` key is intentionally ABSENT —
 * on the real Materials__c object `Name` is the Materials number (M-####), NOT a
 * source; including it would mis-flag every processed row as a new source.
 */
const SOURCE_NAME_KEYS = [
  'source_name_at_sync',
  'Source_Name__c',
  'Account_Name__c',
  'Source__c',
] as const;

/**
 * Ordered source-carrying fields on a Haul_Request__c payload (ADR-0057 Phase 0):
 * the collection site is `Collection_Site__c`, with `Collection_Source__c` as the
 * fallback origin descriptor. First non-empty wins (one candidate per haul).
 */
const HAUL_SOURCE_KEYS = ['Collection_Site__c', 'Collection_Source__c'] as const;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/** Pull a non-empty string at `obj[key]`, or the SF `obj[key].value`, else null. */
function stringAt(obj: Record<string, unknown>, key: string): string | null {
  const direct = obj[key];
  if (typeof direct === 'string' && direct.trim()) return direct;
  const nested = asRecord(direct);
  if (nested) {
    const val = nested['value'];
    if (typeof val === 'string' && val.trim()) return val;
  }
  return null;
}

/** Locate a field object by key at the payload root OR inside its `fields` envelope. */
function fieldObj(root: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const top = asRecord(root[key]);
  if (top) return top;
  const fields = asRecord(root['fields']);
  return fields ? asRecord(fields[key]) : null;
}

/**
 * Read the related `Name` from a Salesforce `__r` relationship field. The nested
 * record lives under `value.fields.Name.value`; the relationship field's own
 * `displayValue` is the related Name too (used as a fallback). Mirrors
 * `mappers.relatedName`. Returns null when the relationship is absent/blank — a
 * missing link never throws.
 */
function relationshipName(root: Record<string, unknown>, relKey: string): string | null {
  const rel = fieldObj(root, relKey);
  if (!rel) return null;
  const nested = asRecord(rel['value']);
  if (nested) {
    const nestedFields = asRecord(nested['fields']);
    if (nestedFields) {
      const nameField = asRecord(nestedFields['Name']);
      const v = nameField ? nameField['value'] : null;
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  const dv = rel['displayValue'];
  if (typeof dv === 'string' && dv.trim()) return dv;
  return null;
}

/** Try each key at the top level first, then inside the `fields` envelope. */
function firstStringKey(
  root: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const top = stringAt(root, key);
    if (top !== null) return top;
  }
  const fields = asRecord(root['fields']);
  if (fields) {
    for (const key of keys) {
      const inner = stringAt(fields, key);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Extract the source name from a PROCESSED (Materials__c) mirror payload. Checks
 * the REAL relationship discriminator `Account__r.Name` first, then the flat
 * fallback keys. Returns the VERBATIM name (untrimmed/uncased — normalization
 * happens at match time) or null when nothing resolves (an unclassifiable record
 * the caller skips).
 */
export function extractSourceName(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const rel = relationshipName(root, 'Account__r');
  if (rel !== null) return rel;
  return firstStringKey(root, SOURCE_NAME_KEYS);
}

/**
 * Extract the source name from a HAUL (Haul_Request__c) mirror payload:
 * `Collection_Site__c`, then `Collection_Source__c`. Verbatim or null.
 */
export function extractHaulSourceName(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  return firstStringKey(root, HAUL_SOURCE_KEYS);
}

/**
 * Normalize a source name: trim, lowercase, collapse internal whitespace.
 *
 * DUPLICATED from `normalizeSourceName` (upsert.ts:360) — the classifier MUST use
 * the byte-identical normalization the alias fallback uses, or a name the upsert
 * would have matched via alias could be mis-flagged as new_record. It is duplicated
 * (not imported) for the same reason upsert.ts duplicates it from
 * `src/lib/audit/workbook/site-alias.ts`: this module compiles standalone under
 * tsconfig.mymrc.json. Keep all three in lock-step. Exported so the feed's
 * cross-run dedup normalizes existing-queue values with the same function.
 */
export function normalizeSourceName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Precomputed verbatim + normalized match sets for a source/alias snapshot. */
interface MatchSets {
  verbatim: Set<string>;
  normalized: Set<string>;
}

function buildMatchSets(
  sources: readonly SourceRow[],
  sourceAliases: readonly SourceAliasRow[],
): MatchSets {
  const verbatim = new Set<string>(sources.map((s) => s.name));
  // Normalized fallback: aliases first, canonical names overlaid last (a canonical
  // name wins a normalized-key collision — mirrors the upsert build order).
  const normalized = new Set<string>();
  for (const a of sourceAliases) normalized.add(normalizeSourceName(a.alias));
  for (const s of sources) normalized.add(normalizeSourceName(s.name));
  return { verbatim, normalized };
}

/**
 * Core classify pass shared by the processed + hauls detectors. For each row:
 * extract the source name via `extract`, then the two-step match (verbatim, then
 * normalized alias/name). A hit at either step ⇒ known source ⇒ no candidate.
 * Within the pass, dedupe by normalized name (first carrying row wins). Pure.
 */
function classifyRows(
  rows: readonly ProcessedMirrorRecord[],
  extract: (payload: unknown) => string | null,
  mirrorTable: MirrorTable,
  { verbatim, normalized }: MatchSets,
): ReconciliationCandidate[] {
  const candidates: ReconciliationCandidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = extract(row.payload);
    if (name === null) continue; // no name to classify — skip
    if (verbatim.has(name)) continue; // verbatim hit — known source
    const key = normalizeSourceName(name);
    if (normalized.has(key)) continue; // alias/normalized hit — known source
    if (seen.has(key)) continue; // already flagged this unknown name this pass
    seen.add(key);
    candidates.push({
      change_kind: 'new_record',
      mirror_table: mirrorTable,
      mirror_record_id: row.id,
      target_table: 'sources',
      target_record_id: null,
      field_name: 'name',
      mymrc_value: name,
      suggested_alias: key,
    });
  }
  return candidates;
}

/**
 * Detect `new_record` candidates in a batch of PROCESSED-mirror rows (source name
 * = Account__r.Name). See {@link classifyRows}. Cross-run dedup (against the
 * existing queue) is the caller's job. Pure — deterministic, no I/O.
 */
export function detectProcessedRecordChanges(
  processedMirrorRows: readonly ProcessedMirrorRecord[],
  sources: readonly SourceRow[],
  sourceAliases: readonly SourceAliasRow[],
): ReconciliationCandidate[] {
  return classifyRows(
    processedMirrorRows,
    extractSourceName,
    'mymrc_processed_mirror',
    buildMatchSets(sources, sourceAliases),
  );
}

/**
 * Detect `new_record` candidates in a batch of HAUL-mirror rows (source name =
 * Collection_Site__c / Collection_Source__c). Surfaces collection sites unknown
 * to `sources` for the operator to approve. Same match + within-pass dedup as the
 * processed detector. Pure.
 */
export function detectHaulRecordChanges(
  haulMirrorRows: readonly HaulMirrorRecord[],
  sources: readonly SourceRow[],
  sourceAliases: readonly SourceAliasRow[],
): ReconciliationCandidate[] {
  return classifyRows(
    haulMirrorRows,
    extractHaulSourceName,
    'mymrc_hauls_mirror',
    buildMatchSets(sources, sourceAliases),
  );
}
