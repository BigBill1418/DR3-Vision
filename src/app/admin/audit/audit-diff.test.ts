// T-014 — unit tests for the JSON-diff helpers used by the audit
// log viewer. These exercise the pure logic only — the React render
// is covered by the API-integration test suite + manual QA.

import { describe, it, expect } from 'vitest';
import { buildDiff, deepEqual } from './diff-util';

describe('buildDiff', () => {
  it('returns empty for two non-objects', () => {
    expect(buildDiff(null, null)).toEqual([]);
    expect(buildDiff('a', 'b')).toEqual([]);
    expect(buildDiff(42, true)).toEqual([]);
  });

  it('marks every key as added when before is null (insert)', () => {
    const after = { id: 'u1', name: 'X' };
    const rows = buildDiff(null, after);
    expect(rows.map((r) => `${r.key}:${r.kind}`).sort()).toEqual([
      'id:added',
      'name:added',
    ]);
  });

  it('marks every key as removed when after is null (delete)', () => {
    const before = { id: 'u1', name: 'X' };
    const rows = buildDiff(before, null);
    expect(rows.map((r) => `${r.key}:${r.kind}`).sort()).toEqual([
      'id:removed',
      'name:removed',
    ]);
  });

  it('classifies changed/unchanged scalars', () => {
    const before = { id: 'u1', name: 'X', is_active: true };
    const after = { id: 'u1', name: 'Y', is_active: true };
    const rows = buildDiff(before, after);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.kind]));
    expect(map['id']).toBe('unchanged');
    expect(map['name']).toBe('changed');
    expect(map['is_active']).toBe('unchanged');
  });

  it('treats deep-equal nested values as unchanged', () => {
    const before = { roles: ['admin', 'manager'] };
    const after = { roles: ['admin', 'manager'] };
    const rows = buildDiff(before, after);
    expect(rows[0]?.kind).toBe('unchanged');
  });

  it('treats arrays of different shape as changed', () => {
    const before = { roles: ['admin'] };
    const after = { roles: ['admin', 'manager'] };
    const rows = buildDiff(before, after);
    expect(rows[0]?.kind).toBe('changed');
  });

  it('sorts the result by key for stable rendering', () => {
    const rows = buildDiff({ z: 1, a: 1 }, { z: 2, a: 2 });
    expect(rows.map((r) => r.key)).toEqual(['a', 'z']);
  });

  it('handles a key being added on one side', () => {
    const rows = buildDiff({ a: 1 }, { a: 1, b: 2 });
    const map = Object.fromEntries(rows.map((r) => [r.key, r.kind]));
    expect(map['a']).toBe('unchanged');
    expect(map['b']).toBe('added');
  });
});

describe('deepEqual', () => {
  it('handles primitives', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, 0)).toBe(false);
    expect(deepEqual(undefined, undefined)).toBe(true);
  });

  it('handles arrays', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it('handles nested objects', () => {
    const a = { x: { y: { z: 1 } } };
    const b = { x: { y: { z: 1 } } };
    const c = { x: { y: { z: 2 } } };
    expect(deepEqual(a, b)).toBe(true);
    expect(deepEqual(a, c)).toBe(false);
  });

  it('handles mismatched key count', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it('does not treat array vs object as equal', () => {
    expect(deepEqual([], {})).toBe(false);
  });
});
