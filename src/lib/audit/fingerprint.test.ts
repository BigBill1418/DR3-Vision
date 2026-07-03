import { describe, expect, it } from 'vitest';
import { makeFingerprint, normalizeKey } from './fingerprint';
import { c1Inbound } from './comparators/c1-inbound';
import { defaultCheckConfigMap } from './config';
import type { AuditWindow, InboundLegRow } from './types';

describe('makeFingerprint', () => {
  it('is deterministic for the same check + kind + keys', () => {
    const a = makeFingerprint('c1_inbound', 'value_mismatch', ['H-1', 'units']);
    const b = makeFingerprint('c1_inbound', 'value_mismatch', ['H-1', 'units']);
    expect(a).toBe(b);
  });

  it('normalizes case / whitespace / null so trivial drift never duplicates', () => {
    expect(makeFingerprint('c1_inbound', 'missing_counterpart', ['  H-1  '])).toBe(
      makeFingerprint('c1_inbound', 'missing_counterpart', ['h-1']),
    );
    expect(normalizeKey(null)).toBe('∅');
    expect(normalizeKey('')).toBe('∅');
  });

  it('differs on kind, keys, and check', () => {
    const base = makeFingerprint('c1_inbound', 'value_mismatch', ['H-1']);
    expect(base).not.toBe(makeFingerprint('c1_inbound', 'date_mismatch', ['H-1']));
    expect(base).not.toBe(makeFingerprint('c1_inbound', 'value_mismatch', ['H-2']));
    expect(base).not.toBe(makeFingerprint('c2_processed', 'value_mismatch', ['H-1']));
  });

  it('a comparator emits the SAME fingerprint for the same discrepancy across runs (dedupe basis)', () => {
    const config = defaultCheckConfigMap().get('c1_inbound')!;
    const window: AuditWindow = { siteId: 's', startISO: '2026-06-01', endISO: '2026-06-30' };
    const row: InboundLegRow = {
      id: 'L1',
      retracId: 'RT-1',
      externalHaulId: 'H-1',
      businessDateISO: '2026-06-05',
      totalUnits: 105,
      programUnits: null,
      nonProgramUnits: null,
      slipNumber: null,
      transportCharged: false,
      source: 'manual',
      sourceSiteName: null,
      verifiedAtISO: null,
      mymrcSubmittedAtISO: null,
    };
    const run1 = c1Inbound(window, [row], [], config);
    // A later run over a DIFFERENT (wider) window — fingerprint must not change,
    // because C1 keys on the record identity, not the window.
    const run2 = c1Inbound({ ...window, startISO: '2026-05-01' }, [row], [], config);
    expect(run1[0]!.fingerprint).toBe(run2[0]!.fingerprint);
  });
});
