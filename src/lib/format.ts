// Display formatting helpers. Locale defaults to en-US for now;
// T-008 wires the user's stored locale through here.

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});

export function formatTime(d: Date): string {
  return TIME_FMT.format(d);
}

export function formatDate(d: Date): string {
  return DATE_FMT.format(d);
}

export function formatRelative(from: Date, now = new Date()): string {
  const ms = now.getTime() - from.getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return s <= 1 ? 'just now' : `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
