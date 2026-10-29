// handoff #270 §4a, amended 2026-10-08 — WHY a floor computed negative.
//
// A negative floor is a diagnostic, never a figure (the §4a rule is unchanged).
// What this module adds is the reason. Until 2026-10-08 every surface blamed
// incomplete intake unconditionally, and on 2026-10-07 Woodland's report read
// "Intake data is incomplete — most recent inbound is 0 days old" while MyMRC
// inbound had posted that same day. The real fault was the POOL SPLIT: since the
// Sep 14 anchor, program computed −147 while non-program sat near +1,750 and the
// total near +1,600 (17 of 18 daily closes had stripped_non_program = 0, so
// non-program strips were being keyed as program).
//
// Three causes, distinguished by what the numbers can actually tell apart:
//   pool-split                 — total ≥ 0, one pool < 0. Units are landing in the
//                                wrong pool; intake is not implicated at all.
//   intake-stale               — total < 0 and the inbound feed is past its
//                                business-day window. The original §4a reading.
//   processing-exceeds-inbound — total < 0 but intake is current (or the site has
//                                no intake feed, Eugene's standing condition).
//
// Pure and import-free so the server email renderer, the dashboard tile and the
// overview card all read ONE verdict and ONE set of words.

export type NegativeFloorPool = 'program' | 'non-program';

export type NegativeFloorCause =
  | { kind: 'pool-split'; pool: NegativeFloorPool }
  | { kind: 'intake-stale'; inboundDaysSince: number }
  | { kind: 'processing-exceeds-inbound'; inboundRecorded: boolean };

/** Null when nothing is negative. */
export function classifyNegativeFloor(f: {
  total: number;
  program: number;
  nonProgram: number;
  inboundStale: boolean;
  inboundDaysSince: number | null;
}): NegativeFloorCause | null {
  if (f.total >= 0) {
    if (f.program < 0) return { kind: 'pool-split', pool: 'program' };
    if (f.nonProgram < 0) return { kind: 'pool-split', pool: 'non-program' };
    return null;
  }
  if (f.inboundStale && f.inboundDaysSince != null) {
    return { kind: 'intake-stale', inboundDaysSince: f.inboundDaysSince };
  }
  return { kind: 'processing-exceeds-inbound', inboundRecorded: f.inboundDaysSince != null };
}

export interface NegativeFloorCopy {
  /** Subject of the headline: "Program on-hand" / "Non-program on-hand" / "On-hand". */
  subject: string;
  /** Appended after the (optional) magnitude: " while the total is positive" or "". */
  qualifier: string;
  /** One plain-English sentence naming the likely cause. */
  reason: string;
  /** A few words for a stat-card subtitle. */
  short: string;
  /**
   * ADR-0143 D5 — what a person does about it. THE one remedy: the floor tile, the
   * daily report, the iPad hub and the `INV-POOL-NON-NEGATIVE` invariant all read
   * this field, so they can no longer contradict each other (RC4: the invariant said
   * "do not count", the tile said "a count resets the floor").
   */
  remedy: string;
}

/**
 * ADR-0143 D5 + Bill B3 (2026-10-29): the Woodland floor is physically MIXED, so a
 * count cannot measure the split. A pool-split error is corrected by a pool
 * adjustment (four-eyes), never by a count. A count stays the reset for TOTAL drift.
 */
const POOL_SPLIT_REMEDY =
  'A physical count cannot fix this: the floor is mixed, so a count cannot measure the split. ' +
  'A site manager records a pool adjustment on the open inventory exception, and a second person approves it. ' +
  'The total does not change.';

/**
 * Plain-English copy for site managers. Headline assembly is left to each surface
 * so the email can carry the magnitude in-sentence ("… negative (−147) while …")
 * and the tile can omit it: `${subject} is computing negative${mag}${qualifier}.`
 */
export function negativeFloorCopy(cause: NegativeFloorCause): NegativeFloorCopy {
  switch (cause.kind) {
    case 'pool-split': {
      const program = cause.pool === 'program';
      return {
        subject: program ? 'Program on-hand' : 'Non-program on-hand',
        qualifier: ' while the total is positive',
        reason: `The program/non-program split looks mis-recorded — check how ${program ? 'non-program' : 'program'} units are entered in the daily close.`,
        short: 'program/non-program split mis-recorded',
        remedy: POOL_SPLIT_REMEDY,
      };
    }
    case 'intake-stale': {
      const d = cause.inboundDaysSince;
      return {
        subject: 'On-hand',
        qualifier: '',
        reason: `Intake data is incomplete — most recent inbound is ${d} ${d === 1 ? 'day' : 'days'} old.`,
        short: 'intake incomplete',
        remedy:
          'Recover the inbound feed first. Once intake is current, a physical count resets the total.',
      };
    }
    case 'processing-exceeds-inbound':
      return {
        subject: 'On-hand',
        qualifier: '',
        reason: cause.inboundRecorded
          ? 'More units have been processed than were recorded coming in since the last physical count. Inbound is up to date, so check the daily close and inbound entries since that count.'
          : 'More units have been processed than were recorded coming in since the last physical count — no inbound has ever been recorded for this site.',
        short: 'processing exceeds recorded inbound',
        remedy:
          'Find the day and the leg on the open inventory exception. Once the cause is recorded, a physical count resets the total.',
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ADR-0143 D1 — the ONE presenter for an on-hand figure.
// ─────────────────────────────────────────────────────────────────────────
//
// ADR-0110 D3 said a negative figure is REPLACED, never shown. It was implemented
// on three of five surfaces (RC3): loads-inventory and the iPad Today hub printed
// `balance.program.toString()` raw and Woodland's managers read "−247". This is now
// the only function allowed to turn a running balance into text for a person, and
// `src/lib/inventory/__tests__/onhand-presenter.guard.test.ts` fails CI when a page
// or mail module renders a pool any other way.

/** A Prisma.Decimal, or a plain number (mail renderers already hold numbers). */
export type OnHandNumber = number | { toNumber(): number };

export interface OnHandLike {
  program: OnHandNumber;
  nonProgram: OnHandNumber;
  total: OnHandNumber;
}

export interface OnHandContext {
  inboundStale?: boolean;
  inboundDaysSince?: number | null;
}

export interface PresentedOnHand {
  /** False when either POOL is negative: both pool figures are withheld, `notice` set. */
  poolsShown: boolean;
  /** en-US grouped, at most one decimal (stripped is Decimal(7,1)); null when withheld. */
  program: string | null;
  nonProgram: string | null;
  /**
   * The total is withheld ONLY when the total itself is negative. In ADR-0110 Am.1
   * case 1 (one pool < 0, total ≥ 0) the building's count is not in question — the
   * split is — and Bill ruled on 2026-10-29 (B2) "the total is what matters". Both
   * pools are withheld in that case, because the positive pool is wrong by exactly
   * the same amount as the negative one.
   */
  total: string | null;
  /** The same total as a number, for arithmetic (a count's expected delta); null when withheld. */
  totalUnits: number | null;
  cause: NegativeFloorCause | null;
  notice: { headline: string; reason: string; remedy: string } | null;
}

function num(v: OnHandNumber): number {
  return typeof v === 'number' ? v : v.toNumber();
}

function fmt(v: number): string {
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/** The single non-negative presentation of an on-hand balance (ADR-0143 D1). */
export function presentOnHand(balance: OnHandLike, ctx: OnHandContext = {}): PresentedOnHand {
  const program = num(balance.program);
  const nonProgram = num(balance.nonProgram);
  const total = num(balance.total);
  const cause = classifyNegativeFloor({
    program,
    nonProgram,
    total,
    inboundStale: ctx.inboundStale ?? false,
    inboundDaysSince: ctx.inboundDaysSince === undefined ? 0 : ctx.inboundDaysSince,
  });
  if (cause == null) {
    return {
      poolsShown: true,
      program: fmt(program),
      nonProgram: fmt(nonProgram),
      total: fmt(total),
      totalUnits: total,
      cause: null,
      notice: null,
    };
  }
  const copy = negativeFloorCopy(cause);
  return {
    poolsShown: false,
    program: null,
    nonProgram: null,
    total: total >= 0 ? fmt(total) : null,
    totalUnits: total >= 0 ? total : null,
    cause,
    notice: {
      headline: `${copy.subject} is computing negative${copy.qualifier}.`,
      reason: copy.reason,
      remedy: copy.remedy,
    },
  };
}

/** The remedy for a balance, or null when nothing is negative (invariant + report). */
export function remedyForBalance(balance: OnHandLike, ctx: OnHandContext = {}): string | null {
  return presentOnHand(balance, ctx).notice?.remedy ?? null;
}
