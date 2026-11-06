// ADR-0072 Amendment 1 — the two flags on the manager's held-count screen.

import { describe, expect, it } from 'vitest';
import { isLargeSwing, sameCountPending } from './held-count-review';

describe('isLargeSwing', () => {
  it('flags a swing at or over twice the site threshold', () => {
    expect(isLargeSwing(52, 20)).toBe(true);
    expect(isLargeSwing(40, 20)).toBe(true);
  });

  it('does not flag a hold that is only just over the threshold', () => {
    expect(isLargeSwing(23, 20)).toBe(false);
    expect(isLargeSwing(39.99, 20)).toBe(false);
  });
});

describe('sameCountPending', () => {
  // 2026-11-06 18:00Z and 23:00Z are both Nov 6 Pacific; 2026-11-07 07:30Z is
  // still Nov 6 Pacific (23:30 PST) — the day boundary is Pacific, not UTC.
  const h = (id: string, iso: string, newTotal: number) => ({
    id,
    createdAt: new Date(iso),
    newTotal,
  });

  it('groups holds with the same total on the same Pacific day', () => {
    const out = sameCountPending([
      h('a', '2026-11-06T18:00:00Z', 1200),
      h('b', '2026-11-06T23:00:00Z', 1200),
      h('c', '2026-11-07T07:30:00Z', 1200),
      h('d', '2026-11-06T18:05:00Z', 1350),
    ]);
    expect(out.get('a')).toBe(3);
    expect(out.get('b')).toBe(3);
    expect(out.get('c')).toBe(3);
    expect(out.get('d')).toBe(1);
  });

  it('does not group the same total across Pacific days', () => {
    const out = sameCountPending([
      h('a', '2026-11-06T18:00:00Z', 1200),
      h('b', '2026-11-07T18:00:00Z', 1200),
    ]);
    expect(out.get('a')).toBe(1);
    expect(out.get('b')).toBe(1);
  });

  it('returns an empty map for no holds', () => {
    expect(sameCountPending([]).size).toBe(0);
  });
});
