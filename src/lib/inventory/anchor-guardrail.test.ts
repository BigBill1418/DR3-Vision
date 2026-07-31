// ADR-0072 — tier classification.
//
// The number under test is the one that decides whether a tap can move
// Woodland's entire floor. Every guard was falsified before being kept.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SWING_THRESHOLD_PCT,
  classifyAnchorWrite,
  describeSwing,
  type PriorAnchor,
} from './anchor-guardrail';

const anchor = (total: number): PriorAnchor => ({
  id: 'snap-prior',
  total,
  programUnits: null,
  nonProgramUnits: null,
  snapshotAt: new Date('2026-07-22T07:00:00.000Z'),
});

/** Woodland's real anchor as of 2026-07-22. */
const WOODLAND = anchor(2483);

describe('classifyAnchorWrite', () => {
  it('Tier 0 — no prior anchor writes straight through (every Eugene count today)', () => {
    const c = classifyAnchorWrite({ prior: null, newTotal: 900 });
    expect(c.tier).toBe(0);
    expect(c.isOverwrite).toBe(false);
    expect(c.requiresManagerApproval).toBe(false);
    expect(c.swingPct).toBeNull();
  });

  it('Tier 1 — a modest overwrite needs a confirm, not a manager', () => {
    // 2483 → 2150 is a 13.4% decrease.
    const c = classifyAnchorWrite({ prior: WOODLAND, newTotal: 2150 });
    expect(c.tier).toBe(1);
    expect(c.isOverwrite).toBe(true);
    expect(c.requiresManagerApproval).toBe(false);
    expect(Math.round(c.swingPct!)).toBe(13);
    expect(c.delta).toBe(-333);
  });

  it('Tier 2 — a large overwrite requires a manager', () => {
    // 2483 → 1200 is a 51.7% decrease: the fat-fingered-digit case.
    const c = classifyAnchorWrite({ prior: WOODLAND, newTotal: 1200 });
    expect(c.tier).toBe(2);
    expect(c.requiresManagerApproval).toBe(true);
  });

  it('an INCREASE of the same magnitude is treated identically', () => {
    // A guardrail that only watches decreases misses a doubled floor, which
    // over-reports units to MRC rather than under-reporting them.
    const c = classifyAnchorWrite({ prior: WOODLAND, newTotal: 2483 + 1283 });
    expect(c.tier).toBe(2);
    expect(c.delta).toBeGreaterThan(0);
  });

  it('exactly the threshold is Tier 1 — the largest swing an operator may confirm alone', () => {
    const c = classifyAnchorWrite({ prior: anchor(1000), newTotal: 800 }); // exactly 20%
    expect(c.swingPct).toBe(20);
    expect(c.tier).toBe(1);
    // And a hair over is Tier 2.
    expect(classifyAnchorWrite({ prior: anchor(1000), newTotal: 799 }).tier).toBe(2);
  });

  it('re-entering the SAME count is a zero swing — Tier 1, never held', () => {
    const c = classifyAnchorWrite({ prior: WOODLAND, newTotal: 2483 });
    expect(c.swingPct).toBe(0);
    expect(c.tier).toBe(1);
  });

  it('honours a retuned threshold without a code change', () => {
    // The 40% Bill rejected would have let this through on a confirm.
    expect(classifyAnchorWrite({ prior: WOODLAND, newTotal: 1800 }).tier).toBe(2);
    expect(classifyAnchorWrite({ prior: WOODLAND, newTotal: 1800, thresholdPct: 40 }).tier).toBe(1);
  });

  it('a zero prior anchor is Tier 1, not an infinite swing', () => {
    // Every non-zero count against a zero baseline is an infinite percentage. A
    // site that once counted empty would otherwise hold every count forever.
    const c = classifyAnchorWrite({ prior: anchor(0), newTotal: 500 });
    expect(c.tier).toBe(1);
    expect(c.isOverwrite).toBe(true);
    expect(c.swingPct).toBeNull();
    expect(c.requiresManagerApproval).toBe(false);
  });

  it('a count of ZERO against a real anchor is a full swing and IS held', () => {
    // The "operator submitted an empty form" case. 100% > 20%.
    const c = classifyAnchorWrite({ prior: WOODLAND, newTotal: 0 });
    expect(c.swingPct).toBe(100);
    expect(c.tier).toBe(2);
  });

  it('defaults to the 20% Bill set', () => {
    expect(DEFAULT_SWING_THRESHOLD_PCT).toBe(20);
    expect(classifyAnchorWrite({ prior: WOODLAND, newTotal: 2150 }).thresholdPct).toBe(20);
  });
});

describe('describeSwing', () => {
  it('says it in words — two bare numbers are what get skimmed past', () => {
    const s = describeSwing(classifyAnchorWrite({ prior: WOODLAND, newTotal: 2150 }));
    expect(s).toContain('2,483');
    expect(s).toContain('2,150');
    expect(s).toContain('decrease');
    expect(s).toContain('333');
    expect(s).toContain('13%');
  });

  it('names an increase as an increase', () => {
    const s = describeSwing(classifyAnchorWrite({ prior: WOODLAND, newTotal: 2600 }));
    expect(s).toContain('an increase');
  });

  it('describes a first anchor without pretending there was a prior', () => {
    const s = describeSwing(classifyAnchorWrite({ prior: null, newTotal: 900 }));
    expect(s).toMatch(/first anchor/i);
  });
});
