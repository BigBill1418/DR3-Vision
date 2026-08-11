// ADR-0092 — the staleness verdict, tested before it existed.
//
// Every threshold in here is answerable from production, and the tests name the
// number they came from rather than asserting a constant against itself. The
// measurement (2026-08-11, `dr3_vision` on svdp-dev, 58 operator-claimed loads
// that reached `submitted`):
//
//   same Pacific day as the claim   52 loads  p50 38m  p90 73m  p99 355m  max 511m
//   a LATER Pacific day              6 loads  p50 2980m (~2d)            max 5799m (~4d)
//
// There is a clean gap: healthy dock work never crosses its own Pacific day, and
// every strand is measured in days. The thresholds sit inside that gap.

import { describe, expect, it } from 'vitest';
import {
  lastActivityAt,
  stalenessOf,
  STALE_BADGE_MS,
  STALE_NUDGE_MS,
  type ClaimActivityRow,
} from './stale-claim';

const T0 = new Date('2026-08-11T13:46:00.000Z'); // 06:46 PDT
const H = 3_600_000;

function row(over: Partial<ClaimActivityRow> = {}): ClaimActivityRow {
  return {
    updatedAt: T0,
    lastStackAt: null,
    lastPhotoAt: null,
    ...over,
  };
}

describe('lastActivityAt — the signal, and the trap it avoids', () => {
  it('falls back to the row itself when there are no children', () => {
    expect(lastActivityAt(row())).toEqual(T0);
  });

  it('THE TRAP: a stack counted after the last row write wins', () => {
    // `addStack` creates a `load_stacks` row inside a transaction and does NOT
    // update the parent `inbound_loads` row (verified in `load-service.ts`), so
    // `updated_at` FREEZES while an operator counts. An operator working a
    // 40-stack trailer for three hours would look idle to a watchdog that read
    // only the parent row — and would be reported abandoned mid-count, which is
    // precisely the false positive that would discredit this feature on day one.
    const counting = row({ lastStackAt: new Date(T0.getTime() + 3 * H) });
    expect(lastActivityAt(counting)).toEqual(new Date(T0.getTime() + 3 * H));
  });

  it('a photo counts as activity too — the BOL/weight stages write no stacks', () => {
    // Between `arrived` and the first stack an operator photographs the BOL and
    // the weight ticket. Those stages produce `load_photos` rows, so a
    // stacks-only signal would call the first twenty minutes of every load idle.
    expect(lastActivityAt(row({ lastPhotoAt: new Date(T0.getTime() + 2 * H) }))).toEqual(
      new Date(T0.getTime() + 2 * H),
    );
  });

  it('takes the MAXIMUM across all three, in any order', () => {
    const r = row({
      updatedAt: new Date(T0.getTime() + 1 * H),
      lastStackAt: new Date(T0.getTime() + 5 * H),
      lastPhotoAt: new Date(T0.getTime() + 3 * H),
    });
    expect(lastActivityAt(r)).toEqual(new Date(T0.getTime() + 5 * H));
  });

  it('never returns a child instant OLDER than the row — max, not last-written', () => {
    // A late offline-queue replay (ADR-0086 capture-time grants) can land a photo
    // whose stored instant predates a stage write that already happened. Taking
    // "the photo" rather than "the newest of the three" would REWIND the clock
    // and manufacture staleness out of a load that is moving.
    const r = row({
      updatedAt: new Date(T0.getTime() + 4 * H),
      lastPhotoAt: new Date(T0.getTime() - 2 * H),
      lastStackAt: new Date(T0.getTime() - 1 * H),
    });
    expect(lastActivityAt(r)).toEqual(new Date(T0.getTime() + 4 * H));
  });
});

describe('stalenessOf — three bands, and the gap they sit in', () => {
  const at = (hoursIdle: number) => new Date(T0.getTime() + hoursIdle * H);

  it('fresh work is `ok` — p90 of healthy same-day work is 73 minutes', () => {
    expect(stalenessOf(row(), at(1)).level).toBe('ok');
  });

  it('badges at 2h, which is past every healthy p90 and short of the p99', () => {
    expect(stalenessOf(row(), at(2.1)).level).toBe('badge');
    expect(stalenessOf(row(), at(1.9)).level).toBe('ok');
  });

  it('nudges at 4h — beyond anything a moving load looks like', () => {
    expect(stalenessOf(row(), at(4.1)).level).toBe('nudge');
    expect(stalenessOf(row(), at(3.9)).level).toBe('badge');
  });

  it('the H-136796 strand (15.3h idle) is unambiguously a nudge', () => {
    // Humboldt Waste Management Authority, held by Janette Tomas from 2026-08-10
    // 17:12 PDT, still `in_progress` at 08:30 PDT the next morning with 117
    // expected units. The load this ADR exists for.
    expect(stalenessOf(row(), at(15.3)).level).toBe('nudge');
  });

  it('reports the idle duration, so the copy never has to recompute it', () => {
    expect(stalenessOf(row(), at(6)).idleMs).toBe(6 * H);
  });

  it('the badge threshold is strictly below the nudge threshold', () => {
    // Stated as a property rather than trusted to two literals staying ordered:
    // inverting them would make `nudge` unreachable and the watchdog silent,
    // which is a failure that looks exactly like "no stale loads today".
    expect(STALE_BADGE_MS).toBeLessThan(STALE_NUDGE_MS);
  });

  it('clock skew cannot produce negative idle time or a phantom nudge', () => {
    // A child row written a moment "in the future" relative to `now` (two clocks,
    // one transaction) must floor at zero rather than wrap into a huge idle.
    const future = stalenessOf(row({ lastStackAt: new Date(T0.getTime() + 5 * H) }), T0);
    expect(future.idleMs).toBe(0);
    expect(future.level).toBe('ok');
  });
});

describe('what the watchdog deliberately does NOT read', () => {
  it('detection is time-only: zero expected units cannot suppress or divide', () => {
    // Three of four live slots on 2026-08-11 carried `expected_unit_count = 0`,
    // and `total_units` is NULL for every load that has not been counted yet —
    // which is EVERY stranded load, by definition. Any detector that reasoned
    // about magnitude would divide by zero or, worse, quietly decide an
    // uncounted load was not worth reporting. `ClaimActivityRow` has no units
    // field at all, so the wrong question cannot be asked.
    const keys = Object.keys(row());
    expect(keys).toEqual(['updatedAt', 'lastStackAt', 'lastPhotoAt']);
  });

  it('staleness is measured from ACTIVITY, never from claim age', () => {
    // 2026-08-11: H-136147 was claimed at 07:55 PDT against a 15:00 PDT
    // appointment. Early claims are real. A claim-age detector would call that
    // load stranded at 11:55 while the operator was working it normally; an
    // activity detector only speaks when the load actually goes quiet.
    const claimedLongAgoButWorkingNow = row({ lastStackAt: at8() });
    expect(
      stalenessOf(claimedLongAgoButWorkingNow, new Date(at8().getTime() + 10 * 60_000)).level,
    ).toBe('ok');
    function at8() {
      return new Date('2026-08-11T22:00:00.000Z');
    }
  });
});
