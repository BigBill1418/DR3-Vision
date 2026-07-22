// ADR-0057 D4 — reconciliation CLASSIFIER (new_record detection).
//
// Pure, side-effect-free, DB-free. This module lives under `src/lib/mymrc` and is
// therefore ALSO compiled standalone by `tsconfig.mymrc.json` (the cron-worker
// bundle) — so it may NOT import `@/…`, `@prisma/client`, or the app singleton.
// It takes plain rows in and returns candidate rows out; the caller (sync worker /
// admin surface) turns each candidate into a `mymrc_reconciliation_queue` row and
// does the cross-run dedup against the existing queue (D4).
//
// Scope (Addendum A §A.2): only `detectProcessedRecordChanges` ships in this wave.
// `detectAccountChanges` is intentionally OMITTED — it needs the accounts mirror,
// which is Phase-0-discovery-pending (ADR-0057 D6); designing it now would be a
// guess. The `field_update` / `disappeared` change_kinds likewise wait on that
// mirror. This classifier emits ONLY `new_record` candidates for the `sources`
// operational target.
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

/**
 * A candidate change the classifier detected. The caller maps this 1:1 onto a
 * `mymrc_reconciliation_queue` insert (mymrc_value is REQUIRED; vision_value is
 * NULL for new_record — there is no matched Vision row yet).
 */
export interface ReconciliationCandidate {
  change_kind: 'new_record';
  mirror_table: 'mymrc_processed_mirror';
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
 * Ordered candidate keys that may carry the source/account name on a mirror
 * payload. The exact Salesforce field is Phase-0-discovery-pending (ADR-0057 D6),
 * so the extractor is defensive: it accepts a flat string value OR the Salesforce
 * `RecordRepresentation` `{ fields: { <Key>: { value } } }` shape. `source_name_at_sync`
 * leads (the name the task/spec references); the `*__c` keys are the plausible
 * portal fields to try next. Retire the extras once discovery pins the real key.
 */
const SOURCE_NAME_KEYS = [
  'source_name_at_sync',
  'Source_Name__c',
  'Account_Name__c',
  'Source__c',
  'Name',
] as const;

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

/**
 * Extract the source name from a mirror payload. Checks the candidate keys at the
 * top level first, then inside a Salesforce `fields` envelope. Returns the VERBATIM
 * name (untrimmed/uncased — normalization happens at match time) or null when no
 * candidate key resolves (an unclassifiable record the caller skips).
 */
export function extractSourceName(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  for (const key of SOURCE_NAME_KEYS) {
    const top = stringAt(root, key);
    if (top !== null) return top;
  }
  const fields = asRecord(root['fields']);
  if (fields) {
    for (const key of SOURCE_NAME_KEYS) {
      const inner = stringAt(fields, key);
      if (inner !== null) return inner;
    }
  }
  return null;
}

/**
 * Normalize a source name: trim, lowercase, collapse internal whitespace.
 *
 * DUPLICATED from `normalizeSourceName` (upsert.ts:360) — the classifier MUST use
 * the byte-identical normalization the alias fallback uses, or a name the upsert
 * would have matched via alias could be mis-flagged as new_record. It is duplicated
 * (not imported) for the same reason upsert.ts duplicates it from
 * `src/lib/audit/workbook/site-alias.ts`: this module compiles standalone under
 * tsconfig.mymrc.json. Keep all three in lock-step.
 */
function normalizeSourceName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Detect `new_record` reconciliation candidates in a batch of processed-mirror
 * rows. For each row: extract the source name, then the two-step match —
 *   1. verbatim against `sources.name`
 *   2. normalized against `source_aliases.alias` + `sources.name`
 * A hit at either step ⇒ known source ⇒ no candidate. A miss at both ⇒ a
 * `new_record` candidate.
 *
 * Within a single pass, candidates are DEDUPED by normalized name (the first
 * carrying mirror row wins) so N mirror rows sharing one unknown name yield ONE
 * queue candidate rather than N. Cross-run dedup (against the existing queue) is
 * the caller's job (D4 classifier dedup pre-check). Pure — no I/O, deterministic.
 */
export function detectProcessedRecordChanges(
  processedMirrorRows: readonly ProcessedMirrorRecord[],
  sources: readonly SourceRow[],
  sourceAliases: readonly SourceAliasRow[],
): ReconciliationCandidate[] {
  const verbatim = new Set<string>(sources.map((s) => s.name));
  // Normalized fallback: aliases first, canonical names overlaid last (a canonical
  // name wins a normalized-key collision — mirrors the upsert build order).
  const normalized = new Set<string>();
  for (const a of sourceAliases) normalized.add(normalizeSourceName(a.alias));
  for (const s of sources) normalized.add(normalizeSourceName(s.name));

  const candidates: ReconciliationCandidate[] = [];
  const seen = new Set<string>();
  for (const row of processedMirrorRows) {
    const name = extractSourceName(row.payload);
    if (name === null) continue; // no name to classify — skip
    if (verbatim.has(name)) continue; // verbatim hit — known source
    const key = normalizeSourceName(name);
    if (normalized.has(key)) continue; // alias/normalized hit — known source
    if (seen.has(key)) continue; // already flagged this unknown name this pass
    seen.add(key);
    candidates.push({
      change_kind: 'new_record',
      mirror_table: 'mymrc_processed_mirror',
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
