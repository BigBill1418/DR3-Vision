// T-113 — EOD ntfy enforcement core (ADR-0019 §2).
//
// DB-free / network-free: `evaluateEod` is pure. We feed it a resolved
// "now" instant plus the active-employee list, the set of employee ids
// that already have a daily entry for today, and the holiday set, and
// assert the { shouldAlert, missingCount, dateLabel } decision.
//
// The Pacific-date resolution is exercised through real instants chosen
// so the UTC clock and the America/Los_Angeles wall clock disagree
// (CLAUDE.md global rule: the box runs UTC, Bill runs Pacific) — this is
// where an off-by-one date would surface.

import { describe, it, expect } from 'vitest';
import {
  evaluateEod,
  pacificDateParts,
  missingFingerprint,
  type ActiveEmployee,
} from './eod-check';

// ── Fixtures ────────────────────────────────────────────────────────
//
// Woodland is CA. Pick instants by their Pacific calendar day:
//   - 2026-09-14 is a Monday (workday).
//   - 2026-09-19 is a Saturday (weekend).
//   - 2026-09-20 is a Sunday (weekend).

// 2026-09-14 17:00 Pacific (PDT, UTC-7) === 2026-09-15 00:00 UTC.
// Deliberately past UTC midnight so a naive UTC read would say the
// 15th — the alert label/fingerprint must still say the 14th.
const MON_5PM_PT = new Date('2026-09-15T00:00:00.000Z');

// 2026-09-19 17:00 Pacific (Saturday) === 2026-09-20T00:00:00Z.
const SAT_5PM_PT = new Date('2026-09-20T00:00:00.000Z');

const EMP_A: ActiveEmployee = { id: 'emp-a', full_name: 'Ana' };
const EMP_B: ActiveEmployee = { id: 'emp-b', full_name: 'Bo' };
const EMP_C: ActiveEmployee = { id: 'emp-c', full_name: 'Cy' };

describe('pacificDateParts', () => {
  it('resolves the Pacific calendar day even when UTC has rolled to the next date', () => {
    const parts = pacificDateParts(MON_5PM_PT);
    expect(parts.iso).toBe('2026-09-14');
    expect(parts.label).toBe('Sep 14, 2026');
    // UTC-midnight key for the Pacific day — matches @db.Date storage.
    expect(parts.dayKeyUTC.toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(parts.isWeekend).toBe(false);
  });

  it('flags Saturday as a weekend', () => {
    expect(pacificDateParts(SAT_5PM_PT).isWeekend).toBe(true);
    expect(pacificDateParts(SAT_5PM_PT).iso).toBe('2026-09-19');
  });
});

describe('evaluateEod', () => {
  it('does not alert when every active employee has an entry today', () => {
    const res = evaluateEod({
      now: MON_5PM_PT,
      activeEmployees: [EMP_A, EMP_B, EMP_C],
      enteredEmployeeIds: new Set(['emp-a', 'emp-b', 'emp-c']),
      holidayIsoDates: new Set(),
    });
    expect(res.shouldAlert).toBe(false);
    expect(res.missingCount).toBe(0);
    expect(res.dateIso).toBe('2026-09-14');
  });

  it('alerts on a workday when some employees are missing entries', () => {
    const res = evaluateEod({
      now: MON_5PM_PT,
      activeEmployees: [EMP_A, EMP_B, EMP_C],
      enteredEmployeeIds: new Set(['emp-a']),
      holidayIsoDates: new Set(),
    });
    expect(res.shouldAlert).toBe(true);
    expect(res.missingCount).toBe(2);
    expect(res.dateLabel).toBe('Sep 14, 2026');
    expect(res.fingerprint).toBe('bonus-entry-missing:woodland:2026-09-14');
  });

  it('does not alert on a weekend even when entries are missing', () => {
    const res = evaluateEod({
      now: SAT_5PM_PT,
      activeEmployees: [EMP_A, EMP_B],
      enteredEmployeeIds: new Set(),
      holidayIsoDates: new Set(),
    });
    expect(res.shouldAlert).toBe(false);
    expect(res.skipReason).toBe('weekend');
  });

  it('does not alert on a site holiday even when entries are missing', () => {
    const res = evaluateEod({
      now: MON_5PM_PT,
      activeEmployees: [EMP_A, EMP_B],
      enteredEmployeeIds: new Set(),
      holidayIsoDates: new Set(['2026-09-14']),
    });
    expect(res.shouldAlert).toBe(false);
    expect(res.skipReason).toBe('holiday');
  });

  it('does not alert when there are no active employees (nothing to miss)', () => {
    const res = evaluateEod({
      now: MON_5PM_PT,
      activeEmployees: [],
      enteredEmployeeIds: new Set(),
      holidayIsoDates: new Set(),
    });
    expect(res.shouldAlert).toBe(false);
    expect(res.missingCount).toBe(0);
    expect(res.skipReason).toBe('no_active_employees');
  });
});

describe('missingFingerprint', () => {
  it('is stable, site-scoped, and date-scoped', () => {
    expect(missingFingerprint('2026-09-14')).toBe('bonus-entry-missing:woodland:2026-09-14');
    // A different day yields a different fingerprint — so a late entry the
    // next morning never collides with (and thus never un-sends) today's.
    expect(missingFingerprint('2026-09-15')).not.toBe(missingFingerprint('2026-09-14'));
  });
});
