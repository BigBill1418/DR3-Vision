// ADR-0037 amendment (rollup §2.3 + §1.1 + §A.2) — the correct-arithmetic close.

import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computeInventoryClose,
  sequentialDepletion,
  depleteSeries,
  type InventoryClosePools,
} from './inventory-close';

const base: InventoryClosePools = {
  programOpen: 0,
  nonProgramOpen: 0,
  programInbound: 0,
  nonProgramInbound: 0,
  programStripped: 0,
  nonProgramStripped: 0,
  savedUnits: 0,
  sold: 0,
  landfilled: 0,
};

describe('computeInventoryClose — §2.3 correct arithmetic', () => {
  it('reconciles the CORRECTED June close to 3977 (3748 program + 229 non-program)', () => {
    // The authoritative June totals from the corrected workbook's Processed SUM row.
    const close = computeInventoryClose({
      ...base,
      programOpen: 1423, // Processed!D5 = DAY1!L2
      nonProgramOpen: 0, // Processed!F5
      programInbound: 19451, // F40
      nonProgramInbound: 229, // G40
      programStripped: 17126, // D40
      nonProgramStripped: 0, // E40
    });
    expect(close.program.toString()).toBe('3748');
    expect(close.nonProgram.toString()).toBe('229');
    expect(close.total.toString()).toBe('3977');
  });

  it('does NOT replicate the workbook D45 bug (adds non-program stripped) when it is non-zero', () => {
    // A month where the program pool ran dry and non-program was stripped. The buggy
    // workbook D45 would ADD nonProgramStripped; §2.3 SUBTRACTS it.
    const close = computeInventoryClose({
      ...base,
      programOpen: 100,
      programInbound: 50,
      programStripped: 150, // program pool exactly exhausted
      nonProgramOpen: 40,
      nonProgramInbound: 10,
      nonProgramStripped: 30, // subtract, not add
    });
    expect(close.program.toString()).toBe('0'); // 100 + 50 − 150
    expect(close.nonProgram.toString()).toBe('20'); // 40 + 10 − 30 − 0
    expect(close.total.toString()).toBe('20');
  });

  it('subtracts saved_units from the non-program pool (§A.2)', () => {
    const close = computeInventoryClose({
      ...base,
      nonProgramOpen: 50,
      nonProgramInbound: 20,
      savedUnits: 15,
    });
    expect(close.nonProgram.toString()).toBe('55'); // 50 + 20 − 15
    expect(close.program.toString()).toBe('0');
  });

  it('subtracts sold + landfilled from the total (§2.3, matches workbook D48 intent)', () => {
    const close = computeInventoryClose({
      ...base,
      programOpen: 1000,
      programInbound: 200,
      programStripped: 100,
      sold: 30,
      landfilled: 20,
    });
    expect(close.program.toString()).toBe('1100'); // pool untouched by sold/landfilled
    expect(close.total.toString()).toBe('1050'); // 1100 + 0 − 30 − 20
  });

  it('uses Decimal — half-unit precision survives (Decimal(7,1))', () => {
    const close = computeInventoryClose({
      ...base,
      programOpen: new Prisma.Decimal('10.5'),
      programInbound: new Prisma.Decimal('0.5'),
      programStripped: new Prisma.Decimal('1.0'),
    });
    expect(close.program.toString()).toBe('10');
  });
});

describe('sequentialDepletion — §1.1 program-first', () => {
  it('draws entirely from program when program covers the day', () => {
    const s = sequentialDepletion(200, 150);
    expect(s.program.toString()).toBe('150');
    expect(s.nonProgram.toString()).toBe('0');
  });

  it('overflows to non-program once the program pool is exhausted', () => {
    const s = sequentialDepletion(120, 175);
    expect(s.program.toString()).toBe('120');
    expect(s.nonProgram.toString()).toBe('55');
  });

  it('is all non-program when the program pool is empty', () => {
    const s = sequentialDepletion(0, 40);
    expect(s.program.toString()).toBe('0');
    expect(s.nonProgram.toString()).toBe('40');
  });

  it('clamps a negative program pool to zero (never negative stripped)', () => {
    const s = sequentialDepletion(-5, 10);
    expect(s.program.toString()).toBe('0');
    expect(s.nonProgram.toString()).toBe('10');
  });

  it('a zero-processing day strips nothing', () => {
    const s = sequentialDepletion(100, 0);
    expect(s.program.toString()).toBe('0');
    expect(s.nonProgram.toString()).toBe('0');
  });
});

describe('depleteSeries — carries the program pool forward', () => {
  it('June-shape: all stripping is program while the pool holds (E40 = 0)', () => {
    // Two days, program inbound keeps the pool ahead of stripping → no non-program drawn.
    const r = depleteSeries(1423, [
      { programInbound: 637, nonProgramInbound: 0, strippedTotal: 944 },
      { programInbound: 1202, nonProgramInbound: 0, strippedTotal: 695 },
    ]);
    expect(r.totalProgramStripped.toString()).toBe('1639'); // 944 + 695
    expect(r.totalNonProgramStripped.toString()).toBe('0');
  });

  it('overflows to non-program on a day the program pool cannot cover', () => {
    const r = depleteSeries(10, [{ programInbound: 0, nonProgramInbound: 50, strippedTotal: 40 }]);
    expect(r.perDay[0]!.program.toString()).toBe('10');
    expect(r.perDay[0]!.nonProgram.toString()).toBe('30');
    expect(r.totalNonProgramStripped.toString()).toBe('30');
  });
});
