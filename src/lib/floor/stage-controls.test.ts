// ADR-0122 — the verdict rule, exercised over the states that actually occur.
//
// This file tests the RULE. `stage-liveness.test.tsx` tests the rule wired to the
// real screens, which is the half that could not have been faked: the 2026-08-20
// trap lived in the SEAM between three files, and a rule tested only against
// hand-written reason sets would have agreed with itself all the way through the
// incident.
//
// The incident's exact reason set is the first case below, named as such.

import { describe, expect, it } from 'vitest';
import {
  isStageDeadEnd,
  STAGE_CONTROL_IDS,
  STAGE_DISABLE_REASONS,
  STAGE_IDS,
  TRANSIENT_DISABLE_REASONS,
  type StageControlId,
  type StageDisableReason,
} from './stage-controls';

type Entry = readonly [StageControlId, StageDisableReason | null];

describe('the 2026-08-20 Woodland trap', () => {
  // H-137810, stage 1, 12:36:35 PT. `photo_counts.bol` was 1, so:
  //   - capture withheld because the required photo already exists (ADR-0109)
  //   - "add another" not rendered, because a fresh mount is `idle`
  //   - Continue held by `!hasFile`, which is false on every fresh mount
  // Three correct rules, zero live controls, surviving a hard refresh.
  const TRAP: Entry[] = [
    ['photo_capture', 'photo_present'],
    ['photo_add_another', 'not_captured'],
    ['bol_continue', 'no_photo'],
  ];

  it('is a dead end', () => {
    expect(isStageDeadEnd(TRAP), 'the incident state must page').toBe(true);
  });

  it('is NOT a dead end once #286 arms Continue', () => {
    // ADR-0121's fix: `(!hasFile && photoCount === 0)`. With a server photo the
    // gate opens, and the same two photo controls stay exactly as dark as they
    // were — which is the point. The screen is live again because of ONE control.
    const fixed: Entry[] = [
      ['photo_capture', 'photo_present'],
      ['photo_add_another', 'not_captured'],
      ['bol_continue', null],
    ];
    expect(isStageDeadEnd(fixed), 'the shipped fix must silence the alert').toBe(false);
  });
});

describe('isStageDeadEnd', () => {
  it('withholds the verdict when nothing has registered', () => {
    // UNMEASURED, not dead. A boundary that fired on an empty registry would
    // report a dead end for every stage during its first commit, which is a
    // fabricated negative from the instrument built to find real ones.
    expect(isStageDeadEnd([])).toBe(false);
  });

  it('is false when any single control is live', () => {
    const many: Entry[] = STAGE_CONTROL_IDS.map((id) => [id, 'not_rendered'] as Entry);
    expect(isStageDeadEnd(many)).toBe(true);
    const withOneLive: Entry[] = [...many.slice(1), [STAGE_CONTROL_IDS[0]!, null]];
    expect(isStageDeadEnd(withOneLive)).toBe(false);
  });

  for (const transient of TRANSIENT_DISABLE_REASONS) {
    it(`is false when a control is disabled for the transient reason "${transient}"`, () => {
      // Every tap on this floor passes through an all-disabled frame. A detector
      // that paged on those would be muted within the hour, and then the real
      // one would not arrive either.
      expect(
        isStageDeadEnd([
          ['bol_continue', transient],
          ['photo_capture', 'photo_present'],
          ['photo_add_another', 'not_captured'],
        ]),
      ).toBe(false);
    });
  }

  for (const reason of STAGE_DISABLE_REASONS.filter(
    (r) => !TRANSIENT_DISABLE_REASONS.includes(r),
  )) {
    it(`is true when every control is dark and the worst reason is "${reason}"`, () => {
      expect(
        isStageDeadEnd([
          ['bol_continue', reason],
          ['photo_capture', reason],
        ]),
      ).toBe(true);
    });
  }

  it('a screen where every control is merely NOT RENDERED is still a dead end', () => {
    // Counter-intuitive and deliberate: a stage that rendered no control at all
    // offers the operator nothing, and "the buttons are on a different sub-screen"
    // is not a way out of the one they are looking at.
    expect(
      isStageDeadEnd([
        ['weight_add', 'not_rendered'],
        ['weight_none', 'not_rendered'],
      ]),
    ).toBe(true);
  });
});

describe('the vocabulary is closed', () => {
  // These arrays are the ONLY definition — the route validates against them and
  // the components derive their prop types from them. A duplicate list anywhere
  // is the `ntfy-fallback-topics.yml` failure mode, where nothing at runtime
  // notices the drift.
  it('has no duplicate ids', () => {
    expect(new Set(STAGE_IDS).size).toBe(STAGE_IDS.length);
    expect(new Set(STAGE_CONTROL_IDS).size).toBe(STAGE_CONTROL_IDS.length);
    expect(new Set(STAGE_DISABLE_REASONS).size).toBe(STAGE_DISABLE_REASONS.length);
  });

  it('every transient reason is a real reason', () => {
    for (const r of TRANSIENT_DISABLE_REASONS) expect(STAGE_DISABLE_REASONS).toContain(r);
  });

  it('covers all seven stages', () => {
    expect(STAGE_IDS).toHaveLength(7);
  });
});
