// BS-10 — the floor tile gains an UPPER bound, decided at the same choke point as
// the lower one.
//
// The tile already carries `negative`, and the reason it lives in the builder
// rather than in each component is written down: "it is decided HERE so the tile
// and the daily report cannot disagree about when a floor has gone impossible."
// There was no upper bound at all. That is why Woodland rendered 11,020 units in a
// 3,500-unit building, at `text-5xl`, on seven surfaces, for six days, with nothing
// anywhere saying a word.
//
// A floor over capacity is not necessarily a DATA error — it can be a real
// operational emergency — so this flags rather than clamps. What it must never do
// again is render as an ordinary quantity.

import { describe, expect, it } from 'vitest';
import { floorCapacityState, type CapacityInputs } from './floor-capacity';

const woodland: CapacityInputs = { maxUnitsIndoor: 3500, maxUnitsTotalOnSite: null };
const eugene: CapacityInputs = { maxUnitsIndoor: null, maxUnitsTotalOnSite: 6000 };

describe('floorCapacityState', () => {
  it('flags the live Woodland figure — 11,668 against a 3,500 cap', () => {
    const s = floorCapacityState(11668, woodland);
    expect(s.capacity).toBe(3500);
    expect(s.overCapacity).toBe(true);
    expect(s.pctOfCapacity).toBe(333);
  });

  it('does NOT flag a floor inside the cap — the negative control', () => {
    const s = floorCapacityState(923, woodland);
    expect(s.overCapacity).toBe(false);
    expect(s.pctOfCapacity).toBe(26);
  });

  it('does not flag a floor exactly AT the cap', () => {
    // At capacity is full, not impossible. Flagging it would make the warning
    // routine, and a routine warning is one nobody reads.
    expect(floorCapacityState(3500, woodland).overCapacity).toBe(false);
    expect(floorCapacityState(3501, woodland).overCapacity).toBe(true);
  });

  it('uses the OR total-on-site cap where that is the recorded one', () => {
    // CA grades on the indoor cap, OR on the total on-site cap (ADR-0037 addendum
    // 2026-07-22, no outdoor addend). Reading only `max_units_indoor` would leave
    // Eugene permanently uncapped.
    const s = floorCapacityState(7000, eugene);
    expect(s.capacity).toBe(6000);
    expect(s.overCapacity).toBe(true);
  });

  it('reports capacity null and NEVER flags when no cap is recorded', () => {
    // "No cap on file" must not read as "over cap", and must not read as "fine"
    // either — the component shows the number without a capacity claim.
    const s = floorCapacityState(99999, { maxUnitsIndoor: null, maxUnitsTotalOnSite: null });
    expect(s.capacity).toBeNull();
    expect(s.overCapacity).toBe(false);
    expect(s.pctOfCapacity).toBeNull();
  });

  it('never flags a NEGATIVE floor as over capacity', () => {
    // A negative floor is already `negative`'s business. Reporting one number as
    // both impossible-low and impossible-high is noise that discredits both.
    const s = floorCapacityState(-500, woodland);
    expect(s.overCapacity).toBe(false);
  });
});
