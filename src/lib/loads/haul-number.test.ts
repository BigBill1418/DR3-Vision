import { describe, it, expect } from 'vitest';
import { haulNumberOf } from './haul-number';

// ADR-0090 A — the floor cannot tell two of one site's trucks apart.
//
// JT, 2026-08-10: "The loads that were pending and need attention to be closed
// don't show the Haul number. It would be ideal to know the haul number, in case
// the reason we paused this haul is because we clicked the wrong one to begin
// with. Sometimes there's multiple loads coming from same site in 1 day."
//
// Every operator surface identifies a load by source + carrier + BOL. On
// 2026-08-10 all three of Janette's stuck loads were distinguishable ONLY by
// haul number, and two of them shared a source-and-day shape.

describe('haulNumberOf', () => {
  it('reads the haul number off the expected-load slot the operator tapped', () => {
    expect(
      haulNumberOf({
        external_mymrc_haul_id: null,
        expected_load: { external_mymrc_haul_id: 'H-136796' },
      }),
    ).toBe('H-136796');
  });

  it('falls back to the load’s own column when there is no expected-load slot', () => {
    // Bridged / aggregate rows (`inbound-bridge.ts`) carry the haul id on the
    // load itself and have no `expected_loads` parent. A walk-up drop-off has
    // neither and must not invent one.
    expect(haulNumberOf({ external_mymrc_haul_id: 'H-999999', expected_load: null })).toBe(
      'H-999999',
    );
  });

  it('prefers the expected-load slot when both are populated', () => {
    // The slot is what the operator tapped, so it is what they are trying to
    // recognise. The two agree in practice; when they disagree the tapped one
    // is the one that answers "did I click the wrong haul?".
    expect(
      haulNumberOf({
        external_mymrc_haul_id: 'H-000000',
        expected_load: { external_mymrc_haul_id: 'H-136796' },
      }),
    ).toBe('H-136796');
  });

  it('returns null when the load has no haul linkage at all', () => {
    // Rendering "H-null" or an empty mono span is worse than rendering nothing:
    // the surfaces below fall back to their existing BOL line.
    expect(haulNumberOf({ external_mymrc_haul_id: null, expected_load: null })).toBeNull();
  });

  it('treats a blank haul id as absent rather than as a value', () => {
    // `external_mymrc_haul_id` is nullable, not NOT-NULL-with-default, but the
    // MyMRC mapper has historically written '' for a missing portal field.
    expect(haulNumberOf({ external_mymrc_haul_id: '   ', expected_load: null })).toBeNull();
  });
});
