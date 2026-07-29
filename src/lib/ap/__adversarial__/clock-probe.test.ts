// ADVERSARIAL — scratch probe of the weekday clock across DST + pathological input.
import { describe, expect, it } from 'vitest';
import { businessHoursBetween, isPacificWeekend } from '../business-clock';

const NONE = new Set<string>();
const h = (from: string, to: string) =>
  businessHoursBetween(new Date(from), new Date(to), NONE);

describe('probe', () => {
  it('prints', () => {
    const rows: Record<string, unknown> = {};
    // 2026-03-08 spring forward (Sun, 23h). Fri 2026-03-06 16:00 PST = 2026-03-07T00:00Z
    rows['springFwd Fri16:00PST -> Mon16:00PDT'] = h('2026-03-07T00:00:00Z', '2026-03-09T23:00:00Z');
    // 2026-11-01 fall back (Sun, 25h). Fri 2026-10-30 16:00 PDT = 2026-10-30T23:00Z
    rows['fallBack Fri16:00PDT -> Mon16:00PST'] = h('2026-10-30T23:00:00Z', '2026-11-03T00:00:00Z');
    // A plain mid-week 24h.
    rows['Tue16:00 -> Wed16:00 (Jul)'] = h('2026-07-21T23:00:00Z', '2026-07-22T23:00:00Z');
    // Spring-forward week: Fri 16:00 -> Sat 16:00 (no accrual after Sat 00:00)
    rows['Fri16:00 -> Sat16:00'] = h('2026-03-07T00:00:00Z', '2026-03-08T00:00:00Z');
    // maxDays exhaustion: 3 years back.
    rows['3y ago -> now (cap 400)'] = h('2023-07-29T00:00:00Z', '2026-07-29T00:00:00Z');
    // first_approved_at in the FUTURE.
    rows['future first_approved_at'] = h('2026-08-29T00:00:00Z', '2026-07-29T00:00:00Z');
    // Weekday classification straddling the UTC/Pacific seam: Fri 2026-07-24
    // 6pm PT is Sat 01:00 UTC — must still read as a Friday (business) segment.
    rows['Fri18:00PT (=Sat01:00Z) -> Fri23:59PT'] = h(
      '2026-07-25T01:00:00Z',
      '2026-07-25T06:59:00Z',
    );
    rows['isPacificWeekend(Sat01:00Z = Fri18:00PT)'] = isPacificWeekend(
      new Date('2026-07-25T01:00:00Z'),
    );
    // Exactly the DST fall-back hour, on a Sunday (never business) — sanity.
    rows['fallBack Sun00:00 -> Mon00:00 (25h span, weekend)'] = h(
      '2026-11-01T07:00:00Z',
      '2026-11-02T08:00:00Z',
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 2));
    expect(true).toBe(true);
  });
});
