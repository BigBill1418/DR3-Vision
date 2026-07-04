import { describe, expect, it } from 'vitest';
import { m1MissingClose, type M1DayRow } from './m1-missing-close';
import { toCheckConfig, DEFAULT_CHECK_CONFIGS } from '../config';
import type { AuditWindow, CheckConfig } from '../types';

const CONFIG: CheckConfig = toCheckConfig(
  DEFAULT_CHECK_CONFIGS.find((c) => c.checkCode === 'm1_missing_close')!,
);

// 2026-07-01 is a Wednesday. 2026-07-04 is a Saturday.
function win(asOfISO: string): AuditWindow {
  return { siteId: 'eugene', startISO: '2026-06-25', endISO: asOfISO, asOfISO };
}
const day = (dateISO: string, over: Partial<M1DayRow> = {}): M1DayRow => ({
  dateISO,
  hadInboundActivity: true,
  hasProcessedRow: false,
  ...over,
});

describe('m1MissingClose', () => {
  it('flags a business day with activity and no close, past the 1-business-day grace', () => {
    // Activity Wed 07-01; grace deadline Thu 07-02; asOf Fri 07-03 → overdue.
    const findings = m1MissingClose(win('2026-07-03'), { days: [day('2026-07-01')] }, CONFIG, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.checkCode).toBe('m1_missing_close');
    expect(findings[0]!.fingerprint).toBe('m1_missing_close|missing_counterpart|eugene|2026-07-01');
    expect((findings[0]!.detail as { deadline: string }).deadline).toBe('2026-07-02');
  });

  it('suppresses a day still inside the grace window', () => {
    // Activity Wed 07-01; asOf Thu 07-02 == deadline → not yet overdue.
    const findings = m1MissingClose(win('2026-07-02'), { days: [day('2026-07-01')] }, CONFIG, []);
    expect(findings).toHaveLength(0);
  });

  it('ignores weekend days entirely (Saturday activity is not a required close)', () => {
    const findings = m1MissingClose(win('2026-07-08'), { days: [day('2026-07-04')] }, CONFIG, []);
    expect(findings).toHaveLength(0);
  });

  it('ignores a site holiday and extends the grace across it', () => {
    // Thu 07-02 is a holiday. Activity Wed 07-01 → grace skips the holiday to Fri 07-03.
    const holidays = [new Date('2026-07-02T00:00:00.000Z')];
    // asOf Fri 07-03 == deadline (07-03) → not yet overdue.
    expect(m1MissingClose(win('2026-07-03'), { days: [day('2026-07-01')] }, CONFIG, holidays)).toHaveLength(0);
    // asOf Mon 07-06 → overdue.
    expect(m1MissingClose(win('2026-07-06'), { days: [day('2026-07-01')] }, CONFIG, holidays)).toHaveLength(1);
  });

  it('does not flag a day that has a close row or had no activity', () => {
    const days = [
      day('2026-06-29', { hasProcessedRow: true }),
      day('2026-06-30', { hadInboundActivity: false }),
    ];
    expect(m1MissingClose(win('2026-07-03'), { days }, CONFIG, [])).toHaveLength(0);
  });

  it('a historical run (asOf undefined) treats every past missing close as overdue', () => {
    const w: AuditWindow = { siteId: 'eugene', startISO: '2026-06-25', endISO: '2026-07-03' };
    expect(m1MissingClose(w, { days: [day('2026-07-01')] }, CONFIG, [])).toHaveLength(1);
  });
});
