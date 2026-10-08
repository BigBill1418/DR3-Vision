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
}

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
      };
    }
    case 'intake-stale': {
      const d = cause.inboundDaysSince;
      return {
        subject: 'On-hand',
        qualifier: '',
        reason: `Intake data is incomplete — most recent inbound is ${d} ${d === 1 ? 'day' : 'days'} old.`,
        short: 'intake incomplete',
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
      };
  }
}
