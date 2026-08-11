// ADR-0091 — the consumed-slot OFFER decision, tested where it is made.
//
// `consumed-slot.test.ts` covers the classification ("has this slot been
// worked?"). This file covers the second question ("so what can this person do
// about it?"), which is the one that was never asked at all before 2026-08-11 —
// the card simply asserted "Already started by another operator" and stopped.

import { describe, expect, it } from 'vitest';
import { describeConsumedSlot, type ConsumedSlotFacts } from './consumed-slot-view';

const PABLO = 'user-pablo';
const JANETTE = 'user-janette';

function facts(over: Partial<ConsumedSlotFacts> = {}): ConsumedSlotFacts {
  return {
    open: true,
    loadId: 'load-costco-h136311',
    holderUserId: PABLO,
    holderName: 'Pablo Ledezma',
    ...over,
  };
}

describe('describeConsumedSlot', () => {
  it('THE INCIDENT: the holder gets `resume`, not a claim that somebody else has it', () => {
    // Pablo started H-136311 at 06:46 PDT and came back to a screen that told
    // him another operator held his own load and offered him nothing.
    expect(describeConsumedSlot(facts(), PABLO)).toEqual({
      kind: 'resume',
      loadId: 'load-costco-h136311',
    });
  });

  it('a different operator gets `held`, WITH the route to the ADR-0082 takeover', () => {
    // Not a dead end either: the load page renders the held-by panel and a Take
    // over button, so the honest answer still comes with a way forward.
    expect(describeConsumedSlot(facts(), JANETTE)).toEqual({
      kind: 'held',
      loadId: 'load-costco-h136311',
      holderName: 'Pablo Ledezma',
    });
  });

  it('a CLOSED slot is `worked` regardless of who holds it — Am.1 is preserved', () => {
    // The regression guard. A `submitted` load has left the floor's hands, so it
    // keeps the read-only card even for its own holder; re-offering a control
    // onto finished work is the defect ADR-0074 Am.1 was written about.
    expect(describeConsumedSlot(facts({ open: false }), PABLO)).toEqual({ kind: 'worked' });
    expect(describeConsumedSlot(facts({ open: false }), JANETTE)).toEqual({ kind: 'worked' });
  });

  it('an UNASSIGNED open load never reads as yours, even to an unauthenticated blank', () => {
    // Two nulls must not compare equal into `resume`. This is the branch that
    // would hand an ownerless load to whoever looked at it, and the reason the
    // helper tests `holderUserId !== null` explicitly rather than relying on a
    // caller always having a session.
    expect(describeConsumedSlot(facts({ holderUserId: null, holderName: null }), PABLO)).toEqual({
      kind: 'held',
      loadId: 'load-costco-h136311',
      holderName: null,
    });
    expect(describeConsumedSlot(facts({ holderUserId: null, holderName: null }), '')).toEqual({
      kind: 'held',
      loadId: 'load-costco-h136311',
      holderName: null,
    });
  });

  it('carries the load id on every actionable outcome, so no branch can dead-end', () => {
    // The property the whole ADR is about: if the slot is open, the card can
    // always get you somewhere. Stated as a loop over both viewers so a future
    // branch that forgets the id fails here rather than on the dock.
    for (const viewer of [PABLO, JANETTE]) {
      const v = describeConsumedSlot(facts(), viewer);
      expect(v.kind).not.toBe('worked');
      expect('loadId' in v && v.loadId).toBe('load-costco-h136311');
    }
  });
});
