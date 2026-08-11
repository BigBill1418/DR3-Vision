import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NOT_VOIDED_LOAD, notVoidedLoadWhere } from './not-voided';

// ADR-0090 C — a voided load must not be counted as production anywhere.
//
// Adding `voided` to `LoadStatus` is free for readers that filter through a
// status ALLOW-list; a new member is excluded by construction, which is why the
// void is an enum member rather than a nullable column. It is NOT free for the
// readers that filter on `site_id` + a date window and take whatever falls in.
//
// The behavioural half of this file pins the helper. The STRUCTURAL half pins
// the call sites — because the defect here is not a wrong return value, it is a
// query that never asked the question. A unit test of the helper alone would
// have passed just as happily with zero callers.

describe('notVoidedLoadWhere', () => {
  it('excludes voided loads by status, not by a second source of truth', () => {
    // Deliberately `status: { not: 'voided' }` and never `voided_at: null`. The
    // status is what every other reader on this model keys on, and one question
    // answered two ways across a codebase is how the two answers diverge.
    expect(NOT_VOIDED_LOAD).toEqual({ status: { not: 'voided' } });
  });

  it('preserves the caller’s own predicates', () => {
    expect(notVoidedLoadWhere({ site_id: 'site-woodland', import_id: null })).toEqual({
      site_id: 'site-woodland',
      import_id: null,
      status: { not: 'voided' },
    });
  });

  it('does not mutate the where it is given', () => {
    const where = { site_id: 'site-woodland' };
    notVoidedLoadWhere(where);
    expect(where).toEqual({ site_id: 'site-woodland' });
  });
});

// The status-blind readers a floor-voided `b2b_haul` load can actually reach.
// Each was audited on 2026-08-10 (all 23 `inboundLoad` query sites); these are
// the ones where a voided row would have changed a number a human acts on.
const MUST_ASK: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: 'src/lib/compliance.ts',
    why: 'metrics 1/3/7 — a truck that never came would degrade a CONTRACTUAL compliance grade forever',
  },
  {
    file: 'src/lib/dashboard/ops-overview.ts',
    why: 'loadsArrivedToday — a mis-tap would inflate "trucks that came today"',
  },
  {
    file: 'src/lib/audit/workbook-promotion.ts',
    why: 'live-row conflict scan — a voided load would wedge a workbook import against a conflict that is not one',
  },
  {
    file: 'src/app/api/reconciliation/[site]/upload/route.ts',
    why: 'a voided load offered as the DR3-side match for an external haul row, carrying stale units and weight into a filing',
  },
];

describe('every status-blind reader asks (ADR-0090 C)', () => {
  it.each(MUST_ASK)('$file — $why', ({ file }) => {
    expect(readFileSync(file, 'utf8')).toContain('notVoidedLoadWhere');
  });

  it('compliance.ts asks in all THREE of its status-blind metrics', () => {
    // One import plus three call sites. Metrics 1, 3 and 7 are separate queries
    // and patching two of three would leave a permanently-degrading grade.
    const src = readFileSync('src/lib/compliance.ts', 'utf8');
    expect(src.split('notVoidedLoadWhere(').length - 1).toBe(3);
  });

  it('ops-overview.ts asks in BOTH of its arrival counts', () => {
    // The same count is issued from two separate Promise.all blocks; they were
    // byte-identical, which is exactly how one of them gets missed.
    const src = readFileSync('src/lib/dashboard/ops-overview.ts', 'utf8');
    expect(src.split('notVoidedLoadWhere(').length - 1).toBe(2);
  });
});
