// ADR-0055 — recycling-rate derivation + resolver tests.
//
// Split in two: the PURE pound-split math needs no DB; the resolver / combined
// derivation / overlap guard drive the REAL code against an in-memory `@/lib/prisma`
// mock (same idiom as the program-rules resolver test).
//
// WORKED-EXAMPLE NOTE (flagged to the operator): Kelsey's verbal Xtraction example
// stated "5,541 lb → 1,054 lb trash + 4,487 lb steel". Those two numbers sum to
// 5,541 but do NOT correspond to the confirmed 0.81 rate at ANY rounding: 0.81 ×
// 5,541 = 4,488.21, so the config rate yields 4,488 recycled / 1,053 landfilled.
// The 4,487/1,054 pair is an 80.98% split — a hand-rounded/real-ticket figure, not
// the nominal 0.81 computation. The system uses the CONFIG rate; these tests assert
// the mathematically correct 4,488/1,053 and document the 1-lb delta so it is never
// silently "fixed" by fudging the rate. Seeded rate stays 0.81 (confirmed).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── In-memory prisma mock (resolver + overlap tests) ──────────────────────────
interface MockRate {
  id: string;
  vendor_id: string;
  commodity: string;
  recycling_percent: unknown; // Prisma.Decimal at runtime
  effective_from: Date;
  effective_to: Date | null;
}
const rates: MockRate[] = [];

/** The (subset of) Prisma `where` shapes `resolveRecyclingRate` + the overlap guard issue. */
interface RateWhere {
  vendor_id?: string;
  commodity?: string;
  id?: { not?: string };
  effective_from?: { lte?: Date; gte?: Date };
  OR?: Array<{ effective_to: null | { gte?: Date; lte?: Date } }>;
}

/** Evaluate the (subset of) Prisma `where` shapes these functions issue. */
function matchRate(row: MockRate, where: RateWhere): boolean {
  if (where.vendor_id !== undefined && row.vendor_id !== where.vendor_id) return false;
  if (where.commodity !== undefined && row.commodity !== where.commodity) return false;
  const idCond = where.id;
  if (idCond?.not !== undefined && row.id === idCond.not) return false;
  const ef = where.effective_from;
  if (ef?.lte && row.effective_from.getTime() > ef.lte.getTime()) return false;
  if (ef?.gte && row.effective_from.getTime() < ef.gte.getTime()) return false;
  const or = where.OR;
  if (or) {
    const anyMatch = or.some((clause) => {
      if (clause.effective_to === null) return row.effective_to === null;
      if (clause.effective_to?.gte)
        return row.effective_to !== null && row.effective_to.getTime() >= clause.effective_to.gte.getTime();
      if (clause.effective_to?.lte)
        return row.effective_to !== null && row.effective_to.getTime() <= clause.effective_to.lte.getTime();
      return false;
    });
    if (!anyMatch) return false;
  }
  return true;
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    recyclingRate: {
      findMany: async ({
        where,
        orderBy,
      }: {
        where: RateWhere;
        orderBy?: { effective_from: 'desc' | 'asc' };
      }) => {
        const out = rates.filter((r) => matchRate(r, where));
        if (orderBy?.effective_from) {
          out.sort((a, b) =>
            orderBy.effective_from === 'desc'
              ? b.effective_from.getTime() - a.effective_from.getTime()
              : a.effective_from.getTime() - b.effective_from.getTime(),
          );
        }
        return out;
      },
    },
    outboundVendor: {
      findMany: async () => [],
    },
  },
}));

import { Prisma } from '@prisma/client';
import {
  deriveRecyclingSplit,
  resolveRecyclingRate,
  deriveOutboundRecycling,
  assertNoRecyclingRateOverlap,
  AmbiguousRecyclingRateError,
  RecyclingRateOverlapError,
} from './recycling-rates';
import { RecordValidationError } from '@/lib/loads/record-guards';

const D = (s: string) => new Prisma.Decimal(s);
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

beforeEach(() => {
  rates.length = 0;
});

// ── Pure split math ───────────────────────────────────────────────────────────
describe('deriveRecyclingSplit — pound split + rounding invariant', () => {
  it('the 5,541 lb Xtraction example at the CONFIG rate 0.81 → 4,488 recycled / 1,053 landfilled', () => {
    // 0.81 × 5,541 = 4,488.21 → round-half-up = 4,488; landfilled = 5,541 − 4,488 = 1,053.
    const split = deriveRecyclingSplit(5541, D('0.8100'));
    expect(split.recycledLbs).toBe(4488);
    expect(split.landfilledLbs).toBe(1053);
    expect(split.recycledLbs + split.landfilledLbs).toBe(5541);
    expect(split.recyclingPercent).toBe('0.8100');
  });

  it("documents the 1-lb delta vs Kelsey's verbal 4,487/1,054 (an 80.98% split, not 0.81)", () => {
    // Kelsey's pair sums to 5,541 but is NOT 0.81 of 5,541 at any rounding. To land on
    // her 4,487, the rate would have to be ~0.8098 — proving the delta is a rate/rounding
    // artifact, not a bug in the split math. Both are asserted so the intent is explicit.
    expect(1054 + 4487).toBe(5541);
    expect(D('0.81').times(5541).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber()).toBe(4488);
    const kelseyImpliedPct = D('4487').dividedBy(5541); // 0.809782…
    expect(Number(kelseyImpliedPct.toFixed(4))).toBeCloseTo(0.8098, 4);
  });

  it('100% (Green Zone) → whole load recycled, nothing landfilled', () => {
    const split = deriveRecyclingSplit(5541, D('1.0000'));
    expect(split).toMatchObject({ recycledLbs: 5541, landfilledLbs: 0 });
  });

  it('0% → whole load landfilled, nothing recycled', () => {
    const split = deriveRecyclingSplit(5541, D('0.0000'));
    expect(split).toMatchObject({ recycledLbs: 0, landfilledLbs: 5541 });
  });

  it('complement-by-subtraction beats independent rounding: 5 lb @ 0.5 → 3 + 2 = 5 (no drift)', () => {
    // Two independent round-half-up ops would give round(2.5)=3 recycled AND round(2.5)=3
    // landfilled = 6 (a 1-lb over-count). Subtraction guarantees exact sum.
    const split = deriveRecyclingSplit(5, D('0.5'));
    expect(split.recycledLbs).toBe(3);
    expect(split.landfilledLbs).toBe(2);
    expect(split.recycledLbs + split.landfilledLbs).toBe(5);
  });

  it('invariant holds across a grid of weights × rates: recycled + landfilled == weight, both >= 0', () => {
    const weights = [0, 1, 2, 3, 7, 99, 100, 1053, 5541, 9999, 1_000_001];
    const pcts = ['0.0000', '0.0001', '0.1900', '0.5000', '0.8100', '0.9999', '1.0000'];
    for (const w of weights) {
      for (const p of pcts) {
        const s = deriveRecyclingSplit(w, D(p));
        expect(s.recycledLbs + s.landfilledLbs).toBe(w);
        expect(s.recycledLbs).toBeGreaterThanOrEqual(0);
        expect(s.landfilledLbs).toBeGreaterThanOrEqual(0);
        expect(s.recycledLbs).toBeLessThanOrEqual(w);
      }
    }
  });

  it('rejects a non-integer / negative weight and an out-of-range fraction', () => {
    expect(() => deriveRecyclingSplit(5541.5, D('0.81'))).toThrow(RecordValidationError);
    expect(() => deriveRecyclingSplit(-1, D('0.81'))).toThrow(RecordValidationError);
    expect(() => deriveRecyclingSplit(100, D('1.0001'))).toThrow(RecordValidationError);
    expect(() => deriveRecyclingSplit(100, D('-0.0001'))).toThrow(RecordValidationError);
  });
});

// ── Effective-dated resolver ──────────────────────────────────────────────────
describe('resolveRecyclingRate — effective-date selection', () => {
  it('returns the row whose window covers the date; null before it opens and after it closes', async () => {
    rates.push({
      id: 'r1',
      vendor_id: 'v1',
      commodity: 'metal',
      recycling_percent: D('0.81'),
      effective_from: day('2026-01-01'),
      effective_to: day('2026-06-30'),
    });
    expect(await resolveRecyclingRate('v1', 'metal', day('2026-03-15'))).toMatchObject({ id: 'r1' });
    expect(await resolveRecyclingRate('v1', 'metal', day('2026-01-01'))).toMatchObject({ id: 'r1' }); // inclusive from
    expect(await resolveRecyclingRate('v1', 'metal', day('2026-06-30'))).toMatchObject({ id: 'r1' }); // inclusive to
    expect(await resolveRecyclingRate('v1', 'metal', day('2025-12-31'))).toBeNull(); // before open
    expect(await resolveRecyclingRate('v1', 'metal', day('2026-07-01'))).toBeNull(); // after close
  });

  it('an open-ended (effective_to null) rate covers every future date', async () => {
    rates.push({
      id: 'r2',
      vendor_id: 'v1',
      commodity: 'metal',
      recycling_percent: D('0.81'),
      effective_from: day('2020-01-01'),
      effective_to: null,
    });
    expect(await resolveRecyclingRate('v1', 'metal', day('2030-12-31'))).toMatchObject({ id: 'r2' });
  });

  it('returns null when no rate exists for the (vendor, commodity) — the no-rate case', async () => {
    expect(await resolveRecyclingRate('v-none', 'wood', day('2026-03-15'))).toBeNull();
  });

  it('throws AmbiguousRecyclingRateError when more than one row covers the date', async () => {
    // Structurally forbidden by the overlap guards; if it ever happens it is corruption.
    rates.push(
      { id: 'a', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2026-01-01'), effective_to: null },
      { id: 'b', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.90'), effective_from: day('2026-02-01'), effective_to: null },
    );
    await expect(resolveRecyclingRate('v1', 'metal', day('2026-03-01'))).rejects.toBeInstanceOf(
      AmbiguousRecyclingRateError,
    );
  });
});

// ── Combined derivation (resolver + math) ─────────────────────────────────────
describe('deriveOutboundRecycling — entry-time derivation', () => {
  it('no vendor → { status: "no_vendor" } (fields stay null)', async () => {
    expect(await deriveOutboundRecycling({ vendorId: null, commodity: 'metal', shipDate: day('2026-03-01'), weightLbs: 5541 })).toEqual({
      status: 'no_vendor',
    });
  });

  it('vendor but no covering rate → { status: "no_rate" } (never assumes 100%)', async () => {
    expect(await deriveOutboundRecycling({ vendorId: 'v1', commodity: 'metal', shipDate: day('2026-03-01'), weightLbs: 5541 })).toEqual({
      status: 'no_rate',
    });
  });

  it('derives the split + snapshots the percent + records the rate id (Xtraction 0.81)', async () => {
    rates.push({
      id: 'xtraction-metal',
      vendor_id: 'v-xtraction',
      commodity: 'metal',
      recycling_percent: D('0.8100'),
      effective_from: day('2020-01-01'),
      effective_to: null,
    });
    const r = await deriveOutboundRecycling({ vendorId: 'v-xtraction', commodity: 'metal', shipDate: day('2026-03-01'), weightLbs: 5541 });
    expect(r).toMatchObject({
      status: 'derived',
      recycledLbs: 4488,
      landfilledLbs: 1053,
      recyclingPercent: '0.8100',
      rateId: 'xtraction-metal',
    });
  });
});

// ── Overlap guard (write path, layer 2 of 3) ──────────────────────────────────
describe('assertNoRecyclingRateOverlap — window overlap rejection', () => {
  // A stub tx exposing the same recyclingRate.findMany the mock provides.
  const tx = {
    recyclingRate: {
      findMany: async ({ where }: { where: RateWhere }) =>
        rates.filter((r) => matchRate(r, where)).map((r) => ({ id: r.id })),
    },
  } as unknown as Parameters<typeof assertNoRecyclingRateOverlap>[0];

  it('rejects a proposed window overlapping an existing closed window', async () => {
    rates.push({ id: 'e1', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2026-01-01'), effective_to: day('2026-06-30') });
    // proposed 2026-03-01 .. 2026-09-30 overlaps 2026-03..06-30
    await expect(
      assertNoRecyclingRateOverlap(tx, 'v1', 'metal', day('2026-03-01'), day('2026-09-30')),
    ).rejects.toBeInstanceOf(RecyclingRateOverlapError);
  });

  it('rejects a new OPEN-ended window overlapping an existing open window', async () => {
    rates.push({ id: 'e2', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2020-01-01'), effective_to: null });
    await expect(
      assertNoRecyclingRateOverlap(tx, 'v1', 'metal', day('2026-01-01'), null),
    ).rejects.toBeInstanceOf(RecyclingRateOverlapError);
  });

  it('allows a strictly-later window after the existing one is end-dated (no overlap)', async () => {
    rates.push({ id: 'e3', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2026-01-01'), effective_to: day('2026-06-30') });
    // proposed opens 2026-07-01, strictly after the close — no overlap.
    await expect(
      assertNoRecyclingRateOverlap(tx, 'v1', 'metal', day('2026-07-01'), null),
    ).resolves.toBeUndefined();
  });

  it('does not flag a DIFFERENT (vendor, commodity) as an overlap', async () => {
    rates.push({ id: 'e4', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2020-01-01'), effective_to: null });
    await expect(assertNoRecyclingRateOverlap(tx, 'v2', 'metal', day('2026-01-01'), null)).resolves.toBeUndefined();
    await expect(assertNoRecyclingRateOverlap(tx, 'v1', 'wood', day('2026-01-01'), null)).resolves.toBeUndefined();
  });

  it('excludes a given rate id (self) when editing in place', async () => {
    rates.push({ id: 'self', vendor_id: 'v1', commodity: 'metal', recycling_percent: D('0.81'), effective_from: day('2020-01-01'), effective_to: null });
    await expect(
      assertNoRecyclingRateOverlap(tx, 'v1', 'metal', day('2020-01-01'), null, 'self'),
    ).resolves.toBeUndefined();
  });
});
