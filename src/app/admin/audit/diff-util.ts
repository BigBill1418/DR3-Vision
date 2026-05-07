// T-014 — pure JSON-diff helpers, lifted out of `AuditDiff.tsx` so
// the unit test can exercise them in a Node environment without
// loading React or 'use client' modules.

export type Json = unknown;
type JsonObject = Record<string, Json>;

export type DiffKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface DiffRow {
  key: string;
  before: Json;
  after: Json;
  kind: DiffKind;
}

export function buildDiff(before: Json, after: Json): DiffRow[] {
  const beforeObj = isPlainObject(before) ? before : null;
  const afterObj = isPlainObject(after) ? after : null;
  if (!beforeObj && !afterObj) return [];

  const keys = new Set<string>();
  if (beforeObj) for (const k of Object.keys(beforeObj)) keys.add(k);
  if (afterObj) for (const k of Object.keys(afterObj)) keys.add(k);

  const rows: DiffRow[] = [];
  for (const k of Array.from(keys).sort()) {
    const hasBefore = beforeObj ? k in beforeObj : false;
    const hasAfter = afterObj ? k in afterObj : false;
    const b = hasBefore ? (beforeObj as JsonObject)[k] : undefined;
    const a = hasAfter ? (afterObj as JsonObject)[k] : undefined;
    let kind: DiffKind;
    if (!hasBefore && hasAfter) kind = 'added';
    else if (hasBefore && !hasAfter) kind = 'removed';
    else if (deepEqual(b, a)) kind = 'unchanged';
    else kind = 'changed';
    rows.push({ key: k, before: b, after: a, kind });
  }
  return rows;
}

export function isPlainObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const arrB = b as unknown[];
    if (a.length !== arrB.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], arrB[i])) return false;
    }
    return true;
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const ka = Object.keys(objA);
  const kb = Object.keys(objB);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(objA[k], objB[k])) return false;
  }
  return true;
}
