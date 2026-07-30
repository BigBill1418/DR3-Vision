// ADR-0049 D2 — business-hours predicate: 6 AM – 8 PM America/Los_Angeles, Mon-Fri.
//
// DST-safe by construction: it reads the wall-clock hour + weekday in the Pacific
// zone via Intl (never a fixed UTC offset), so the Mar/Nov DST shifts are handled
// automatically. The daemon schedules ticks; the ROUTE enforces this predicate so a
// stray off-hours POST (a manual curl, a restart-driven re-fire) cannot poll the
// live drive outside the window (D2: "Outside business hours: no polling").

const WINDOW_OPEN_HOUR = 6; // 06:00 PT inclusive
const WINDOW_CLOSE_HOUR = 20; // 20:00 PT exclusive (8 PM)

const PT_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
});

interface PacificClock {
  /** 0 = Sunday … 6 = Saturday (Pacific wall clock). */
  weekday: number;
  /** 0–23 Pacific wall-clock hour. */
  hour: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function pacificClock(at: Date): PacificClock {
  const parts = PT_PARTS.formatToParts(at);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hourRaw = parts.find((p) => p.type === 'hour')?.value ?? '00';
  // Intl can emit '24' for midnight under hour12:false in some engines — normalize.
  const hour = Number(hourRaw) % 24;
  return { weekday: WEEKDAY_INDEX[wd] ?? 0, hour };
}

/** True when `at` is within the Mon-Fri 06:00–20:00 Pacific polling window (D2). */
export function isBusinessHours(at: Date): boolean {
  const { weekday, hour } = pacificClock(at);
  if (weekday < 1 || weekday > 5) return false; // Mon-Fri only
  return hour >= WINDOW_OPEN_HOUR && hour < WINDOW_CLOSE_HOUR;
}
