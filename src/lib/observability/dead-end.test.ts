// ADR-0100 — the instrument must not be able to break what it measures.
//
// ADR-0019.5 is the reason these tests exist in this shape: its counters reported
// delivery ATTEMPTS as successes while the pages were being dropped, so nobody
// noticed a week of missing escalations. An instrument that lies, or that takes
// the render down with it, is worse than no instrument.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inc = vi.fn();
const info = vi.fn();

vi.mock('@/lib/observability/metrics', () => ({
  deadEndRenders: {
    inc: (...a: unknown[]) => inc('dead_end', ...a),
  },
  writeRefusals: {
    inc: (...a: unknown[]) => inc('refusal', ...a),
  },
}));
vi.mock('@/lib/observability/logger', () => ({
  log: { info: (...a: unknown[]) => info(...a) },
}));

import { recordDeadEnd, recordWriteRefusal } from './dead-end';

const EVENT = {
  surface: 'hauls',
  state: 'view_only',
  objectId: 'H-136980',
  siteCode: 'woodland',
  userId: 'op-1',
  role: 'operator',
  locale: 'es',
} as const;

beforeEach(() => {
  inc.mockReset();
  info.mockReset();
});

afterEach(() => vi.restoreAllMocks());

describe('recordDeadEnd', () => {
  it('increments the counter with a BOUNDED label set', () => {
    recordDeadEnd({ ...EVENT });
    expect(inc).toHaveBeenCalledWith('dead_end', {
      surface: 'hauls',
      state: 'view_only',
      site: 'woodland',
    });
    // The object id is deliberately NOT a Prometheus label. `H-136980` is
    // unbounded in practice, and a per-haul label is how a counter becomes a
    // cardinality incident. It rides the Loki line instead, where it is free.
    const labels = inc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(labels).sort()).toEqual(['site', 'state', 'surface']);
  });

  it('logs a structured line carrying the identity the label set cannot', () => {
    recordDeadEnd({ ...EVENT });
    const [fields, msg] = info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields['evt']).toBe('floor.dead_end');
    expect(fields['object_id']).toBe('H-136980');
    expect(fields['user_id']).toBe('op-1');
    expect(fields['role']).toBe('operator');
    expect(fields['locale']).toBe('es');
    // Greppable without knowing the label schema.
    expect(msg).toContain('hauls/view_only');
  });

  it('a missing object id is an explicit null, never the string "undefined"', () => {
    recordDeadEnd({ ...EVENT, objectId: undefined });
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    expect(fields['object_id']).toBeNull();
  });

  it('A METRICS FAILURE DOES NOT COST THE LOG LINE', () => {
    // The two sinks are independent on purpose: Loki is the higher-fidelity one,
    // and a prom-client registry error must not silently take it with it.
    inc.mockImplementation(() => {
      throw new Error('registry exploded');
    });
    expect(() => recordDeadEnd({ ...EVENT })).not.toThrow();
    expect(info, 'the log line was lost with the counter').toHaveBeenCalledTimes(1);
  });

  it('A LOGGER FAILURE DOES NOT THROW INTO THE RENDER', () => {
    info.mockImplementation(() => {
      throw new Error('pino exploded');
    });
    // The whole contract. A telemetry call that can fail the render it is
    // measuring is a strictly worse defect than the one being measured.
    expect(() => recordDeadEnd({ ...EVENT })).not.toThrow();
  });
});

describe('recordWriteRefusal', () => {
  const REFUSAL = {
    surface: 'count',
    refusal: 'wrong_day',
    siteCode: 'eugene',
    userId: 'op-2',
    role: 'operator',
    locale: 'ur',
  } as const;

  it('uses a SEPARATE counter from dead-end renders', () => {
    recordWriteRefusal({ ...REFUSAL });
    expect(inc).toHaveBeenCalledWith('refusal', {
      surface: 'count',
      refusal: 'wrong_day',
      site: 'eugene',
    });
  });

  it('is a distinct event type in the log, not a dead-end render', () => {
    // They answer different questions — "what are people stuck looking at" vs
    // "what are people being stopped from doing". One counter for both would make
    // neither readable.
    recordWriteRefusal({ ...REFUSAL });
    const [fields] = info.mock.calls[0] as [Record<string, unknown>];
    expect(fields['evt']).toBe('floor.write_refusal');
    expect(fields['refusal']).toBe('wrong_day');
    expect(fields['state']).toBeUndefined();
  });

  it('survives both sinks failing', () => {
    inc.mockImplementation(() => {
      throw new Error('boom');
    });
    info.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => recordWriteRefusal({ ...REFUSAL })).not.toThrow();
  });
});
