// M1 — Missing daily close. A business day (site-calendar-aware via
// `site_holidays` + weekend logic) with inbound activity but no
// `processed_units_daily` row by EOD + grace (default 1 business day).
//
// Only BUSINESS days are candidates: a weekend/holiday with activity is not a
// required close. The finding is per-day (fingerprint keys `[siteId, dayISO]`),
// so each missing close is its own finding and the day auto-resolves when its
// close row is entered. A historical run (`asOfISO` undefined) treats every past
// missing close as overdue; a live run suppresses days still inside the grace.

import type { AuditWindow, CheckConfig, Finding } from '../types';
import { businessDayAddISO, isBusinessDayISO, makeFinder } from './helpers';

export interface M1DayRow {
  dateISO: string;
  /** Verified inbound loads or consumer drop-offs occurred this day. */
  hadInboundActivity: boolean;
  /** A `processed_units_daily` row exists for this day. */
  hasProcessedRow: boolean;
}

export interface M1Input {
  days: readonly M1DayRow[];
}

export function m1MissingClose(
  window: AuditWindow,
  input: M1Input,
  config: CheckConfig,
  holidays: Date[] = [],
): Finding[] {
  if (!config.enabled) return [];
  const finding = makeFinder('m1_missing_close', window, config);
  const grace = config.graceBusinessDays > 0 ? config.graceBusinessDays : 1;
  const out: Finding[] = [];

  for (const day of input.days) {
    if (!isBusinessDayISO(day.dateISO, holidays)) continue;
    if (!day.hadInboundActivity || day.hasProcessedRow) continue;

    const deadlineISO = businessDayAddISO(day.dateISO, grace, holidays);
    const overdue = window.asOfISO === undefined || window.asOfISO > deadlineISO;
    if (!overdue) continue;

    out.push(
      finding({
        kind: 'missing_counterpart',
        keys: [window.siteId, day.dateISO],
        legARef: day.dateISO,
        legBRef: null,
        expected: { processedCloseFor: day.dateISO },
        actual: { processedRow: null },
        detail: {
          note: 'inbound activity recorded but no daily close by the grace deadline',
          graceBusinessDays: grace,
          deadline: deadlineISO,
        },
      }),
    );
  }

  return out;
}
