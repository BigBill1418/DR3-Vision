// ADR-0104 §D7 / §13 — the rule that keeps Kelsey's TEREX copy off.
//
// `5b298aeb` is a frozen copy of Janette's live TEREX.xlsx on a departed
// account. It is classified honestly as `terex_maintenance_log` and then held
// off by `enabled = false`. That is a ROW, not a constraint, and a future
// session that no longer remembers why will flip it back — so this is the guard
// that survives after everyone has forgotten (P-52).
//
// The first test PROVES THE GUARD CAN FAIL: a fixture with two enabled TEREX
// sources at one site must be reported. A guard that has never failed proves
// nothing.

import { describe, expect, it } from 'vitest';
import {
  describeSingleInstanceViolation,
  findSingleInstanceViolations,
  SINGLE_INSTANCE_KINDS,
  type SingleInstanceSource,
} from '../single-instance';
import { ABSORBABLE_KINDS } from '../absorb';

const WOODLAND = 'de9875a3-a09f-484f-aed1-2891ef544b87';
const EUGENE = 'e76bf5a3-b25f-4b10-888e-1b6656431fbe';

function src(over: Partial<SingleInstanceSource> = {}): SingleInstanceSource {
  return {
    id: 'src-1',
    doc_class: 'terex_maintenance_log',
    site_id: WOODLAND,
    enabled: true,
    ...over,
  };
}

describe('at most one enabled source per single-instance class per site', () => {
  it('FAILS on two enabled terex_maintenance_log sources at one site', () => {
    // This is the live shape: Janette's document and Kelsey's copy, both
    // classified correctly, both at DR3 Woodland.
    const violations = findSingleInstanceViolations([
      src({ id: '8a0246e7', display_name: 'TEREX.xlsx' }),
      src({ id: '5b298aeb', display_name: 'TEREX.xlsx' }),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.docClass).toBe('terex_maintenance_log');
    expect(violations[0]?.sourceIds).toEqual(['5b298aeb', '8a0246e7']);
    // The message must name the fix, not merely the fault.
    expect(describeSingleInstanceViolation(violations[0]!)).toContain('Disable all but the live one');
  });

  it('PASSES once the copy is disabled — which is exactly how it is held', () => {
    const violations = findSingleInstanceViolations([
      src({ id: '8a0246e7' }),
      src({ id: '5b298aeb', enabled: false }),
    ]);
    // The pair of tests together is the point: the rule is sensitive to the one
    // field that holds the copy off, so if somebody re-enables `5b298aeb` this
    // suite goes red rather than the maintenance total silently doubling.
    expect(violations).toEqual([]);
  });

  it('permits the same class at two DIFFERENT sites', () => {
    expect(
      findSingleInstanceViolations([
        src({ id: 'a', site_id: WOODLAND }),
        src({ id: 'b', site_id: EUGENE }),
      ]),
    ).toEqual([]);
  });

  it('treats a NULL site as its own group — two unscoped copies still collide', () => {
    const violations = findSingleInstanceViolations([
      src({ id: 'a', site_id: null }),
      src({ id: 'b', site_id: null }),
    ]);
    // An unclassified-site source cannot absorb (hard rule #2 refuses it), but
    // two of them are still two copies of one document waiting to be scoped, and
    // scoping them both would be the same defect one step later.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.siteId).toBeNull();
  });

  it('says nothing about classes that are not single-instance', () => {
    expect(
      findSingleInstanceViolations([
        src({ id: 'a', doc_class: 'daily_log_workbook' }),
        src({ id: 'b', doc_class: 'daily_log_workbook' }),
        src({ id: 'c', doc_class: null }),
        src({ id: 'd', doc_class: null }),
      ]),
    ).toEqual([]);
  });

  it('catches the two ADR-0104 classes as well as the three that predate it', () => {
    for (const kind of [
      'trailer_list',
      'terex_maintenance_log',
      'commodity_audit_tracker',
      'outbound_weight_audit',
      'facility_expense_log',
    ]) {
      const violations = findSingleInstanceViolations([
        src({ id: 'a', doc_class: kind }),
        src({ id: 'b', doc_class: kind }),
      ]);
      expect(violations, `${kind} must be single-instance`).toHaveLength(1);
    }
  });
});

describe('the single-instance list is a deliberate subset of the absorbable set', () => {
  it('names only absorbable classes', () => {
    // A single-instance rule about a class nothing absorbs would be inert — the
    // absorption pass never looks at it, so the duplicate could never cost
    // anything and the guard would be theatre.
    for (const kind of SINGLE_INSTANCE_KINDS) {
      expect(ABSORBABLE_KINDS.has(kind), `${kind} must be absorbable`).toBe(true);
    }
  });

  it('deliberately EXCLUDES daily_log_workbook, and says why', () => {
    // That class names a PERIODIC document — one workbook per month per site —
    // so several enabled sources are the normal, correct state. Including it
    // would make this suite fail on healthy data, which is how a guard gets
    // deleted rather than fixed.
    expect(ABSORBABLE_KINDS.has('daily_log_workbook')).toBe(true);
    expect(SINGLE_INSTANCE_KINDS.has('daily_log_workbook')).toBe(false);
  });

  it('covers every absorbable class except the periodic one', () => {
    // A new absorbable class must be decided ONE way or the other. This
    // assertion is a tripwire: adding a kind to `ABSORBABLE_KINDS` without
    // deciding whether it is single-instance breaks it.
    const undecided = [...ABSORBABLE_KINDS].filter(
      (k) => !SINGLE_INSTANCE_KINDS.has(k) && k !== 'daily_log_workbook',
    );
    expect(undecided).toEqual([]);
  });
});
