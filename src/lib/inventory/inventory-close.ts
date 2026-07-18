// ADR-0037 amendment (rollup 2026-07-17 §2.3 + §1.1 + §A.2) — the CORRECT-ARITHMETIC
// inventory close.
//
// This is the billing-authoritative month-close computation. It implements the
// arithmetic the rollup §2.3 specifies in CODE — deliberately NOT the workbook's own
// D45/D48 formulas, which are latently buggy (D45 ADDS non-program stripped instead of
// subtracting; D48 double-subtracts sold/landfilled). Those formulas happen to produce
// the right number for June ONLY because non-program stripped, sold, and landfilled are
// all zero this month; a month where the program pool runs dry would expose them. Vision
// therefore never reads the literal D45/D48 — it computes the close here.
//
//   program_close     = program_open + program_inbound − program_stripped
//   non_program_close = non_program_open + non_program_inbound − non_program_stripped
//                                        − saved_units                              (§A.2)
//   total_close       = program_close + non_program_close − sold − landfilled
//
// June (corrected workbook, SHA 1eeeccb…): 1423 + 19451 − 17126 = 3748 program;
// 0 + 229 − 0 − 0 = 229 non-program; 3748 + 229 − 0 − 0 = 3977 total.
//
// §A.2 (Kelsey, 2026-07-17): `saved_units` (mattresses set aside, not processed) are
// SUBTRACTED from the NON-PROGRAM pool. Defensible default until Rick confirms OR
// practice.
//
// NOTE on `total`: per §2.3, sold + landfilled come off the TOTAL, not a specific pool,
// so `program + nonProgram === total` holds only when sold + landfilled === 0 (true for
// June). This mirrors the workbook's own D48. The pool-attributed model — where sold /
// landfilled reduce their own pool and the invariant always holds — lives in
// `running-balance.ts` (`computeRunningBalance`), the DB-backed live inventory. Both
// agree whenever sold + landfilled === 0.
//
// All arithmetic is `Prisma.Decimal` (stripped/saved are Decimal(7,1); every other count
// is an Int) — zero float drift at any count boundary.

import { Prisma } from '@prisma/client';

const D = Prisma.Decimal;
type DecimalLike = Prisma.Decimal | number | string;

/** Every pool-level aggregate the §2.3 close consumes (all over the closing window). */
export interface InventoryClosePools {
  /** Program opening balance (Processed!D5 = DAY1!L2 = 1423 for June). */
  programOpen: DecimalLike;
  /** Non-program opening balance (Processed!F5 = 0 for June). */
  nonProgramOpen: DecimalLike;
  /** Program inbound over the window (Processed!F40 = 19451 for June). */
  programInbound: DecimalLike;
  /** Non-program inbound over the window (Processed!G40 = 229 for June). */
  nonProgramInbound: DecimalLike;
  /** Program units stripped/processed (Processed!D40 = 17126 for June). */
  programStripped: DecimalLike;
  /** Non-program units stripped (Processed!E40 = 0 for June). */
  nonProgramStripped: DecimalLike;
  /** `Saved` units set aside — subtract from the NON-program pool (§A.2). 0 for June. */
  savedUnits: DecimalLike;
  /** Whole units sold (Processed!H40 = 0 for June) — off the total. */
  sold: DecimalLike;
  /** Whole units landfilled (Processed!I40 = 0 for June) — off the total. */
  landfilled: DecimalLike;
}

/** The pool-aware close. `program + nonProgram === total` iff `sold + landfilled === 0`. */
export interface InventoryClose {
  program: Prisma.Decimal;
  nonProgram: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** The §2.3 correct-arithmetic month-close. Pure — no DB, no clock, fully testable. */
export function computeInventoryClose(p: InventoryClosePools): InventoryClose {
  const program = new D(p.programOpen).plus(p.programInbound).minus(p.programStripped);
  const nonProgram = new D(p.nonProgramOpen)
    .plus(p.nonProgramInbound)
    .minus(p.nonProgramStripped)
    .minus(p.savedUnits);
  const total = program.plus(nonProgram).minus(p.sold).minus(p.landfilled);
  return { program, nonProgram, total };
}

/** A day's stripped units split into the two pools. */
export interface StrippedSplit {
  program: Prisma.Decimal;
  nonProgram: Prisma.Decimal;
}

/**
 * §1.1 sequential depletion (program-first, Kelsey Q1): program units are ALWAYS
 * processed first, so a day's stripping draws non-program units ONLY once the program
 * pool is exhausted.
 *
 *   program_stripped_today     = min(program_available, daily_stripped_total)
 *   non_program_stripped_today = max(0, daily_stripped_total − program_available)
 *
 * In June every stripped unit is program (E40 = 0), so this is a no-op for June's
 * numbers — but it is the correct general-case rule and the workbook provides the
 * explicit D/E split only because it already applied this logic.
 */
export function sequentialDepletion(
  programAvailable: DecimalLike,
  dailyStrippedTotal: DecimalLike,
): StrippedSplit {
  const total = new D(dailyStrippedTotal);
  if (total.lessThanOrEqualTo(0)) return { program: new D(0), nonProgram: new D(0) };
  const availPos = new D(programAvailable).lessThan(0) ? new D(0) : new D(programAvailable);
  const program = total.lessThan(availPos) ? total : availPos; // min(availPos, total)
  return { program, nonProgram: total.minus(program) };
}

/** One day's inputs for a program-first depletion walk. */
export interface DailyDepletionInput {
  /** Program units that arrived that day (adds to the program pool before stripping). */
  programInbound: DecimalLike;
  /** Non-program units that arrived that day. */
  nonProgramInbound: DecimalLike;
  /** Total units stripped that day (the number to split program-first). */
  strippedTotal: DecimalLike;
}

/** Per-day depletion outcome + the running program pool after that day. */
export interface DailyDepletionResult extends StrippedSplit {
  programAvailableBefore: Prisma.Decimal;
}

/**
 * Walk a day series applying §1.1 depletion day by day, carrying the program pool
 * forward. Returns the per-day splits and the summed program/non-program stripped —
 * the general-case way to derive the split when only daily stripped TOTALS are known
 * (the workbook already carries the split, so this is used for validation + the
 * general non-June case). Non-program inbound accumulates its own pool but is only
 * ever stripped after program is exhausted on the same day.
 */
export function depleteSeries(
  programOpen: DecimalLike,
  days: readonly DailyDepletionInput[],
): {
  perDay: DailyDepletionResult[];
  totalProgramStripped: Prisma.Decimal;
  totalNonProgramStripped: Prisma.Decimal;
} {
  let programPool = new D(programOpen);
  const perDay: DailyDepletionResult[] = [];
  let totalProgramStripped = new D(0);
  let totalNonProgramStripped = new D(0);
  for (const day of days) {
    const programAvailableBefore = programPool.plus(day.programInbound);
    const split = sequentialDepletion(programAvailableBefore, day.strippedTotal);
    programPool = programAvailableBefore.minus(split.program);
    perDay.push({ ...split, programAvailableBefore });
    totalProgramStripped = totalProgramStripped.plus(split.program);
    totalNonProgramStripped = totalNonProgramStripped.plus(split.nonProgram);
  }
  return { perDay, totalProgramStripped, totalNonProgramStripped };
}
