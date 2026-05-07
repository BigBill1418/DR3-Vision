// T-014 — unit tests for the audit-log URL parser + builder.
//
// These exercise the contract that both the server page and the
// client filter form rely on: "the URL IS the state". A regression
// here would silently drop or corrupt filter params on share / refresh
// — the failure mode would not show up in any single end-to-end
// scenario but would make link-sharing unreliable.

import { describe, it, expect } from 'vitest';
import {
  parseAuditParams,
  buildAuditQueryString,
  isoDateBounds,
  defaultDateRange,
  utcDateString,
} from './admin-audit-url';

describe('parseAuditParams', () => {
  it('returns all-null defaults for empty input', () => {
    const s = parseAuditParams({});
    expect(s.actor).toBeNull();
    expect(s.table).toBeNull();
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
    expect(s.actions).toEqual([]);
    expect(s.page).toBe(1);
  });

  it('passes through valid actor + table verbatim', () => {
    const s = parseAuditParams({ actor: 'user-1', table: 'users' });
    expect(s.actor).toBe('user-1');
    expect(s.table).toBe('users');
  });

  it('rejects malformed dates and yields null', () => {
    const s = parseAuditParams({ from: 'today', to: '2026/05/06' });
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
  });

  it('accepts well-formed ISO dates', () => {
    const s = parseAuditParams({ from: '2026-05-01', to: '2026-05-06' });
    expect(s.from).toBe('2026-05-01');
    expect(s.to).toBe('2026-05-06');
  });

  it('parses comma-separated action list, dedupes, and drops unknown tokens', () => {
    const s = parseAuditParams({ action: 'insert,update,delete,delete,bogus' });
    expect(s.actions).toEqual(['insert', 'update', 'delete']);
  });

  it('returns empty action list when none valid', () => {
    const s = parseAuditParams({ action: 'foo,bar' });
    expect(s.actions).toEqual([]);
  });

  it('clamps non-numeric or below-1 page to 1', () => {
    expect(parseAuditParams({ page: 'NaN' }).page).toBe(1);
    expect(parseAuditParams({ page: '0' }).page).toBe(1);
    expect(parseAuditParams({ page: '-3' }).page).toBe(1);
  });

  it('parses positive integer page', () => {
    expect(parseAuditParams({ page: '7' }).page).toBe(7);
  });
});

describe('buildAuditQueryString', () => {
  it('omits empty / default values entirely', () => {
    expect(buildAuditQueryString({})).toBe('');
    expect(buildAuditQueryString({ actor: null, table: null, page: 1 })).toBe('');
    expect(buildAuditQueryString({ actions: [] })).toBe('');
  });

  it('includes set values', () => {
    const qs = buildAuditQueryString({
      actor: 'u',
      table: 'users',
      from: '2026-05-01',
      to: '2026-05-06',
      actions: ['insert', 'update'],
      page: 3,
    });
    const sp = new URLSearchParams(qs);
    expect(sp.get('actor')).toBe('u');
    expect(sp.get('table')).toBe('users');
    expect(sp.get('from')).toBe('2026-05-01');
    expect(sp.get('to')).toBe('2026-05-06');
    expect(sp.get('action')).toBe('insert,update');
    expect(sp.get('page')).toBe('3');
  });

  it('does not emit page=1', () => {
    const qs = buildAuditQueryString({ actor: 'u', page: 1 });
    const sp = new URLSearchParams(qs);
    expect(sp.has('page')).toBe(false);
  });

  it('round-trips through parseAuditParams', () => {
    const start = {
      actor: 'user-42',
      table: 'inbound_loads',
      from: '2026-04-30',
      to: '2026-05-05',
      actions: ['insert' as const, 'soft_delete' as const],
      page: 5,
    };
    const qs = buildAuditQueryString(start);
    const sp = new URLSearchParams(qs);
    const parsed = parseAuditParams({
      actor: sp.get('actor') ?? undefined,
      table: sp.get('table') ?? undefined,
      from: sp.get('from') ?? undefined,
      to: sp.get('to') ?? undefined,
      action: sp.get('action') ?? undefined,
      page: sp.get('page') ?? undefined,
    });
    expect(parsed).toEqual(start);
  });
});

describe('isoDateBounds', () => {
  it('returns nulls when both inputs are null', () => {
    const r = isoDateBounds(null, null);
    expect(r.from).toBeNull();
    expect(r.to).toBeNull();
  });

  it('anchors `from` at UTC midnight of the given day', () => {
    const r = isoDateBounds('2026-05-01', null);
    expect(r.from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(r.to).toBeNull();
  });

  it('shifts `to` by one day so the upper bound is exclusive', () => {
    const r = isoDateBounds(null, '2026-05-06');
    // 2026-05-06 inclusive -> 2026-05-07T00:00:00Z exclusive
    expect(r.to?.toISOString()).toBe('2026-05-07T00:00:00.000Z');
  });

  it('handles both bounds together', () => {
    const r = isoDateBounds('2026-05-01', '2026-05-06');
    expect(r.from?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(r.to?.toISOString()).toBe('2026-05-07T00:00:00.000Z');
  });
});

describe('defaultDateRange', () => {
  it('returns a 7-day window ending today (UTC)', () => {
    const now = new Date('2026-05-06T12:30:00Z');
    const r = defaultDateRange(now);
    expect(r.to).toBe('2026-05-06');
    expect(r.from).toBe('2026-04-30'); // 6 days back inclusive (7 days total)
  });
});

describe('utcDateString', () => {
  it('produces YYYY-MM-DD in UTC regardless of local TZ', () => {
    expect(utcDateString(new Date('2026-05-06T23:59:59Z'))).toBe('2026-05-06');
    expect(utcDateString(new Date('2026-05-07T00:00:00Z'))).toBe('2026-05-07');
  });
});
