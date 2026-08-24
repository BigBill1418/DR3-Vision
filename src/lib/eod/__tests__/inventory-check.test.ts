// ADR-0125 D12 — the workbook's `inventory check (should be zero)`, given a home
// that can actually fire.
//
// The naive port of that cell — `total − (program + non_program)` off the
// running balance — is a DETECTOR THAT CANNOT REPORT A NEGATIVE:
// `computeRunningBalance` defines `total = program.plus(nonProgram)`, so the
// difference is identically zero for every input that exists. The first case
// below asserts that property against the real function, so nobody re-implements
// the check that way believing it does something.
//
// What is checked instead is the ANCHOR: a `measured` physical count carries both
// pools and they are supposed to sum to the counted physical total. That CAN be
// off, on legacy rows, imported anchors, and anything written before
// `reconcilePhysicalCount` validated the split.

import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { computeRunningBalance } from '@/lib/inventory/running-balance';
import { inventoryCheckFromAnchor } from '../day-review';

const D = (n: number) => new Prisma.Decimal(n);
const AT = new Date('2026-08-18T07:00:00.000Z');

describe('why the sheet formula is not portable (D12)', () => {
  it('the running balance CANNOT produce total ≠ program + non-program — the naive check is a tautology', () => {
    // Deliberately lopsided, deliberately negative, deliberately fractional.
    for (const c of [
      { anchor: { program: 100, nonProgram: 50 } },
      { anchor: { program: -300, nonProgram: 900 } },
      { anchor: { program: 0.5, nonProgram: 0 } },
    ]) {
      const b = computeRunningBalance({
        anchor: c.anchor,
        verifiedInbound: { program: 7, nonProgram: 3 },
        dropoffUnits: 2,
        stripped: { program: 4, nonProgram: 1 },
        wholeUnitsSold: { program: 0, nonProgram: 0 },
        landfilled: { program: 0, nonProgram: 0 },
      });
      expect(b.total.minus(b.program).minus(b.nonProgram).toNumber()).toBe(0);
    }
    // So a screen rendering "expected 0" against that difference would be green
    // forever, including on the −2,439 August floor that started this work.
  });
});

describe('inventoryCheckFromAnchor', () => {
  it('reports OK when a measured anchor splits exactly', () => {
    const c = inventoryCheckFromAnchor({
      total: 150,
      programUnits: 100,
      nonProgramUnits: 50,
      snapshotAt: AT,
      poolAttribution: 'measured',
    });
    expect(c.state).toBe('ok');
    expect(c.delta).toBe(0);
    expect(c.anchorDayISO).toBe('2026-08-18');
  });

  it('reports OFF, with the delta, when a measured anchor does NOT split exactly', () => {
    // The whole reason the check exists. A green light that could never go red
    // would be worse than no light.
    const c = inventoryCheckFromAnchor({
      total: 150,
      programUnits: 100,
      nonProgramUnits: 40,
      snapshotAt: AT,
      poolAttribution: 'measured',
    });
    expect(c.state).toBe('off');
    expect(c.delta).toBe(10);
    expect(c.physicalTotal).toBe(150);
  });

  it('reports NOT APPLICABLE for an unsplit anchor — its pools are an artifact, not a measurement', () => {
    // `resolveAnchorPair` attributes an unsplit count wholly to the program
    // pool, so "the difference is 0" would be true and meaningless.
    const c = inventoryCheckFromAnchor({
      total: 150,
      programUnits: null,
      nonProgramUnits: null,
      snapshotAt: AT,
      poolAttribution: 'legacy',
    });
    expect(c.state).toBe('not_applicable');
    expect(c.reason).toBe('unsplit_anchor');
    expect(c.anchorDayISO).toBe('2026-08-18');
    expect(c.delta).toBeNull();
  });

  it('grades a row carrying pools but NOT marked measured as unsplit — the shared resolver decides', () => {
    // The trap this closes: a check with its own `programUnits != null` predicate
    // would run on this row while the balance treated it as legacy, i.e. the
    // check and the floor would be looking at different anchors.
    const c = inventoryCheckFromAnchor({
      total: 150,
      programUnits: 100,
      nonProgramUnits: 40,
      snapshotAt: AT,
      poolAttribution: null,
    });
    expect(c.state).toBe('not_applicable');
    expect(c.reason).toBe('unsplit_anchor');
  });

  it('reports NOT APPLICABLE with no anchor at all — nothing to check against', () => {
    const c = inventoryCheckFromAnchor(null);
    expect(c.state).toBe('not_applicable');
    expect(c.reason).toBe('no_anchor');
    expect(c.anchorDayISO).toBeNull();
  });

  it('reads the anchor day from the stored instant WITHOUT re-shifting it through Pacific', () => {
    // A count is anchored at Pacific midnight (07:00Z PDT), whose UTC calendar
    // date already IS the count day. Re-shifting pushes it back a day, which is
    // the defect `daysSinceAnchor` documents at length.
    const c = inventoryCheckFromAnchor({
      total: 10,
      programUnits: 10,
      nonProgramUnits: 0,
      snapshotAt: new Date('2026-08-18T07:00:00.000Z'),
      poolAttribution: 'measured',
    });
    expect(c.anchorDayISO).toBe('2026-08-18');
    void D;
  });
});
