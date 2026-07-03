import { describe, expect, it } from 'vitest';
import { c6InventoryContinuity } from './c6-inventory';
import { defaultCheckConfigMap } from '../config';
import type { AuditWindow, InventoryDayRow } from '../types';

const config = defaultCheckConfigMap().get('c6_inventory_continuity')!;
const window: AuditWindow = { siteId: 'site-1', startISO: '2026-06-01', endISO: '2026-06-30' };

function day(over: Partial<InventoryDayRow> = {}): InventoryDayRow {
  return {
    dateISO: '2026-06-05',
    recordedStart: 100,
    inbound: 50,
    stripped: 20,
    wholeUnitsSold: 5,
    landfilled: 5,
    recordedEnd: 120, // 100 + 50 − 20 − 5 − 5
    npRecordedStart: null,
    npInbound: 0,
    npSold: 0,
    npLandfilled: 0,
    npRecordedEnd: null,
    physicalSnapshot: null,
    ...over,
  };
}

describe('C6 inventory continuity', () => {
  it('a balanced day → no findings', () => {
    expect(c6InventoryContinuity(window, [day()], config)).toHaveLength(0);
  });

  it('continuity break: recorded End ≠ computed End', () => {
    const f = c6InventoryContinuity(window, [day({ recordedEnd: 999 })], config);
    expect(f).toHaveLength(1);
    expect(f[0]!.kind).toBe('value_mismatch');
    expect(f[0]!.expected).toEqual({ computedEnd: 120 });
  });

  it('roll break: a day start that does not carry from the prior day end (Friday→Monday / DAY6)', () => {
    const fri = day({ dateISO: '2026-06-05', recordedEnd: 120 });
    // DAY6: Monday hardcoded start (2863-style) instead of the prior 120.
    const mon = day({ dateISO: '2026-06-08', recordedStart: 2863, inbound: 0, stripped: 0, wholeUnitsSold: 0, landfilled: 0, recordedEnd: 2863 });
    const f = c6InventoryContinuity(window, [fri, mon], config);
    const rollBreaks = f.filter((x) => (x.detail as { note?: string })?.note?.includes('carry'));
    expect(rollBreaks).toHaveLength(1);
    expect(rollBreaks[0]!.expected).toEqual({ start: 120 });
    expect(rollBreaks[0]!.actual).toEqual({ start: 2863 });
  });

  it('non-program ledger continuity is checked separately', () => {
    const f = c6InventoryContinuity(
      window,
      [day({ npRecordedStart: 40, npInbound: 10, npSold: 2, npLandfilled: 0, npRecordedEnd: 999 })],
      config,
    );
    expect(f.some((x) => (x.detail as { ledger?: string })?.ledger === 'non_program')).toBe(true);
  });

  it('physical snapshot reconciliation delta', () => {
    const f = c6InventoryContinuity(window, [day({ physicalSnapshot: 130 })], config);
    const rec = f.find((x) => (x.detail as { note?: string })?.note?.includes('physical'));
    expect(rec).toBeDefined();
    expect(rec!.detail).toMatchObject({ delta: 10 });
  });
});
