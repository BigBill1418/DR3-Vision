#!/usr/bin/env node
// Bonus period-close cron (ADR-0019.1 §3/§6, T-204). Replaces the monthly
// `scripts/bonus-month-close.mjs`.
//
// Cadence (ADR-0019.1 §3): the bi-weekly close fires Mon 17:30 PT — but the
// schedule is "daily 17:30 PT", not "every other Monday", because cron cannot
// express "every other Monday" cleanly and the underlying decision is keyed off
// the SEEDED `bonus_pay_periods.period_end = appToday()` (Pacific) anyway. On
// any day that is NOT a period-end Monday, nothing matches `state = 'draft' AND
// period_end = today`, so the fire is a clean no-op. This is the daily-tick +
// Pacific-aware date check that ADR-0019.1 §6 / "Alternatives considered"
// explicitly prefers over a real every-other-Monday cron (DST-robust).
//
// Shape: a LONG-RUNNING daemon (mirrors `scripts/mymrc-cron.mjs`), single
// process / single restart policy (`unless-stopped` in compose). It sleeps
// until the next 17:30 America/Los_Angeles instant — recomputed each cycle from
// the Pacific wall clock so it stays correct across the Mar/Nov DST shifts — and
// on each fire drives the close. If the loop ever throws past the per-fire
// try/catch, the container restart brings us back to the same shape (compute
// next 17:30 PT → sleep → fire).
//
// Why POST the internal Next route rather than import the state machine here:
// the period-close ORCHESTRATION is the transition (`closePayPeriodsDueForSignature`)
// PLUS the signature-request email (`notifyPendingSigner`) per newly-closed
// period, and that orchestration lives behind `/api/internal/bonus/close-months`
// (it imports the bonus tx layer + the email path; it is unit-tested in
// `close-months.route.test.ts`). The route already passes `appToday()` (Pacific)
// as `now`, so the close decision is Pacific-aware via `@/lib/time` — not a raw
// `Date`. Re-implementing that orchestration in plain `.mjs` would duplicate
// untested logic and re-create the state machine outside TypeScript, which
// ADR-0019 deliberately avoids. The .mjs stays a thin Pacific-aware scheduler.
//
// Idempotent: the route's `closePayPeriodsDueForSignature` only matches
// `state = 'draft'`, so a second fire on the same day (or a container restart
// that re-fires) does not double-transition — once a period is in
// `pending_signatures` it no longer matches.

const BASE = process.env.INTERNAL_BASE_URL ?? 'http://127.0.0.1:3000';
const TOKEN = process.env.INTERNAL_CRON_TOKEN ?? '';

// Close fire time, Pacific wall clock. ADR-0019.1 §3: Mon 17:30 PT.
const FIRE_HOUR_PT = 17;
const FIRE_MINUTE_PT = 30;

// Parts formatter to read the Pacific wall clock off a UTC instant — same
// technique as `src/lib/time.ts` (`PACIFIC_PARTS_FMT` / `pacificOffsetMs`), so
// "what time is it in Pacific" is DST-correct without hardcoding the -7/-8
// offset. We deliberately re-derive it here (rather than import `@/lib/time`)
// because this wrapper stays JavaScript and runs from the runner stage without
// a TS compile step — exactly like `scripts/mymrc-cron.mjs`.
const PACIFIC_TZ = 'America/Los_Angeles';
const PACIFIC_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

let stopping = false;

function logTs(message) {
  console.log(`[bonus-period-close ${new Date().toISOString()}] ${message}`);
}

/** The Pacific wall-clock parts (numbers) for a UTC instant. */
function pacificParts(at) {
  const parts = PACIFIC_PARTS_FMT.formatToParts(at);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Signed offset (ms) such that `utc = pacificWallClockAsUTC - offset`. */
function pacificOffsetMs(at) {
  const p = pacificParts(at);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - at.getTime();
}

/**
 * The next UTC instant at which the Pacific wall clock reads
 * `FIRE_HOUR_PT:FIRE_MINUTE_PT:00`, strictly after `from`. DST-correct: it
 * resolves the target Pacific wall time on the candidate Pacific calendar day,
 * converting to UTC via the offset in effect that day. If today's 17:30 PT has
 * already passed, it rolls to tomorrow's 17:30 PT.
 */
export function msUntilNext1730Pacific(from = new Date()) {
  for (let addDays = 0; addDays <= 2; addDays++) {
    const p = pacificParts(new Date(from.getTime() + addDays * 86_400_000));
    // Pacific wall clock reinterpreted as UTC for the target time on day p.
    const targetAsUTC = Date.UTC(p.year, p.month - 1, p.day, FIRE_HOUR_PT, FIRE_MINUTE_PT, 0);
    // Convert that Pacific wall time to a true UTC instant using the offset in
    // effect AT that instant (re-probe so a DST jump on the target day is right).
    const approx = new Date(targetAsUTC - pacificOffsetMs(new Date(targetAsUTC)));
    const fireUtc = new Date(targetAsUTC - pacificOffsetMs(approx));
    const delta = fireUtc.getTime() - from.getTime();
    if (delta > 1_000) return delta;
  }
  // Defensive fallback (should never hit): 24h.
  return 24 * 60 * 60 * 1000;
}

/**
 * Drive one close: POST the internal, loopback-guarded close route. The route
 * transitions every `draft` period whose `period_end == appToday()` (Pacific)
 * to `pending_signatures` via the audited state machine and fires the
 * signature-request email per newly-closed period. Resolves on success;
 * throws on transport / non-2xx so the caller's try/catch logs it.
 */
async function runCloseOnce() {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${BASE}/api/internal/bonus/close-months`, {
    method: 'POST',
    headers,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return text;
}

function scheduleNext() {
  if (stopping) return;
  const delay = msUntilNext1730Pacific();
  const fireAt = new Date(Date.now() + delay).toISOString();
  logTs(`next close fire at ${fireAt} (in ${(delay / 1000 / 60).toFixed(1)}min) — 17:30 PT`);
  setTimeout(() => {
    runCloseOnce()
      .then((text) => logTs(`close run complete: ${text}`))
      .catch((err) => logTs(`close run failed (non-fatal, retry next tick): ${err?.message ?? err}`))
      .finally(scheduleNext);
  }, delay); // NOT .unref() — this timer must keep the daemon alive
}

function setupShutdown() {
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    logTs(`received ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Only start the daemon when run as the entrypoint — keeps the module
// importable (for a smoke/helper test) without spawning timers.
const isEntrypoint =
  process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isEntrypoint) {
  setupShutdown();
  logTs('cron host started — daily close anchored to 17:30 America/Los_Angeles');
  scheduleNext();
}
