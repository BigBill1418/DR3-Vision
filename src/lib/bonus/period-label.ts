// Canonical bi-weekly pay-period labels (ADR-0019.1 cadence; ADR-0031).
//
// One source of truth for "Period 13 · Jun 9–22, 2026" so the standings table,
// the per-employee current-period banner, AND the per-employee history table all
// render the SAME string. Replaces the pre-cadence calendar-month label
// ("June 2026") that produced DUPLICATE rows when two bi-weekly periods fall in
// one calendar month.
//
// Dates are the @db.Date window keys (UTC-midnight calendar-day anchors), so
// every format here is UTC to avoid a timezone shift.

/** "Jun 9–22, 2026" (same month) or "Dec 30, 2025 – Jan 12, 2026" (spanning). */
export function payPeriodRange(start: Date, end: Date): string {
  const md = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
  const year = end.getUTCFullYear();
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    return `${md(start)}–${end.getUTCDate()}, ${year}`;
  }
  return `${md(start)}, ${start.getUTCFullYear()} – ${md(end)}, ${year}`;
}

/** Full label: "Period 13 · Jun 9–22, 2026". */
export function periodLabel(p: {
  period_number: number;
  period_start: Date;
  period_end: Date;
}): string {
  return `Period ${p.period_number} · ${payPeriodRange(p.period_start, p.period_end)}`;
}

/**
 * Compact label for tight columns (e.g. the last-N trend bar list): "Period 13".
 * Unique within any run of ≤26 consecutive periods, since period_number is
 * 1..26 within a year and resets only at the year boundary.
 */
export function periodShortLabel(p: { period_number: number }): string {
  return `Period ${p.period_number}`;
}
