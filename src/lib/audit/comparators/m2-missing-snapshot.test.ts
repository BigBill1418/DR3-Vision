import { describe, expect, it } from 'vitest';
import { m2MissingSnapshot } from './m2-missing-snapshot';
import { toCheckConfig, DEFAULT_CHECK_CONFIGS } from '../config';
import type { AuditWindow, CheckConfig } from '../types';

const CONFIG: CheckConfig = toCheckConfig(
  DEFAULT_CHECK_CONFIGS.find((c) => c.checkCode === 'm2_missing_snapshot')!,
);
const WINDOW: AuditWindow = { siteId: 'woodland', startISO: '2026-06-01', endISO: '2026-07-01', asOfISO: '2026-07-01' };

describe('m2MissingSnapshot (35-day cadence)', () => {
  it('no finding when the last snapshot is within cadence', () => {
    // 2026-06-15 → asOf 2026-07-01 = 16 days.
    expect(m2MissingSnapshot(WINDOW, { lastPhysicalSnapshotISO: '2026-06-15' }, CONFIG)).toHaveLength(0);
  });

  it('no finding exactly at the cadence boundary (35 days)', () => {
    // 2026-05-27 → 2026-07-01 = 35 days exactly (not > 35).
    expect(m2MissingSnapshot(WINDOW, { lastPhysicalSnapshotISO: '2026-05-27' }, CONFIG)).toHaveLength(0);
  });

  it('flags when the cadence is exceeded (36 days)', () => {
    // 2026-05-26 → 2026-07-01 = 36 days.
    const f = m2MissingSnapshot(WINDOW, { lastPhysicalSnapshotISO: '2026-05-26' }, CONFIG);
    expect(f).toHaveLength(1);
    expect(f[0]!.fingerprint).toBe('m2_missing_snapshot|missing_counterpart|woodland');
    expect((f[0]!.actual as { daysSince: number }).daysSince).toBe(36);
  });

  it('flags when no physical snapshot exists at all', () => {
    const f = m2MissingSnapshot(WINDOW, { lastPhysicalSnapshotISO: null }, CONFIG);
    expect(f).toHaveLength(1);
    expect((f[0]!.actual as { lastPhysicalSnapshot: string | null }).lastPhysicalSnapshot).toBeNull();
  });

  it('uses window end as asOf on a historical run', () => {
    const w: AuditWindow = { siteId: 'woodland', startISO: '2026-06-01', endISO: '2026-07-01' };
    expect(m2MissingSnapshot(w, { lastPhysicalSnapshotISO: '2026-05-26' }, CONFIG)).toHaveLength(1);
  });
});
