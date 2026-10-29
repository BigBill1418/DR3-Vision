// ADR-0143 D6 — program available to process, shown at the daily close.
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { programAvailableFromRow } from './split-rule';
import type { PositionRow } from './pool-guard';

const D = Prisma.Decimal;
const row = (o: Partial<Record<keyof PositionRow, unknown>>): PositionRow =>
  ({
    day: '2026-09-17',
    pool: 'program',
    opening: new D(138),
    inbound: new D(769),
    dropoffs: new D(14),
    stripped: new D(0),
    sold: new D(0),
    landfilled: new D(0),
    adjustments: new D(0),
    closing: new D(0),
    ...o,
  }) as PositionRow;

describe('programAvailableFromRow', () => {
  it('Woodland 09-17: 138 opening + 769 received + 14 drop-offs = 921 available (1,172 was recorded)', () => {
    expect(programAvailableFromRow(row({}))).toEqual({
      day: '2026-09-17',
      units: 921,
      none: false,
    });
  });

  it('a pool already below zero has none available; the figure is never negative', () => {
    expect(
      programAvailableFromRow(
        row({ opening: new D(-247), inbound: new D(100), dropoffs: new D(0) }),
      ),
    ).toEqual({
      day: '2026-09-17',
      units: 0,
      none: true,
    });
  });

  it('an approved adjustment that day counts toward what is available', () => {
    expect(
      programAvailableFromRow(
        row({
          opening: new D(-247),
          inbound: new D(0),
          dropoffs: new D(0),
          adjustments: new D(247),
        }),
      ).units,
    ).toBe(0);
    expect(
      programAvailableFromRow(
        row({ opening: new D(0), inbound: new D(10), dropoffs: new D(0), adjustments: new D(5) }),
      ).units,
    ).toBe(15);
  });
});
