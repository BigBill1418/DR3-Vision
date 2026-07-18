// ADR-0037 amendment (rollup §3.2 + §A.5) — inbound → inventory-pool routing.

import { describe, expect, it } from 'vitest';
import {
  routeInboundToInventoryPool,
  dropoffKindToChannel,
  loadToChannel,
  type InboundChannel,
} from './pool-routing';

describe('routeInboundToInventoryPool — §3.2 pool routing', () => {
  it('routes program + collection + all drop-offs + events to the PROGRAM pool', () => {
    const programChannels: InboundChannel[] = [
      'mrc_program',
      'collection',
      'incentive_dropoff',
      'unpaid_dropoff',
      'illegal_dropoff', // Rick: illegals treated the same as unpaid
      'event', // Kelsey §A.5: events feed the program pool for inventory
    ];
    for (const ch of programChannels) {
      expect(routeInboundToInventoryPool(ch)).toBe('program');
    }
  });

  it('routes only an explicitly non-program haul to the NON-PROGRAM pool', () => {
    expect(routeInboundToInventoryPool('non_program')).toBe('non_program');
  });
});

describe('channel mappers', () => {
  it('maps ConsumerDropoffKind onto the drop-off channels (illegal reuses the existing enum)', () => {
    expect(dropoffKindToChannel('incentive')).toBe('incentive_dropoff');
    expect(dropoffKindToChannel('unpaid')).toBe('unpaid_dropoff');
    expect(dropoffKindToChannel('illegal')).toBe('illegal_dropoff');
  });

  it('maps a load source type + non-program flag onto a channel', () => {
    expect(loadToChannel('event', false)).toBe('event');
    expect(loadToChannel('event', true)).toBe('event'); // event wins over the flag
    expect(loadToChannel('b2b_haul', true)).toBe('non_program');
    expect(loadToChannel('b2b_haul', false)).toBe('mrc_program');
    expect(loadToChannel('cip_consumer', false)).toBe('mrc_program');
  });
});
