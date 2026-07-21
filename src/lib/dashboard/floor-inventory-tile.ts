// Rollup §3 (2026-07-21 handoff, §15 item 5) — live floor inventory tile data.
//
// Rick's operational ask: "As of this morning i had 137 Program Units on my
// floor and 1152 Non Program Units on the floor... Will it give us a
// 'currently on the floor' inventory?" Bill confirmed: Vision tracks both
// pools live per site.
//
// The tile is a thin read over the ONE running-balance computation
// (ADR-0037 D6, `onHand`) — it never re-derives pool math of its own, so the
// numbers a manager sees are exactly the sequential-depletion-aware ledger
// (Kelsey Q1: processing 237 with 137 program on floor reports 137 program +
// 100 non-program processed; those splits land in `processed_units_daily` and
// `onHand` subtracts them per pool). Site-scoped (CLAUDE.md hard rule #2).
//
// Optional projection (§3 "days of program pool remaining"): under sequential
// depletion the PROGRAM pool is consumed FIRST by every processed unit, so its
// depletion rate is the trailing mean of TOTAL stripped units/day (program +
// non-program) — not the program-attributed share, which collapses to zero the
// day the pool empties. Trailing window is 7 calendar days of closes, matching
// the equipment tile's units/day convention (ADR-0044).

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { onHand } from '@/lib/inventory/running-balance';
import { appTodayISO, dayKeyUTCFromISO } from '@/lib/time';

const D = Prisma.Decimal;

/** One trailing daily close's stripped split (Decimal(7,1) columns). */
export interface TrailingClose {
  stripped_program: Prisma.Decimal;
  stripped_non_program: Prisma.Decimal;
}

export interface FloorProjection {
  /** Trailing mean of TOTAL stripped units/day — null when no closes in window. */
  trailingUnitsPerDay: number | null;
  /**
   * Program pool ÷ trailing rate, in days (sequential depletion: the whole
   * processing rate drains program first). Null when no rate; clamped ≥ 0.
   */
  programDaysRemaining: number | null;
}

export interface FloorInventoryTileData {
  /** Program units currently on the floor (may be fractional — Decimal(7,1) flows). */
  programOnFloor: number;
  nonProgramOnFloor: number;
  totalOnFloor: number;
  /** How the anchor snapshot's pools were derived — `legacy` = unsplit anchor. */
  anchorPool: 'measured' | 'legacy' | null;
  trailingUnitsPerDay: number | null;
  programDaysRemaining: number | null;
  asOfISO: string;
}

/**
 * Pure §3 projection. Program pool depletes FIRST (Kelsey Q1 sequential
 * depletion), so days-remaining divides by the trailing TOTAL rate. No DB,
 * no clock — unit-testable with real `Prisma.Decimal` values.
 */
export function computeProgramPoolProjection(
  programOnFloor: Prisma.Decimal,
  closes: readonly TrailingClose[],
): FloorProjection {
  if (closes.length === 0) {
    return { trailingUnitsPerDay: null, programDaysRemaining: null };
  }
  const totalStripped = closes.reduce(
    (sum, c) => sum.plus(c.stripped_program).plus(c.stripped_non_program),
    new D(0),
  );
  const rate = totalStripped.dividedBy(closes.length);
  if (rate.lessThanOrEqualTo(0)) {
    return { trailingUnitsPerDay: rate.toNumber(), programDaysRemaining: null };
  }
  const days = programOnFloor.dividedBy(rate);
  return {
    trailingUnitsPerDay: rate.toNumber(),
    // A negative pool (drifted ledger awaiting a physical count) projects as 0
    // days — "you are already out", not a nonsense negative.
    programDaysRemaining: days.lessThan(0) ? 0 : days.toNumber(),
  };
}

/**
 * Compute the live floor tile for a site. `now` defaults to the real clock;
 * injectable for tests. Callers on the dashboard wrap with `.catch(() => null)`
 * (degrade, never throw the page) per the ADR-0043/0044 tile convention.
 */
export async function computeFloorInventoryTile(
  siteId: string,
  opts: { now?: Date } = {},
): Promise<FloorInventoryTileData> {
  const now = opts.now ?? new Date();
  const asOfISO = appTodayISO(now);
  const endKey = dayKeyUTCFromISO(asOfISO);
  const startKey = new Date(endKey.getTime() - 6 * 86_400_000); // trailing 7 days inclusive

  const [balance, closes] = await Promise.all([
    onHand(siteId, now),
    prisma.processedUnitsDaily.findMany({
      where: { site_id: siteId, production_date: { gte: startKey, lte: endKey } },
      select: { stripped_program: true, stripped_non_program: true },
    }),
  ]);

  const projection = computeProgramPoolProjection(balance.program, closes);

  return {
    programOnFloor: balance.program.toNumber(),
    nonProgramOnFloor: balance.nonProgram.toNumber(),
    totalOnFloor: balance.total.toNumber(),
    anchorPool: balance.anchorPool ?? null,
    trailingUnitsPerDay: projection.trailingUnitsPerDay,
    programDaysRemaining: projection.programDaysRemaining,
    asOfISO,
  };
}
