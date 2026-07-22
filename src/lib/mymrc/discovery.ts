// ADR-0057 §D2/D6 — Phase 0 MyMRC object-discovery parse layer.
//
// Pure transformation: Aura envelopes (intercepted `/s/sfsites/aura` bodies) →
// a structured enumeration of every Salesforce object Bill's admin account can
// see, plus a redacted-fixture bundle per object. NO Playwright, NO DB, NO env
// reads — the thin runner (`scripts/mymrc-discovery.mjs`) does the browser I/O
// and hands raw response bodies to these functions. This mirrors the ADR-0038
// split (transport in `portal-client.ts`, pure parse in `mappers.ts`) so the
// enumeration logic is unit-tested against captured fixtures without live
// portal access.
//
// Self-contained by design (same convention as `ntfy.ts` / `upsert.ts`): this
// module re-implements the Aura action + record walking rather than importing
// `portal-client.ts`, so the two feed families evolve independently and the
// concurrent D1 transport rework cannot break discovery parsing. It depends
// only on the stable `SfField` / `SfRecord` shapes from `./types`.
//
// Discovery is EXPLORATORY, not the guarded sync path: where the transport
// throws `PortalContractDriftError` on a missing action (a green run with no
// data is impossible by construction), discovery instead records "nothing
// found" so a partial probe still yields a useful catalog. The loud-failure
// posture lives in the runner's auth guard (ADR-0057 D5), not here.

import type { SfField, SfRecord } from './types';

// ── Aura action layer ────────────────────────────────────────────────────────

/**
 * One action from an intercepted Aura envelope. Unlike the transport's parser
 * (which needs only `state`/`returnValue`), discovery also reads `descriptor`
 * (to classify the action) and `params` (the authoritative `entityName` /
 * `objectApiName` for list-view enumeration).
 */
export interface DiscoveryAuraAction {
  id?: string;
  descriptor?: string;
  params?: Record<string, unknown>;
  state?: string;
  returnValue?: unknown;
}

/** Parse an intercepted Aura response body into its actions (tolerant of junk). */
export function parseAuraActions(body: string): DiscoveryAuraAction[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const actions = (parsed as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((a): a is DiscoveryAuraAction => !!a && typeof a === 'object');
}

const GET_ITEMS_RE = /ListViewDataManagerController\/ACTION\$getItems/i;
const GET_RECORD_RE = /RecordUiController\/ACTION\$getRecordWithFields/i;

interface GetItemsReturn {
  recordIdActionsList?: unknown;
  columnWidthMapping?: unknown;
  fields?: unknown;
  offset?: unknown;
  hasMoreData?: unknown;
  isErrorListView?: unknown;
  filterTitle?: unknown;
  listViewApiName?: unknown;
}

function hasRecordIdActionsList(v: unknown): v is GetItemsReturn {
  return !!v && typeof v === 'object' && 'recordIdActionsList' in v;
}

/**
 * True when the action is a ListView `getItems` — identified by its descriptor
 * OR (descriptor-less captures) by a `recordIdActionsList` in the returnValue.
 */
export function isGetItemsAction(action: DiscoveryAuraAction): boolean {
  if (action.descriptor && GET_ITEMS_RE.test(action.descriptor)) return true;
  return hasRecordIdActionsList(action.returnValue);
}

/** True when the action is a `getRecordWithFields` record fetch. */
export function isGetRecordAction(action: DiscoveryAuraAction): boolean {
  if (action.descriptor && GET_RECORD_RE.test(action.descriptor)) return true;
  return looksLikeRecord(action.returnValue);
}

// ── Count estimate ───────────────────────────────────────────────────────────

export interface CountEstimate {
  /** Record ids present on the intercepted page. */
  listed: number;
  /** `hasMoreData` — the list is windowed, so `listed` is a floor, not a total. */
  windowed: boolean;
  /** The list-view page offset, if the payload reported one. */
  pageOffset: number | null;
  /** `true` ⇒ `listed` is the EXACT total (a non-windowed page). */
  known: boolean;
}

/** Derive the count estimate from a `getItems` returnValue. */
export function estimateCount(rv: unknown): CountEstimate {
  const ids = listRecordIds(rv);
  const windowed = !!rv && typeof rv === 'object' && (rv as GetItemsReturn).hasMoreData === true;
  const rawOffset = rv && typeof rv === 'object' ? (rv as GetItemsReturn).offset : undefined;
  const pageOffset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) ? rawOffset : null;
  return { listed: ids.length, windowed, pageOffset, known: !windowed };
}

/** Ordered Salesforce record ids from a `getItems` returnValue (ignores blanks). */
export function listRecordIds(rv: unknown): string[] {
  if (!rv || typeof rv !== 'object') return [];
  const list = (rv as GetItemsReturn).recordIdActionsList;
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = entry && typeof entry === 'object' ? (entry as { recordId?: unknown }).recordId : null;
    if (typeof id === 'string' && id.trim() !== '') ids.push(id);
  }
  return ids;
}

// ── Object enumeration ───────────────────────────────────────────────────────

/** One accessible list view discovered on Bill's account. */
export interface DiscoveredListView {
  /** From `params.entityName` — `null` when the descriptor-less capture omits it. */
  objectApiName: string | null;
  /** First 3 chars of the first record id (the Salesforce key prefix), if any. */
  keyPrefix: string | null;
  listViewApiName: string | null;
  filterTitle: string | null;
  /** Displayed column API names (`columnWidthMapping` keys). */
  columns: string[];
  /** Full field set the list view queried (`returnValue.fields`). */
  queriedFields: string[];
  recordIds: string[];
  count: CountEstimate;
  isErrorListView: boolean;
}

function stringParam(params: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!params) return null;
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function keyPrefixOf(ids: readonly string[]): string | null {
  const first = ids[0];
  return first && first.length >= 3 ? first.slice(0, 3) : null;
}

/**
 * Extract every ListView `getItems` action across intercepted bodies as a flat
 * list of discovered list views (one entry per SUCCESS getItems action).
 */
export function extractListViews(bodies: readonly string[]): DiscoveredListView[] {
  const views: DiscoveredListView[] = [];
  for (const body of bodies) {
    for (const action of parseAuraActions(body)) {
      if (action.state !== 'SUCCESS' || !isGetItemsAction(action)) continue;
      const rv = (action.returnValue ?? {}) as GetItemsReturn;
      const recordIds = listRecordIds(rv);
      const columns =
        rv.columnWidthMapping && typeof rv.columnWidthMapping === 'object'
          ? Object.keys(rv.columnWidthMapping as Record<string, unknown>)
          : [];
      views.push({
        objectApiName: stringParam(action.params, 'entityName', 'objectApiName', 'sobjectType'),
        keyPrefix: keyPrefixOf(recordIds),
        listViewApiName:
          stringParam(action.params, 'listViewApiName', 'listViewName') ??
          (typeof rv.listViewApiName === 'string' ? rv.listViewApiName : null),
        filterTitle: typeof rv.filterTitle === 'string' ? rv.filterTitle : null,
        columns,
        queriedFields: stringList(rv.fields),
        recordIds,
        count: estimateCount(rv),
        isErrorListView: rv.isErrorListView === true,
      });
    }
  }
  return views;
}

/** A Salesforce object, merged across all of its discovered list views. */
export interface DiscoveredObject {
  /** Best-known object API name (see {@link enumerateObjects} for resolution). */
  objectApiName: string | null;
  keyPrefix: string | null;
  /** Human labels of the list views seen for this object (filterTitle/apiName). */
  listViews: string[];
  /** Union of displayed column API names across the object's list views. */
  columns: string[];
  /** Union of record ids seen across the object's list views. */
  recordIds: string[];
  /** Merged count: union size; `windowed` if ANY list view was windowed. */
  count: CountEstimate;
}

function mergeCount(a: CountEstimate, listed: number, windowed: boolean): CountEstimate {
  const merged = a.windowed || windowed;
  return { listed, windowed: merged, pageOffset: null, known: !merged };
}

/**
 * Enumerate accessible objects from intercepted bodies, merging multiple list
 * views of the same object into one entry.
 *
 * Object identity is keyed by `objectApiName` when present (from
 * `params.entityName`); otherwise by `prefix:<keyPrefix>` so a descriptor-less
 * capture still yields a distinct object. `records` (from the detail pass) are
 * an optional cross-link source: any object still missing an API name inherits
 * it from a fetched record sharing its key prefix.
 */
export function enumerateObjects(
  bodies: readonly string[],
  records: readonly SfRecord[] = [],
): DiscoveredObject[] {
  const prefixToApiName = new Map<string, string>();
  for (const rec of records) {
    const prefix = rec.id.length >= 3 ? rec.id.slice(0, 3) : null;
    if (prefix && !prefixToApiName.has(prefix)) prefixToApiName.set(prefix, rec.apiName);
  }

  const byKey = new Map<string, DiscoveredObject>();
  const order: string[] = [];
  for (const view of extractListViews(bodies)) {
    const apiName =
      view.objectApiName ?? (view.keyPrefix ? (prefixToApiName.get(view.keyPrefix) ?? null) : null);
    const key = apiName ?? (view.keyPrefix ? `prefix:${view.keyPrefix}` : 'unknown');
    const label = view.filterTitle ?? view.listViewApiName ?? '(unnamed list view)';

    const existing = byKey.get(key);
    if (!existing) {
      order.push(key);
      byKey.set(key, {
        objectApiName: apiName,
        keyPrefix: view.keyPrefix,
        listViews: [label],
        columns: [...view.columns],
        recordIds: [...view.recordIds],
        count: view.count,
      });
      continue;
    }
    existing.objectApiName ??= apiName;
    existing.keyPrefix ??= view.keyPrefix;
    if (!existing.listViews.includes(label)) existing.listViews.push(label);
    for (const c of view.columns) if (!existing.columns.includes(c)) existing.columns.push(c);
    for (const id of view.recordIds) if (!existing.recordIds.includes(id)) existing.recordIds.push(id);
    existing.count = mergeCount(existing.count, existing.recordIds.length, view.count.windowed);
  }
  return order.map((k) => byKey.get(k) as DiscoveredObject);
}

// ── Record walking (detail pass) ─────────────────────────────────────────────

function looksLikeRecord(o: unknown): o is SfRecord {
  if (!o || typeof o !== 'object') return false;
  const r = o as { apiName?: unknown; id?: unknown; fields?: unknown };
  return typeof r.apiName === 'string' && typeof r.id === 'string' && !!r.fields && typeof r.fields === 'object';
}

/**
 * Collect EVERY distinct RecordRepresentation across intercepted bodies
 * (deduped by id, keeping the richest field set per id). Used both to capture
 * one detail per object and to cross-link object API names by key prefix.
 */
export function extractAllRecords(bodies: readonly string[]): SfRecord[] {
  const best = new Map<string, SfRecord>();
  const consider = (rec: SfRecord): void => {
    const prior = best.get(rec.id);
    if (!prior || Object.keys(rec.fields).length > Object.keys(prior.fields).length) best.set(rec.id, rec);
  };
  const walk = (o: unknown, depth: number): void => {
    if (!o || typeof o !== 'object' || depth > 14) return;
    if (looksLikeRecord(o)) consider(o);
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
      return;
    }
    for (const v of Object.values(o as Record<string, unknown>)) walk(v, depth + 1);
  };
  for (const body of bodies) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    walk(parsed, 0);
  }
  return [...best.values()];
}

/** The richest RecordRepresentation for `recordId`, or `null` if not present. */
export function extractRecordFields(bodies: readonly string[], recordId: string): SfRecord | null {
  for (const rec of extractAllRecords(bodies)) {
    if (rec.id === recordId) return rec;
  }
  return null;
}

// ── Redaction (person / contact PII) ─────────────────────────────────────────

const REDACTED = '[redacted]';
const PERSON_OBJECTS = new Set(['user', 'contact', 'lead', 'name']);
const PII_SEGMENTS = new Set([
  'firstname',
  'lastname',
  'middlename',
  'email',
  'phone',
  'mobilephone',
  'homephone',
  'otherphone',
  'fax',
]);
// Relationship prefixes whose `.Name` resolves to a person (flat dotted keys).
const PERSON_RELATIONSHIP_RE = /(^|\.)(createdby|lastmodifiedby|owner|manager|user|contact)\./i;

function lastSegment(fieldName: string): string {
  const i = fieldName.lastIndexOf('.');
  return (i >= 0 ? fieldName.slice(i + 1) : fieldName).toLowerCase();
}

function isRecordLike(v: unknown): v is SfRecord & Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as { apiName?: unknown; fields?: unknown };
  return typeof r.apiName === 'string' && !!r.fields && typeof r.fields === 'object';
}

function redactFieldMap(
  fields: Record<string, SfField>,
  ownerApiName: string,
): Record<string, SfField> {
  const out: Record<string, SfField> = {};
  for (const [name, field] of Object.entries(fields)) {
    out[name] = redactField(name, field, ownerApiName);
  }
  return out;
}

function redactField(name: string, field: SfField, ownerApiName: string): SfField {
  const value = field.value;

  // Nested record (relationship): recurse, and redact THIS field's displayValue
  // when the nested record is a person object (its displayValue is the name).
  if (isRecordLike(value)) {
    const nestedApiName = value.apiName;
    const nestedRedacted = {
      ...value,
      fields: redactFieldMap(value.fields, nestedApiName),
    } as unknown;
    const personDisplay = PERSON_OBJECTS.has(nestedApiName.toLowerCase());
    return {
      displayValue: personDisplay ? (field.displayValue == null ? null : REDACTED) : field.displayValue,
      value: nestedRedacted,
    };
  }

  const seg = lastSegment(name);
  const isPii =
    PII_SEGMENTS.has(seg) ||
    (seg === 'name' && (PERSON_OBJECTS.has(ownerApiName.toLowerCase()) || PERSON_RELATIONSHIP_RE.test(name)));
  if (isPii) {
    return { displayValue: field.displayValue == null ? null : REDACTED, value: REDACTED };
  }
  return { displayValue: field.displayValue, value: field.value };
}

/**
 * Redact person/contact PII from a record before it is committed as a fixture.
 * Removes name/email/phone values on person objects (User/Contact/Lead) and any
 * nested person relationship (CreatedBy/LastModifiedBy/Owner/Manager). Business
 * fields — object identifiers (H-####/M-####), site & vendor names, dates,
 * weights, unit counts — are RETAINED, exactly per the ADR-0038 fixture policy,
 * so the redacted record still drives meaningful mapper regression tests. Pure:
 * returns a new record; the input is not mutated.
 */
export function redactRecord(rec: SfRecord): SfRecord {
  return {
    ...rec,
    fields: redactFieldMap(rec.fields, rec.apiName),
  };
}

// ── sObjects REST probe ──────────────────────────────────────────────────────

export interface SobjectsProbe {
  reachable: boolean;
  status: number;
  sobjectCount: number | null;
  sampleObjectNames: string[];
  note: string;
}

/**
 * Classify the `/services/data/vNN/sobjects/` metadata probe. Captured even on
 * denial: Experience Cloud portal users are typically blocked from the REST
 * metadata API (401/403), which is itself a useful, expected finding.
 */
export function summarizeSobjectsProbe(status: number, body: string): SobjectsProbe {
  if (status === 200) {
    let names: string[] = [];
    try {
      const parsed = JSON.parse(body) as { sobjects?: Array<{ name?: unknown }> };
      if (Array.isArray(parsed.sobjects)) {
        names = parsed.sobjects
          .map((s) => (s && typeof s.name === 'string' ? s.name : null))
          .filter((n): n is string => n !== null);
      }
    } catch {
      return {
        reachable: true,
        status,
        sobjectCount: null,
        sampleObjectNames: [],
        note: 'HTTP 200 but body was not parseable sObjects JSON',
      };
    }
    return {
      reachable: true,
      status,
      sobjectCount: names.length,
      sampleObjectNames: names.slice(0, 25),
      note: `metadata API reachable — ${names.length} sObjects enumerated`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      reachable: false,
      status,
      sobjectCount: null,
      sampleObjectNames: [],
      note: 'metadata API not permitted for this session (expected for Experience Cloud portal users)',
    };
  }
  return {
    reachable: false,
    status,
    sobjectCount: null,
    sampleObjectNames: [],
    note: `metadata API probe returned HTTP ${status}`,
  };
}

// ── Report + markdown ────────────────────────────────────────────────────────

export interface DiscoveredObjectReport {
  objectApiName: string;
  keyPrefix: string | null;
  listViews: string[];
  columns: string[];
  count: CountEstimate;
  sampleRecordId: string | null;
  /** Full field set (sorted API names) from the one captured detail record. */
  fieldNames: string[];
}

export interface DiscoveryReport {
  capturedAt: string;
  portalOrigin: string;
  accountLabel: string;
  objects: DiscoveredObjectReport[];
  sobjectsProbe: SobjectsProbe;
}

function countText(c: CountEstimate): string {
  if (c.known) return `${c.listed} (exact)`;
  return `≥ ${c.listed} (windowed — page not complete)`;
}

/**
 * Render the Phase 0 discovery report as the operator-facing markdown deliverable
 * (`docs/mymrc-discovery-<date>.md`, ADR-0057 D6): a summary catalog table, a
 * per-object section (list views, columns, count, captured field set), and the
 * sObjects metadata-probe result. Pure — the runner writes the returned string.
 */
export function renderDiscoveryMarkdown(report: DiscoveryReport): string {
  const lines: string[] = [];
  lines.push(`# MyMRC discovery — ${report.capturedAt}`);
  lines.push('');
  lines.push('_ADR-0057 Phase 0 (D6). Inaugural enumeration of every Salesforce object visible to');
  lines.push(`the DR3 admin account. Portal: \`${report.portalOrigin}\` · account: \`${report.accountLabel}\`._`);
  lines.push('');
  lines.push(`**Objects discovered:** ${report.objects.length}`);
  lines.push('');

  lines.push('## Catalog');
  lines.push('');
  lines.push('| Object | List views | Columns | Record count | Fields captured |');
  lines.push('|---|---|---:|---|---:|');
  for (const o of report.objects) {
    lines.push(
      `| \`${o.objectApiName}\` | ${o.listViews.length} | ${o.columns.length} | ${countText(o.count)} | ${o.fieldNames.length} |`,
    );
  }
  lines.push('');

  for (const o of report.objects) {
    lines.push(`## \`${o.objectApiName}\``);
    lines.push('');
    if (o.keyPrefix) lines.push(`- **Key prefix:** \`${o.keyPrefix}\``);
    lines.push(`- **List views:** ${o.listViews.map((v) => `"${v}"`).join(', ') || '(none)'}`);
    lines.push(`- **Record count:** ${countText(o.count)}`);
    lines.push(`- **Sample record id:** ${o.sampleRecordId ? `\`${o.sampleRecordId}\`` : '(no detail captured)'}`);
    lines.push(`- **List columns (${o.columns.length}):** ${o.columns.map((c) => `\`${c}\``).join(', ') || '(none)'}`);
    lines.push(`- **Detail field set (${o.fieldNames.length}):** ${o.fieldNames.map((f) => `\`${f}\``).join(', ') || '(none)'}`);
    lines.push('');
  }

  lines.push('## sObjects metadata probe (`/services/data/vNN/sobjects/`)');
  lines.push('');
  const p = report.sobjectsProbe;
  lines.push(`- **Status:** HTTP ${p.status} — ${p.reachable ? 'reachable' : 'not reachable'}`);
  lines.push(`- **Note:** ${p.note}`);
  if (p.sobjectCount !== null) lines.push(`- **sObjects enumerated:** ${p.sobjectCount}`);
  if (p.sampleObjectNames.length > 0) {
    lines.push(`- **Sample:** ${p.sampleObjectNames.map((n) => `\`${n}\``).join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── Per-object fixture bundle ────────────────────────────────────────────────

export interface ObjectFixtureBundle {
  objectApiName: string;
  /** `{ list-getItems-response.json }` — the getItems action, wrapped as an envelope. */
  listResponse: unknown;
  /** `{ record-getRecordWithFields-response.json }` — the REDACTED record, as an envelope. */
  recordResponse: unknown;
  /** `{ discovery-metadata.json }` — the object's report row + capture stamp. */
  metadata: DiscoveredObjectReport & { capturedAt: string; redacted: true };
}

/**
 * Assemble the three committed fixture artifacts for one object (ADR-0057
 * per-object `__fixtures__/<objectApiName>/` bundle). The record is redacted
 * here; the list returnValue carries only ids + column metadata (no PII) and is
 * wrapped verbatim. Pure — the runner serializes + writes these.
 */
export function buildObjectFixture(input: {
  report: DiscoveredObjectReport;
  listReturnValue: unknown;
  record: SfRecord | null;
  capturedAt: string;
}): ObjectFixtureBundle {
  const redacted = input.record ? redactRecord(input.record) : null;
  return {
    objectApiName: input.report.objectApiName,
    listResponse: { actions: [{ state: 'SUCCESS', returnValue: input.listReturnValue }] },
    recordResponse: { actions: [{ state: 'SUCCESS', returnValue: redacted }] },
    metadata: { ...input.report, capturedAt: input.capturedAt, redacted: true },
  };
}
